import type http from 'node:http';
import {listMcpServers, setMcpServerEnabled} from '../mcp.js';
import type {AgentManager, AgentProfile} from '../agents.js';
import type {MetadataStore} from '../metadata-store.js';
import type {AgentTemplateStore} from '../agent-templates.js';
import type {Workspace, WorkspaceStore} from '../workspaces.js';
import type {VoiceManager} from '../voice.js';
import type {SottoSttService} from '../sotto-stt.js';
import type {SessionNamer} from '../session-namer.js';
import {json} from './utils.js';

export type AgentRouteContext = {
  agents: AgentManager;
  metadata: MetadataStore;
  templates: AgentTemplateStore;
  workspaces: WorkspaceStore;
  voice?: VoiceManager;
  sottoStt: SottoSttService;
  sessionNamer?: SessionNamer;
  ensureSessionIndex(workspace: Workspace, cwd: string, force?: boolean): Promise<void>;
  indexAgentSession(agentId: string): Promise<void>;
  body(): Promise<any>;
  binaryBody(): Promise<Buffer>;
};

/** Handles `/api/v1/agents/**`. Returns undefined when the request is not an Agent route. */
export async function handleAgentRoutes(
  ctx: AgentRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL,
  parts: string[]
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (req.method === 'GET' && u.pathname === '/api/v1/agents/models') {
    const workspaceId = u.searchParams.get('workspaceId') ?? '',
      relativeCwd = u.searchParams.get('relativeCwd') ?? '.';
    return send(200, {data: await ctx.agents.capabilityPreview(workspaceId, relativeCwd)});
  }
  // The list carries which template an Agent uses but not its text; GET /agents/:id/system-prompt has the full prompt.
  if (req.method === 'GET' && u.pathname === '/api/v1/agents')
    return send(200, {
      data: ctx.agents
        .list()
        .map(({template, ...record}) =>
          template
            ? {...record, template: {id: template.id, name: template.name, mode: template.mode}}
            : record
        )
    });
  if (req.method === 'POST' && u.pathname === '/api/v1/agents') {
    const b = await ctx.body(),
      profile: AgentProfile = b.profile === undefined ? 'default' : b.profile;
    if (profile !== 'default' && profile !== 'collab')
      throw Object.assign(new Error('profile must be default or collab'), {code: 'INVALID_REQUEST'});
    let sessionFile: string | undefined;
    if (b.sessionFile) {
      const workspace = ctx.workspaces.get(b.workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
      const cwd = await ctx.workspaces.resolve(workspace, b.relativeCwd ?? '.');
      await ctx.ensureSessionIndex(workspace, cwd);
      if (!ctx.metadata.hasSession(cwd, b.sessionFile))
        throw Object.assign(new Error('Session is not valid for cwd'), {code: 'SESSION_NOT_FOUND'});
      sessionFile = b.sessionFile;
    }
    if (b.templateId !== undefined && b.templateId !== null && typeof b.templateId !== 'string')
      throw Object.assign(new Error('templateId must be a string'), {code: 'INVALID_REQUEST'});
    // The template is copied now; later edits to the template file do not affect this Agent.
    const template = b.templateId ? ctx.templates.snapshot(b.templateId) : undefined;
    const agent = await ctx.agents.create(
      b.workspaceId,
      b.relativeCwd ?? '.',
      sessionFile,
      profile,
      template
    );
    try {
      if (b.model !== undefined) {
        if (!b.model || typeof b.model.provider !== 'string' || typeof b.model.modelId !== 'string')
          throw Object.assign(new Error('model.provider and model.modelId are required'), {
            code: 'INVALID_REQUEST'
          });
        await ctx.agents.setModel(agent.agentId, b.model.provider, b.model.modelId);
      }
      if (b.sessionName !== undefined) {
        if (typeof b.sessionName !== 'string')
          throw Object.assign(new Error('sessionName must be a string'), {code: 'INVALID_REQUEST'});
        await ctx.agents.setSessionName(agent.agentId, b.sessionName);
      }
      const configured = ctx.agents.get(agent.agentId).record;
      ctx.metadata.saveAgent(configured);
      return send(201, {data: {...configured}});
    } catch (error) {
      await ctx.agents.remove(agent.agentId).catch(() => {});
      throw error;
    }
  }
  if (parts[2] === 'agents') {
    const id = parts[3];
    if (req.method === 'GET' && parts.length === 4) return send(200, {data: ctx.agents.get(id).record});
    if (req.method === 'DELETE' && parts.length === 4) {
      await ctx.agents.dispose(id);
      ctx.metadata.saveAgent(ctx.agents.get(id).record);
      return send(200, {data: {stopped: true}});
    }
    if (req.method === 'POST' && parts[4] === 'archive') {
      const record = await ctx.agents.archive(id);
      ctx.metadata.archiveAgent(record);
      return send(200, {data: {archived: true}});
    }
    if (req.method === 'GET' && parts[4] === 'state') return send(200, {data: await ctx.agents.state(id)});
    if (req.method === 'GET' && parts[4] === 'timeline' && parts.length === 5)
      return send(200, {
        data: await ctx.agents.timeline(
          id,
          Number(u.searchParams.get('limit') ?? 50),
          u.searchParams.get('before') ?? undefined
        )
      });
    // /agents/:id/sessions/:sessionId/items/:itemId — items never change, and the session is part of the
    // URL so a cached body is never served for another one: let the browser keep it for good.
    if (req.method === 'GET' && parts[4] === 'sessions' && parts[6] === 'items' && parts.length === 8) {
      const detail = await ctx.agents.item(id, decodeURIComponent(parts[5]), decodeURIComponent(parts[7]));
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      return send(200, {data: detail});
    }
    if (req.method === 'GET' && parts[4] === 'system-prompt')
      return send(200, {data: await ctx.agents.systemPrompt(id)});
    if (req.method === 'POST' && parts[4] === 'system-prompt') {
      const b = await ctx.body();
      if (b.templateId !== undefined && typeof b.templateId !== 'string')
        throw Object.assign(new Error('templateId must be a string'), {code: 'INVALID_REQUEST'});
      const template = b.templateId ? ctx.templates.snapshot(b.templateId) : undefined;
      const record = await ctx.agents.setTemplate(id, template, candidate =>
        ctx.metadata.commitAgentTemplate(candidate)
      );
      return send(200, {data: {template: record.template ?? null}});
    }
    if (req.method === 'GET' && parts[4] === 'capabilities')
      return send(200, {data: await ctx.agents.capabilities(id)});
    if (req.method === 'GET' && parts[4] === 'session')
      return send(200, {
        data:
          u.searchParams.get('summary') === 'true'
            ? await ctx.agents.sessionInfo(id)
            : await ctx.agents.session(id)
      });
    if (req.method === 'POST' && parts[4] === 'compact') {
      const b = await ctx.body();
      return send(200, {data: await ctx.agents.compact(id, b.instructions)});
    }
    if (req.method === 'POST' && parts[4] === 'model') {
      const b = await ctx.body();
      await ctx.agents.setModel(id, b.provider, b.modelId);
      return send(200, {data: await ctx.agents.capabilities(id)});
    }
    if (req.method === 'POST' && parts[4] === 'thinking') {
      const b = await ctx.body();
      await ctx.agents.setThinkingLevel(id, b.level);
      return send(200, {data: await ctx.agents.capabilities(id)});
    }
    if (req.method === 'POST' && parts[4] === 'session-name') {
      const b = await ctx.body();
      await ctx.agents.setSessionName(id, b.name);
      const summary = await ctx.agents.sessionInfo(id),
        record = ctx.agents.get(id).record;
      ctx.metadata.saveAgent(record);
      ctx.metadata.upsertSessionFromAgent(record, summary);
      return send(200, {data: summary});
    }
    if (req.method === 'POST' && parts[4] === 'navigate') {
      const b = await ctx.body();
      return send(200, {data: await ctx.agents.navigate(id, b.entryId)});
    }
    if (req.method === 'POST' && parts[4] === 'fork') {
      const b = await ctx.body();
      const agent = await ctx.agents.fork(id, b.entryId);
      ctx.metadata.saveAgent(agent.agent);
      return send(201, {data: agent});
    }
    if (req.method === 'GET' && parts[4] === 'commands')
      return send(200, {data: await ctx.agents.listCommands(id)});
    if (req.method === 'POST' && parts[4] === 'bash') {
      const b = await ctx.body();
      if (typeof b.command !== 'string')
        throw Object.assign(new Error('command must be a string'), {code: 'INVALID_REQUEST'});
      const command = b.command.trim();
      if (!command) throw Object.assign(new Error('command is required'), {code: 'INVALID_REQUEST'});
      if (command.length > 8000)
        throw Object.assign(new Error('command is too long'), {code: 'INVALID_REQUEST'});
      const result = await ctx.agents.runBash(id, command, b.excludeFromContext === true);
      ctx.metadata.scheduleAgent(ctx.agents.get(id).record);
      return send(200, {data: result});
    }
    if (req.method === 'POST' && parts[4] === 'bash-abort') {
      await ctx.agents.abortBash(id);
      return send(200, {data: {aborted: true}});
    }
    if (parts[4] === 'queue') {
      if (req.method === 'GET') return send(200, {data: await ctx.agents.queue(id)});
      if (req.method === 'DELETE') return send(200, {data: await ctx.agents.clearQueue(id)});
      if (req.method === 'POST' && parts[5] === 'move') {
        const {from, index, expected} = await ctx.body();
        if (
          (from !== 'steering' && from !== 'followUp') ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          typeof expected !== 'string'
        )
          throw Object.assign(new Error('from, index and expected are required'), {code: 'INVALID_REQUEST'});
        return send(200, {data: await ctx.agents.moveQueue(id, from, index, expected)});
      }
    }
    if (parts[4] === 'mcp') {
      const cwd = ctx.agents.get(id).record.cwd;
      if (req.method === 'GET') return send(200, {data: listMcpServers(cwd)});
      if (req.method === 'POST') {
        const b = await ctx.body();
        if (typeof b.name !== 'string' || typeof b.enabled !== 'boolean')
          throw Object.assign(new Error('name and enabled are required'), {code: 'INVALID_MCP_REQUEST'});
        return send(200, {data: setMcpServerEnabled(cwd, b.name, b.enabled)});
      }
    }
    if (req.method === 'POST' && parts[4] === 'extension-response') {
      const b = await ctx.body();
      await ctx.agents.extensionResponse(id, b.requestId, b.value);
      return send(200, {data: {success: true}});
    }
    if (req.method === 'POST' && parts[4] === 'transcribe') {
      ctx.agents.get(id);
      const mime = String(req.headers['content-type'] ?? 'audio/webm').split(';')[0];
      if (ctx.sottoStt.getSettings().enabled) {
        if (mime !== 'application/octet-stream')
          throw Object.assign(new Error('Sotto requires 16 kHz float32 PCM'), {code: 'INVALID_REQUEST'});
        const audio = await ctx.binaryBody();
        return send(200, {data: await ctx.sottoStt.transcribe(audio)});
      }
      if (!ctx.voice) throw Object.assign(new Error('Voice service is disabled'), {code: 'VOICE_DISABLED'});
      const audio = await ctx.binaryBody(),
        filename = String(req.headers['x-audio-filename'] ?? 'recording.webm');
      return send(200, {data: await ctx.voice.transcribe(audio, mime, filename)});
    }
    if (req.method === 'POST' && ['prompt', 'steer', 'follow-up', 'abort'].includes(parts[4])) {
      const b = await ctx.body();
      if (parts[4] !== 'abort') {
        ctx.voice?.recordUserPrompt(id, String(b.message ?? ''));
        ctx.sessionNamer?.recordUserPrompt(id, String(b.message ?? ''));
      }
      const disposition = await ctx.agents.command(id, parts[4] as any, b.message ?? '');
      const record = ctx.agents.get(id).record;
      ctx.metadata.scheduleAgent(record);
      if (parts[4] === 'prompt') void ctx.indexAgentSession(id);
      return send(200, {data: {success: true, disposition}});
    }
  }
  return false;
}
