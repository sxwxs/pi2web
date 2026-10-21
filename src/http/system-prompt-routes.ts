import type http from 'node:http';
import type {AgentManager} from '../agents.js';
import {
  readPiPromptFiles,
  writePiPromptFile,
  type AgentTemplateStore,
  type PiPromptFileKind
} from '../agent-templates.js';
import {json} from './utils.js';

export type SystemPromptRouteContext = {
  agents: AgentManager;
  templates: AgentTemplateStore;
  body(): Promise<any>;
};

const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_REQUEST'});

/**
 * `/api/v1/system-prompt` exposes Pi's own global prompt files (`~/.pi/agent/SYSTEM.md`, `APPEND_SYSTEM.md`) and a
 * preview of the effective prompt; `/api/v1/agent-templates` manages the shareable template files in the data dir.
 */
export async function handleSystemPromptRoutes(
  ctx: SystemPromptRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL,
  parts: string[]
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (u.pathname === '/api/v1/system-prompt') {
    if (req.method === 'GET') return send(200, {data: readPiPromptFiles()});
    if (req.method === 'PUT') {
      const b = await ctx.body();
      if (b.kind !== 'system' && b.kind !== 'append') throw invalid('kind must be system or append');
      if (typeof b.content !== 'string') throw invalid('content must be a string');
      writePiPromptFile(b.kind as PiPromptFileKind, b.content);
      return send(200, {data: readPiPromptFiles()});
    }
  }
  if (req.method === 'GET' && u.pathname === '/api/v1/system-prompt/preview') {
    const workspaceId = u.searchParams.get('workspaceId') ?? '',
      relativeCwd = u.searchParams.get('relativeCwd') ?? '.',
      templateId = u.searchParams.get('templateId') || '',
      piDefaultPrompt = u.searchParams.get('source') === 'pi-default';
    const template = templateId && !piDefaultPrompt ? ctx.templates.snapshot(templateId) : undefined;
    return send(200, {
      data: {
        ...(await ctx.agents.systemPromptPreview(workspaceId, relativeCwd, {template, piDefaultPrompt})),
        template: template ?? null
      }
    });
  }
  if (parts[2] === 'agent-templates') {
    if (parts.length === 3 && req.method === 'GET')
      return send(200, {data: {dir: ctx.templates.dir, ...ctx.templates.list()}});
    if (parts.length === 4) {
      const id = decodeURIComponent(parts[3]);
      if (req.method === 'GET') return send(200, {data: ctx.templates.get(id)});
      if (req.method === 'PUT') return send(200, {data: ctx.templates.save(id, await ctx.body())});
      if (req.method === 'DELETE') {
        ctx.templates.remove(id);
        return send(200, {data: {deleted: true}});
      }
    }
  }
  return false;
}
