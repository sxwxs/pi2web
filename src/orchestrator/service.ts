import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import type {AgentManager, AgentRecord} from '../agents.js';
import type {AgentTemplateStore} from '../agent-templates.js';
import type {MetadataStore} from '../metadata-store.js';
import type {Workspace, WorkspaceStore} from '../workspaces.js';
import type {FollowUpAdvisor} from '../follow-up-advisor.js';
import type {ScheduleManager, ScheduleTaskInput, ScheduledTask} from '../schedules.js';
import {buildTimeline, contentText, itemBody, pageTimeline, type TimelineEntry} from '../timeline.js';
import {clipSummaryField} from '../voice.js';
import type {OrchestratorHub, WatchView} from './hub.js';

export type OrchestratorServiceDeps = {
  agents: AgentManager;
  workspaces: WorkspaceStore;
  metadata: MetadataStore;
  templates: AgentTemplateStore;
  orchestratorHub: OrchestratorHub;
  schedules: ScheduleManager;
  orchestratorDir: string;
  followUp?: FollowUpAdvisor;
  ensureSessionIndex: (workspace: Workspace, cwd: string, force?: boolean) => Promise<void>;
  indexAgentSession: (agentId: string) => Promise<void>;
  recordUserPrompt?: (agentId: string, text: string) => void;
};

export type CreateWorkerInput = {
  workspaceId?: string;
  relativeCwd?: string;
  /** Absolute directory inside a configured Workspace; automatically matches the deepest Workspace. */
  cwd?: string;
  sessionFile?: string;
  model?: {provider: string; modelId: string};
  thinkingLevel?: string;
  templateId?: string;
  sessionName?: string;
  initialPrompt?: string;
  notifyOnComplete?: boolean;
  notifyGroup?: string;
  notifyLabel?: string;
};

export type SendWorkerInput = {
  agentId: string;
  message: string;
  mode?: 'prompt' | 'follow-up' | 'steer';
  notifyOnComplete?: boolean;
  notifyGroup?: string;
  notifyLabel?: string;
};

export type ControlWorkerAction =
  | 'rename'
  | 'set_model'
  | 'set_thinking'
  | 'pause'
  | 'cancel_pause'
  | 'abort'
  | 'stop'
  | 'archive';

export type ControlWorkerInput = {
  agentId: string;
  action: ControlWorkerAction;
  sessionName?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

export type ReadSessionInput = {
  agentId?: string;
  sessionFile?: string;
  limit?: number;
  before?: string;
  itemId?: string;
  offset?: number;
  maxChars?: number;
  includeToolArgs?: boolean;
  includeThinking?: boolean;
};

export type SearchSessionsInput = {
  query?: string;
  workspaceId?: string;
  cwd?: string;
  includeContent?: boolean;
  limit?: number;
};

const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_REQUEST'});
const MAX_ITEM_BODY_CHARS = 16_000;
const MAX_READ_TEXT_CHARS = 4_000;

export class OrchestratorService {
  constructor(private readonly deps: OrchestratorServiceDeps) {}

  listWorkspaces() {
    return this.deps.workspaces.list();
  }

  async listModels(input: {workspaceId?: string; relativeCwd?: string; cwd?: string} = {}) {
    if (input.workspaceId) {
      return this.deps.agents.capabilityPreview(input.workspaceId, input.relativeCwd ?? '.');
    }
    if (input.cwd) {
      const matched = await this.deps.workspaces.matchDirectory(input.cwd);
      if (matched)
        return this.deps.agents.capabilityPreview(
          matched.workspace.id,
          path.relative(matched.workspace.rootPath, matched.cwd) || '.'
        );
    }
    return this.deps.agents.capabilityPreviewAt(this.deps.orchestratorDir, 'default');
  }

  listTemplates() {
    return this.deps.templates.list().templates.map(({id, name, description, mode}) => ({
      id,
      name,
      description,
      mode
    }));
  }

  listAgents(
    callerId: string,
    filter: {
      status?: string;
      workspaceId?: string;
      cwd?: string;
      profile?: string;
      includeSelf?: boolean;
    } = {}
  ) {
    const watches = new Map<string, WatchView>();
    for (const watch of this.deps.orchestratorHub.listFor(callerId)) watches.set(watch.targetId, watch);
    return this.deps.agents
      .list()
      .filter(record => {
        if (!filter.includeSelf && record.agentId === callerId) return false;
        if (filter.status && record.status !== filter.status) return false;
        if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false;
        if (filter.profile && record.profile !== filter.profile) return false;
        if (filter.cwd && !record.cwd.toLowerCase().startsWith(filter.cwd.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
      .map(record => {
        const snapshot = this.deps.agents.snapshotState(record.agentId);
        const advice = this.deps.followUp?.current(record.agentId);
        const watch = watches.get(record.agentId);
        return {
          agentId: record.agentId,
          sessionId: record.sessionId,
          sessionFile: record.sessionFile,
          sessionName: record.sessionName,
          workspaceId: record.workspaceId,
          workspaceLabel: record.workspaceId
            ? this.deps.workspaces.get(record.workspaceId)?.label
            : undefined,
          cwd: record.cwd,
          profile: record.profile,
          status: snapshot.status,
          template: record.template ? {id: record.template.id, name: record.template.name} : undefined,
          createdAt: record.createdAt,
          lastActiveAt: record.lastActiveAt,
          phase: snapshot.activity.phase.kind,
          queue: snapshot.activity.queue,
          pendingDialogs: snapshot.activity.dialogs.length,
          ...(advice && advice.state === 'ready'
            ? {followUpOutcome: advice.outcome, followUpComplete: advice.complete}
            : {}),
          ...(watch
            ? {
                watched: {
                  watchId: watch.id,
                  group: watch.group,
                  label: watch.label,
                  settled: watch.settled
                }
              }
            : {})
        };
      });
  }

  async searchSessions(callerId: string, input: SearchSessionsInput = {}) {
    const query = input.query?.trim() || '';
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20) || 20));
    const lower = query.toLowerCase();
    let cwdFilter: string | undefined;

    // Normalize cwd filter (supporting workspace-relative paths, symlinks, and partial prefixes) and
    // refresh the session index only when the target resolves to an existing directory.
    if (input.workspaceId) {
      const ws = this.deps.workspaces.get(input.workspaceId);
      if (!ws) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
      if (input.cwd) {
        const resolved = await this.deps.workspaces.resolve(ws, input.cwd).catch(() => undefined);
        if (resolved) {
          cwdFilter = resolved;
          await this.deps.ensureSessionIndex(ws, resolved).catch(() => {});
        } else {
          cwdFilter = path.isAbsolute(input.cwd)
            ? path.resolve(input.cwd)
            : path.resolve(ws.rootPath, input.cwd);
        }
      } else {
        await this.deps.ensureSessionIndex(ws, ws.rootPath).catch(() => {});
      }
    } else if (input.cwd) {
      const matched = await this.deps.workspaces.matchDirectory(input.cwd).catch(() => undefined);
      if (matched) {
        cwdFilter = matched.cwd;
        await this.deps.ensureSessionIndex(matched.workspace, matched.cwd).catch(() => {});
      } else {
        cwdFilter = canonicalIfExists(input.cwd);
      }
    } else {
      await Promise.allSettled(
        this.deps.workspaces.list().map(ws => this.deps.ensureSessionIndex(ws, ws.rootPath))
      );
    }

    // 1. Live Agents (always freshest, including unloaded or newly named ones).
    const activeAgents = this.listAgents(callerId, {
      workspaceId: input.workspaceId,
      cwd: cwdFilter,
      includeSelf: false
    }).filter(agent => {
      if (!lower) return true;
      return (
        (agent.sessionName ?? '').toLowerCase().includes(lower) ||
        agent.cwd.toLowerCase().includes(lower) ||
        agent.agentId.toLowerCase().includes(lower) ||
        agent.sessionId.toLowerCase().includes(lower)
      );
    });

    // 2. Indexed historical Pi sessions matching metadata filters directly in SQL.
    const sessions = this.deps.metadata.searchSessions({
      query: query || undefined,
      workspaceId: input.workspaceId,
      cwd: cwdFilter,
      limit
    });

    const contentMatches: Array<{
      sessionId: string;
      sessionFile: string;
      name?: string;
      cwd: string;
      modified: string;
      messageCount: number;
      snippet: string;
    }> = [];

    if (input.includeContent && lower) {
      // Separately fetch recent unfiltered rows for the bounded content scan so metadata results above
      // are never truncated by the 60-row recency window.
      const recentForScan = this.deps.metadata.searchSessions({
        workspaceId: input.workspaceId,
        cwd: cwdFilter,
        limit: 60
      });
      const seenFiles = new Set<string>();
      const candidates: Array<{
        id: string;
        path: string;
        name?: string;
        cwd: string;
        modified: string;
        messageCount: number;
      }> = [];
      for (const agent of this.deps.agents.list()) {
        if (agent.agentId === callerId || !agent.sessionFile || seenFiles.has(agent.sessionFile)) continue;
        if (input.workspaceId && agent.workspaceId !== input.workspaceId) continue;
        if (cwdFilter && !agent.cwd.toLowerCase().startsWith(cwdFilter.toLowerCase())) continue;
        seenFiles.add(agent.sessionFile);
        candidates.push({
          id: agent.sessionId,
          path: agent.sessionFile,
          name: agent.sessionName,
          cwd: agent.cwd,
          modified: agent.lastActiveAt,
          messageCount: 0
        });
      }
      for (const item of recentForScan) {
        if (seenFiles.has(item.path)) continue;
        seenFiles.add(item.path);
        candidates.push(item);
      }
      for (const item of candidates.slice(0, 40)) {
        if (contentMatches.length >= limit) break;
        const snippet = scanSessionFileForText(item.path, lower);
        if (snippet)
          contentMatches.push({
            sessionId: item.id,
            sessionFile: item.path,
            name: item.name,
            cwd: item.cwd,
            modified: item.modified,
            messageCount: item.messageCount,
            snippet
          });
        // Yield between files so large JSONL scans do not starve other HTTP/WS clients.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return {
      agents: activeAgents.slice(0, limit),
      sessions: sessions.slice(0, limit),
      ...(input.includeContent ? {contentMatches} : {})
    };
  }

  async readSession(input: ReadSessionInput) {
    if (!input.agentId && !input.sessionFile) throw invalid('Either agentId or sessionFile is required');

    let entries: TimelineEntry[];
    let sessionId: string;
    let sessionName: string | undefined;
    let cwd: string | undefined;
    let status: string | undefined;

    if (input.agentId) {
      const record = this.deps.agents.get(input.agentId).record;
      const loaded = await this.deps.agents.timeline(input.agentId, 1);
      sessionId = loaded.sessionId;
      sessionName = record.sessionName;
      cwd = record.cwd;
      status = record.status;
      // Access entries through the loaded backend's timeline source via full build when reading items.
      const session = (await this.deps.agents.session(input.agentId)) as Record<string, unknown>;
      const leafId = session.leafId as string | null | undefined;
      const allEntries = (Array.isArray(session.entries) ? session.entries : []) as TimelineEntry[];
      entries = extractBranch(allEntries, leafId);
    } else {
      const file = path.resolve(input.sessionFile!);
      if (!existsSync(file))
        throw Object.assign(new Error('Session file not found'), {code: 'SESSION_NOT_FOUND'});
      const manager = SessionManager.open(file);
      sessionId = manager.getSessionId();
      sessionName = manager.getSessionName();
      cwd = manager.getCwd();
      entries = manager.getBranch() as unknown as TimelineEntry[];
    }

    const timeline = buildTimeline(entries);

    if (input.itemId) {
      const body = itemBody(timeline, input.itemId);
      if (body === undefined)
        throw Object.assign(new Error('Timeline item not found'), {code: 'TIMELINE_ITEM_NOT_FOUND'});
      const offset = Math.max(0, Math.trunc(input.offset ?? 0) || 0);
      const maxChars = Math.min(
        64_000,
        Math.max(100, Math.trunc(input.maxChars ?? MAX_ITEM_BODY_CHARS) || MAX_ITEM_BODY_CHARS)
      );
      const slice = body.slice(offset, offset + maxChars);
      const nextOffset = offset + slice.length;
      return {
        sessionId,
        sessionName,
        cwd,
        status,
        itemId: input.itemId,
        offset,
        totalLength: body.length,
        hasMore: nextOffset < body.length,
        ...(nextOffset < body.length ? {nextOffset} : {}),
        body: slice
      };
    }

    const limit = Math.min(80, Math.max(1, Math.trunc(input.limit ?? 30) || 30));
    const page = pageTimeline(timeline, limit, input.before);
    if (!page) throw Object.assign(new Error('Timeline item not found'), {code: 'TIMELINE_ITEM_NOT_FOUND'});

    const items = page.items
      .filter(item => input.includeThinking || item.kind !== 'thinking')
      .map(item => {
        const record: Record<string, unknown> = {
          id: item.id,
          kind: item.kind,
          ...(item.timestamp ? {timestamp: new Date(item.timestamp).toISOString()} : {}),
          ...(item.title ? {title: item.title} : {}),
          ...(item.status ? {status: item.status} : {}),
          ...(item.durationMs !== undefined ? {durationMs: item.durationMs} : {}),
          ...(item.toolCallId ? {toolCallId: item.toolCallId} : {}),
          size: item.size
        };
        if (
          item.kind === 'user' ||
          item.kind === 'assistant' ||
          item.kind === 'error' ||
          item.kind === 'compaction'
        ) {
          const text = item.body ?? itemBody(timeline, item.id) ?? '';
          record.text = clipSummaryField(text, MAX_READ_TEXT_CHARS);
          if (text.length > MAX_READ_TEXT_CHARS) record.truncated = true;
        } else if (item.kind === 'tool_call' && input.includeToolArgs) {
          record.summary = item.summary;
          record.args = clipSummaryField(item.body ?? itemBody(timeline, item.id) ?? '', 1500);
        } else {
          if (item.summary) record.summary = item.summary;
          else if (item.body && item.body.length <= 256) record.summary = item.body;
        }
        return record;
      });

    return {
      sessionId,
      sessionName,
      cwd,
      status,
      total: page.total,
      start: page.start,
      hasMore: page.hasMore,
      nextBefore: page.hasMore ? page.items[0]?.id : undefined,
      items
    };
  }

  async createWorker(
    callerId: string,
    input: CreateWorkerInput
  ): Promise<{agent: AgentRecord; watch?: WatchView}> {
    let workspace: Workspace | undefined;
    let relativeCwd = input.relativeCwd ?? '.';

    if (input.workspaceId) {
      workspace = this.deps.workspaces.get(input.workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
    } else if (input.cwd) {
      const matched = await this.deps.workspaces.matchDirectory(input.cwd);
      if (!matched)
        throw Object.assign(
          new Error(
            `Directory is not inside any configured Workspace: ${input.cwd}. Call pi2web_list_workspaces first.`
          ),
          {code: 'WORKSPACE_PATH_OUTSIDE_ROOT'}
        );
      workspace = matched.workspace;
      relativeCwd = path.relative(workspace.rootPath, matched.cwd) || '.';
    } else {
      throw invalid('Either workspaceId or cwd is required to create a code agent');
    }

    let sessionFile: string | undefined;
    if (input.sessionFile) {
      const cwd = await this.deps.workspaces.resolve(workspace, relativeCwd);
      await this.deps.ensureSessionIndex(workspace, cwd);
      if (!this.deps.metadata.hasSession(cwd, input.sessionFile))
        throw Object.assign(new Error('Session is not valid for cwd'), {code: 'SESSION_NOT_FOUND'});
      sessionFile = input.sessionFile;
    }

    const template = input.templateId ? this.deps.templates.snapshot(input.templateId) : undefined;
    const created = await this.deps.agents.create(
      workspace.id,
      relativeCwd,
      sessionFile,
      'default',
      template
    );
    try {
      if (input.model) {
        if (typeof input.model.provider !== 'string' || typeof input.model.modelId !== 'string')
          throw invalid('model.provider and model.modelId are required');
        // Orchestrator-created workers must not overwrite the user's global default model.
        await this.deps.agents.setModel(created.agentId, input.model.provider, input.model.modelId, false);
      }
      if (input.thinkingLevel) {
        await this.deps.agents.setThinkingLevel(created.agentId, input.thinkingLevel);
      }
      if (input.sessionName) {
        await this.deps.agents.setSessionName(created.agentId, input.sessionName);
      }
      const record = this.deps.agents.get(created.agentId).record;
      this.deps.metadata.saveAgent(record);

      let watch: WatchView | undefined;
      if (input.initialPrompt?.trim()) {
        if (input.notifyOnComplete) {
          watch = this.deps.orchestratorHub.watch(callerId, record.agentId, {
            group: input.notifyGroup,
            label: input.notifyLabel ?? input.sessionName
          });
        }
        try {
          this.deps.recordUserPrompt?.(record.agentId, input.initialPrompt);
          await this.deps.agents.submitCommand(record.agentId, 'prompt', input.initialPrompt);
          this.deps.metadata.scheduleAgent(this.deps.agents.get(record.agentId).record);
          void this.deps.indexAgentSession(record.agentId);
        } catch (error) {
          if (watch) this.deps.orchestratorHub.unwatch(callerId, watch.id);
          throw error;
        }
      }
      return {agent: {...this.deps.agents.get(record.agentId).record}, ...(watch ? {watch} : {})};
    } catch (error) {
      let failedRecord = created;
      try {
        failedRecord = {...this.deps.agents.get(created.agentId).record, status: 'unloaded'};
      } catch {}
      await this.deps.agents.remove(created.agentId).catch(() => {});
      this.deps.metadata.archiveAgent(failedRecord);
      throw error;
    }
  }

  async sendMessage(callerId: string, input: SendWorkerInput) {
    if (!input.agentId) throw invalid('agentId is required');
    if (input.agentId === callerId) throw invalid('An orchestrator cannot send messages to itself');
    const target = this.deps.agents.get(input.agentId).record;
    if (target.profile === 'orchestrator')
      throw invalid('Cannot send orchestrator-managed messages to another orchestrator');
    const message = typeof input.message === 'string' ? input.message : '';
    if (!message.trim()) throw invalid('message is required');
    const mode = input.mode ?? 'prompt';
    if (!['prompt', 'follow-up', 'steer'].includes(mode))
      throw invalid('mode must be prompt, follow-up, or steer');

    let watch: WatchView | undefined;
    if (input.notifyOnComplete) {
      watch = this.deps.orchestratorHub.watch(callerId, input.agentId, {
        group: input.notifyGroup,
        label: input.notifyLabel
      });
    }
    try {
      this.deps.recordUserPrompt?.(input.agentId, message);
      const disposition = await this.deps.agents.submitCommand(input.agentId, mode, message);
      this.deps.metadata.scheduleAgent(this.deps.agents.get(input.agentId).record);
      if (mode === 'prompt') void this.deps.indexAgentSession(input.agentId);
      return {
        agentId: input.agentId,
        mode,
        disposition: disposition ?? 'accepted',
        status: this.deps.agents.get(input.agentId).record.status,
        ...(watch ? {watch} : {})
      };
    } catch (error) {
      if (watch) this.deps.orchestratorHub.unwatch(callerId, watch.id);
      throw error;
    }
  }

  watchAgents(
    callerId: string,
    input: {
      action: 'list' | 'watch' | 'unwatch';
      agentId?: string;
      group?: string;
      label?: string;
      watchId?: string;
    }
  ) {
    if (input.action === 'list') return {watches: this.deps.orchestratorHub.listFor(callerId)};
    if (input.action === 'watch') {
      if (!input.agentId) throw invalid('agentId is required for watch');
      const target = this.deps.agents.get(input.agentId).record;
      if (!['starting', 'streaming', 'waiting_for_user', 'stopping'].includes(target.status)) {
        throw invalid(
          `Agent ${input.agentId} is currently ${target.status} (no active run to watch). Use pi2web_read_session to inspect its latest output or pi2web_send_message with notifyOnComplete=true.`
        );
      }
      const watch = this.deps.orchestratorHub.watch(callerId, input.agentId, {
        group: input.group,
        label: input.label
      });
      return {watch, watches: this.deps.orchestratorHub.listFor(callerId)};
    }
    if (input.action === 'unwatch') {
      const target = (input.watchId ?? input.agentId ?? '').trim();
      if (!target) throw invalid('watchId or agentId is required for unwatch');
      const removed = this.deps.orchestratorHub.unwatch(callerId, target);
      return {removed, watches: this.deps.orchestratorHub.listFor(callerId)};
    }
    throw invalid('action must be list, watch, or unwatch');
  }

  async controlAgent(callerId: string, input: ControlWorkerInput) {
    if (!input.agentId) throw invalid('agentId is required');
    if (input.agentId === callerId) throw invalid('An orchestrator cannot control itself with this tool');
    const target = this.deps.agents.get(input.agentId).record;
    if (target.profile === 'orchestrator') throw invalid('Cannot control another orchestrator Agent');
    switch (input.action) {
      case 'rename': {
        if (!input.sessionName?.trim()) throw invalid('sessionName is required for rename');
        await this.deps.agents.setSessionName(input.agentId, input.sessionName);
        const summary = await this.deps.agents.sessionInfo(input.agentId);
        const record = this.deps.agents.get(input.agentId).record;
        this.deps.metadata.saveAgent(record);
        this.deps.metadata.upsertSessionFromAgent(record, summary);
        return {agentId: input.agentId, sessionName: record.sessionName};
      }
      case 'set_model': {
        if (!input.provider || !input.modelId) throw invalid('provider and modelId are required');
        await this.deps.agents.setModel(input.agentId, input.provider, input.modelId, false);
        return {agentId: input.agentId, model: {provider: input.provider, modelId: input.modelId}};
      }
      case 'set_thinking': {
        if (!input.thinkingLevel) throw invalid('thinkingLevel is required');
        await this.deps.agents.setThinkingLevel(input.agentId, input.thinkingLevel);
        return {agentId: input.agentId, thinkingLevel: input.thinkingLevel};
      }
      case 'pause':
        await this.deps.agents.requestPause(input.agentId);
        return {agentId: input.agentId, pauseRequested: true};
      case 'cancel_pause':
        await this.deps.agents.cancelPause(input.agentId);
        return {agentId: input.agentId, pauseRequested: false};
      case 'abort':
        await this.deps.agents.command(input.agentId, 'abort');
        await this.deps.agents.abortBash(input.agentId);
        return {agentId: input.agentId, aborted: true};
      case 'stop':
        await this.deps.agents.dispose(input.agentId);
        this.deps.metadata.saveAgent(this.deps.agents.get(input.agentId).record);
        return {agentId: input.agentId, stopped: true};
      case 'archive': {
        const record = await this.deps.agents.archive(input.agentId);
        this.deps.metadata.archiveAgent(record);
        this.deps.orchestratorHub.handleAgentRemoved(input.agentId);
        return {agentId: input.agentId, archived: true};
      }
      default:
        throw invalid(`Unsupported control action: ${String(input.action)}`);
    }
  }

  // ---- Scheduled tasks ----

  listSchedules() {
    return this.deps.schedules.listTasks();
  }

  listScheduleRuns(taskId?: string, limit?: number) {
    return this.deps.schedules.listRuns(taskId, limit);
  }

  async createSchedule(callerId: string, input: ScheduleTaskInput & {cwd?: string}): Promise<ScheduledTask> {
    let workspaceId = input.workspaceId;
    let relativeCwd = input.relativeCwd;
    if (!workspaceId && input.cwd) {
      const matched = await this.deps.workspaces.matchDirectory(input.cwd);
      if (!matched)
        throw Object.assign(new Error(`Directory is not inside any configured Workspace: ${input.cwd}`), {
          code: 'WORKSPACE_PATH_OUTSIDE_ROOT'
        });
      workspaceId = matched.workspace.id;
      relativeCwd = path.relative(matched.workspace.rootPath, matched.cwd) || '.';
    }
    const notifyMode = input.notifyMode ?? 'none';
    const notifyOrchestratorId =
      notifyMode === 'orchestrator' ? input.notifyOrchestratorId || callerId : undefined;
    return this.deps.schedules.createTask({
      ...input,
      workspaceId,
      relativeCwd,
      notifyMode,
      notifyOrchestratorId
    });
  }

  async updateSchedule(
    callerId: string,
    id: string,
    patch: Partial<ScheduleTaskInput> & {cwd?: string}
  ): Promise<ScheduledTask> {
    const resolved: Partial<ScheduleTaskInput> = {...patch};
    if (!patch.workspaceId && patch.cwd) {
      const matched = await this.deps.workspaces.matchDirectory(patch.cwd);
      if (!matched)
        throw Object.assign(new Error(`Directory is not inside any configured Workspace: ${patch.cwd}`), {
          code: 'WORKSPACE_PATH_OUTSIDE_ROOT'
        });
      resolved.workspaceId = matched.workspace.id;
      resolved.relativeCwd = path.relative(matched.workspace.rootPath, matched.cwd) || '.';
    }
    if (resolved.notifyMode === 'orchestrator' && !resolved.notifyOrchestratorId) {
      resolved.notifyOrchestratorId = callerId;
    }
    return this.deps.schedules.updateTask(id, resolved);
  }

  deleteSchedule(id: string) {
    this.deps.schedules.deleteTask(id);
    return {deleted: true, id};
  }

  runScheduleNow(id: string) {
    return this.deps.schedules.runNow(id);
  }
}

function canonicalIfExists(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function extractBranch(entries: TimelineEntry[], leafId?: string | null): TimelineEntry[] {
  if (!entries.length) return [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const leaf = leafId ? byId.get(leafId) : entries.at(-1);
  if (!leaf) return entries;
  const branch: TimelineEntry[] = [];
  const seen = new Set<string>();
  let current: TimelineEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function scanSessionFileForText(sessionFile: string, needleLower: string): string | undefined {
  if (!existsSync(sessionFile)) return undefined;
  try {
    const manager = SessionManager.open(sessionFile);
    const branch = manager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry: any = branch[i];
      if (entry.type !== 'message') continue;
      const role = entry.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = contentText(entry.message?.content);
      const index = text.toLowerCase().indexOf(needleLower);
      if (index < 0) continue;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + needleLower.length + 140);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      return `[${role}] ${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
