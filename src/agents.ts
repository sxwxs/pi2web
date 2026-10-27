import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {relative as pathRelative} from 'node:path';
import type {WorkspaceStore} from './workspaces.js';
import {createSdkBackend, type BackendOptions} from './sdk-backend.js';
import type {AgentTemplateSnapshot} from './agent-templates.js';
import {ActivityTracker, type Activity} from './activity.js';
import {AgentFeed, type DetailMessage, type TimelineSource} from './agent-feed.js';
import {buildTimeline, itemBody, pageTimeline, type TimelineEntry} from './timeline.js';
export type AgentState = {
  status:
    | 'unloaded'
    | 'starting'
    | 'idle'
    | 'streaming'
    | 'waiting_for_user'
    | 'error'
    | 'stopping'
    | 'stopped';
  agentId: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
};
export type AgentEvent = {type: string; [key: string]: unknown};

/**
 * Reduce a Pi SDK event to the fields server-side consumers and clients use, or drop it.
 * Heavy SDK events are whitelisted field by field (Pi attaches whole messages to many of
 * them) so new SDK fields never leak into memory or onto the wire; pi2web's own events pass through.
 */
export function slimEvent(event: AgentEvent): AgentEvent | undefined {
  const e = event as any;
  switch (event.type) {
    // Streamed text and running tool output reach viewing clients through AgentFeed, not as events.
    case 'message_update':
    case 'tool_execution_update':
      return undefined;
    case 'message_start':
      return {type: 'message_start', role: e.message?.role ?? e.role};
    case 'turn_start':
    case 'turn_end':
      return {type: event.type};
    case 'message_end':
      return {type: 'message_end', message: e.message};
    case 'agent_end':
      return {type: 'agent_end', willRetry: e.willRetry, aborted: e.aborted};
    case 'tool_execution_start':
      return {
        type: event.type,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: e.args,
        parentToolCallId: e.parentToolCallId
      };
    case 'tool_execution_end':
      return {
        type: event.type,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        parentToolCallId: e.parentToolCallId,
        result: e.result,
        isError: e.isError,
        durationMs: e.durationMs
      };
    default:
      return event;
  }
}
/** Whether a steered or follow-up message reached the running turn or is waiting for it. */
export type QueuedInputDisposition = 'handled' | 'queued';
export type AgentQueue = {steering: string[]; followUp: string[]};
/** Live activity plus what clients need to rebuild dialog controls and the queue bar. */
export type AgentActivity = Activity & {
  dialogRequests: AgentEvent[];
  queue: AgentQueue;
};
export type AgentSnapshotState = AgentState & {activity: AgentActivity};
export type SlashCommandSummary = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'prompt' | 'skill';
};
export type SystemPromptInfo = {
  systemPrompt: string;
  /** SYSTEM.md that replaced Pi's base prompt, if any (a `replace` template hides it). */
  systemFile?: string;
  appendFiles?: string[];
  contextFiles?: string[];
};
export type BashRunResult = {
  id: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
};
export interface AgentBackend {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<QueuedInputDisposition>;
  followUp(message: string): Promise<QueuedInputDisposition>;
  getQueue(): Promise<AgentQueue>;
  clearQueue(): Promise<AgentQueue>;
  moveQueue(from: keyof AgentQueue, index: number, expected: string): Promise<AgentQueue>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  /** The session's current branch, for the timeline. Must be cheap when the leaf has not moved. */
  timeline(): TimelineSource;
  getSystemPrompt(): Promise<SystemPromptInfo>;
  getCapabilities(): Promise<Record<string, unknown>>;
  getSession(): Promise<Record<string, unknown>>;
  getSessionInfo(): Promise<Record<string, unknown>>;
  compact(instructions?: string): Promise<unknown>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setSessionName(name: string): Promise<void>;
  navigate(entryId: string): Promise<unknown>;
  fork(entryId: string): Promise<{sessionFile?: string; selectedText?: string}>;
  extensionResponse(requestId: string, value: unknown): Promise<void>;
  listCommands(): Promise<SlashCommandSummary[]>;
  runBash(command: string, excludeFromContext?: boolean): Promise<BashRunResult>;
  abortBash(): void;
  subscribe(listener: (e: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}
/** Deterministic backend used by the server and tests. The SDK adapter can implement the same contract. */
export class MockBackend implements AgentBackend {
  private emitter = new EventEmitter();
  private state: AgentState;
  private entries: TimelineEntry[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private queue: AgentQueue = {steering: [], followUp: []};
  constructor(
    agentId: string,
    cwd: string,
    sessionId: string = randomUUID(),
    private readonly options: BackendOptions = {}
  ) {
    this.state = {agentId, sessionId, cwd, status: 'idle'};
  }
  private emit(e: AgentEvent) {
    this.emitter.emit('event', e);
  }
  /** Persist like Pi: append a session entry after listeners have seen the message. */
  protected append(message: Record<string, unknown>) {
    const id = randomUUID().slice(0, 8);
    this.entries.push({
      type: 'message',
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: {timestamp: Date.now(), ...message}
    });
    return id;
  }
  /** The body of a turn. Tests override it to keep a run streaming while they inspect queued input. */
  protected runTurn() {
    return new Promise<void>(r => {
      this.timer = setTimeout(r, 0);
    });
  }
  async prompt(message: string) {
    if (this.state.status === 'streaming')
      throw Object.assign(new Error('Agent is busy'), {code: 'AGENT_BUSY'});
    this.state.status = 'streaming';
    this.emit({type: 'agent_start', message});
    await this.runTurn();
    const user = {role: 'user', content: message};
    this.emit({type: 'message_end', message: user});
    this.append(user);
    const text = `Mock response: ${message}`,
      assistant = {role: 'assistant', content: [{type: 'text', text}]};
    this.emit({type: 'message_start', message: {role: 'assistant', content: []}});
    this.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: text}});
    this.emit({type: 'message_end', message: assistant});
    this.append(assistant);
    this.state.status = 'idle';
    this.emit({type: 'agent_end'});
  }
  async steer(message: string): Promise<QueuedInputDisposition> {
    const queued = this.state.status === 'streaming';
    if (queued) this.queue.steering.push(message);
    this.emit({type: 'steer', message});
    if (queued) this.emitQueue();
    return queued ? 'queued' : 'handled';
  }
  async followUp(message: string): Promise<QueuedInputDisposition> {
    const queued = this.state.status === 'streaming';
    if (queued) this.queue.followUp.push(message);
    this.emit({type: 'follow_up', message});
    if (queued) this.emitQueue();
    return queued ? 'queued' : 'handled';
  }
  async getQueue() {
    return {steering: [...this.queue.steering], followUp: [...this.queue.followUp]};
  }
  async clearQueue() {
    const cleared = await this.getQueue();
    this.queue = {steering: [], followUp: []};
    this.emitQueue();
    return cleared;
  }
  async moveQueue(from: keyof AgentQueue, index: number, expected: string) {
    if (this.state.status !== 'streaming' || this.queue[from][index] !== expected)
      throw Object.assign(new Error('Queued message has changed or already been consumed'), {code: 'QUEUE_CHANGED'});
    const to = from === 'steering' ? 'followUp' : 'steering';
    this.queue[from].splice(index, 1);
    this.queue[to].push(expected);
    this.emitQueue();
    return this.getQueue();
  }
  private emitQueue() {
    this.emit({type: 'queue_update', steering: [...this.queue.steering], followUp: [...this.queue.followUp]});
  }
  async abort() {
    if (this.state.status === 'streaming') {
      if (this.timer) clearTimeout(this.timer);
      this.state.status = 'idle';
      this.emit({type: 'agent_end', aborted: true});
    }
  }
  async getState() {
    return {...this.state};
  }
  timeline(): TimelineSource {
    return {
      sessionId: this.state.sessionId,
      leafId: this.entries.at(-1)?.id ?? null,
      entries: () => [...this.entries]
    };
  }
  async getSystemPrompt(): Promise<SystemPromptInfo> {
    const template = this.options.piDefaultPrompt ? undefined : this.options.template;
    const base = template?.mode === 'replace' ? template.systemPrompt : 'Mock Pi system prompt';
    return {
      systemPrompt: [base, template?.mode === 'append' ? template.systemPrompt : '', `cwd: ${this.state.cwd}`]
        .filter(Boolean)
        .join('\n\n'),
      appendFiles: [],
      contextFiles: []
    };
  }
  async getCapabilities() {
    return {model: null, models: [], thinkingLevel: 'off', thinkingLevels: ['off'], supportsThinking: false};
  }
  async getSession() {
    return {...(await this.getSessionInfo()), entries: [...this.entries], tree: []};
  }
  async getSessionInfo() {
    return {
      sessionId: this.state.sessionId,
      sessionName: this.state.sessionName,
      stats: {totalMessages: this.entries.length, tokens: {total: 0}, cost: 0},
      contextUsage: {tokens: null, contextWindow: 0, percent: null}
    };
  }
  async compact() {
    return {summary: 'mock'};
  }
  async setModel(_provider: string, _modelId: string) {}
  async setThinkingLevel(_level: string) {}
  async setSessionName(name: string) {
    this.state.sessionName = name;
    this.emit({type: 'session_info_changed', name});
  }
  /** Move the leaf back to an earlier entry, like rewinding a Pi session. */
  async navigate(entryId: string) {
    const index = this.entries.findIndex(entry => entry.id === entryId);
    if (index >= 0) this.entries = this.entries.slice(0, index + 1);
    return {cancelled: false};
  }
  async fork(_entryId: string): Promise<{sessionFile?: string; selectedText?: string}> {
    return {};
  }
  async extensionResponse(_requestId: string, _value: unknown) {}
  async listCommands() {
    return [{name: 'mock', description: 'Mock prompt template', source: 'prompt' as const}];
  }
  async runBash(command: string, excludeFromContext = false) {
    const id = randomUUID(),
      output = `Mock bash: ${command}`;
    this.emit({type: 'bash_execution_start', id, command});
    this.emit({type: 'bash_execution_update', id, delta: `${output}\n`});
    const result = {id, output, exitCode: 0, cancelled: false, truncated: false};
    this.append({
      role: 'bashExecution',
      command,
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext
    });
    this.emit({type: 'bash_execution_end', command, ...result});
    return result;
  }
  abortBash() {}
  subscribe(listener: (e: AgentEvent) => void) {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
  async dispose() {
    await this.abort();
    this.state.status = 'stopped';
    this.emitter.removeAllListeners();
  }
}
export type AgentProfile = 'default' | 'collab';
export type AgentRecord = AgentState & {
  workspaceId: string;
  profile: AgentProfile;
  /** System prompt template chosen at creation. Fixed for the Agent's lifetime, including forks. */
  template?: AgentTemplateSnapshot;
  createdAt: string;
  lastActiveAt: string;
};
/** An event as server-side consumers and the overview stream receive it. */
export type PublishedEvent = {timestamp: number; status: AgentState['status']; event: AgentEvent};
type AgentEntry = {
  record: AgentRecord;
  backend?: AgentBackend;
  loading?: Promise<AgentBackend>;
  /** Detail stream of the loaded backend: streamed text, timeline changes, tool output. */
  feed?: AgentFeed;
  activity: ActivityTracker;
  dialogRequests: Map<string, AgentEvent>;
  queue: AgentQueue;
  streaming?: boolean;
  promptPending?: boolean;
  templateChanging?: boolean;
};
const toStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
const emptyQueue = (): AgentQueue => ({steering: [], followUp: []});
const LIFECYCLE_ONLY = new Set(['agent_loaded', 'agent_unloaded']);
/** A pending dialog blocks the run until a human answers it, which is a different wait than streaming. */
const runStatus = (entry: AgentEntry, streaming: boolean): AgentState['status'] =>
  entry.dialogRequests.size ? 'waiting_for_user' : streaming ? 'streaming' : 'idle';
export class AgentManager {
  private agents = new Map<string, AgentEntry>();
  private detailListeners = new Map<string, Set<(message: DetailMessage) => void>>();
  private globalListeners = new Set<(agentId: string, e: PublishedEvent) => void>();
  constructor(
    private workspaces: WorkspaceStore,
    private factory: (
      id: string,
      cwd: string,
      sessionFile?: string,
      profile?: AgentProfile,
      options?: BackendOptions
    ) => AgentBackend | Promise<AgentBackend> = (id, cwd, sessionFile, profile, options) =>
      createSdkBackend(id, cwd, sessionFile, profile, undefined, options)
  ) {}
  private async resolveCwd(workspaceId: string, relativeCwd = '.') {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
    const cwd = await this.workspaces.resolve(ws, relativeCwd);
    if (!(await import('node:fs/promises')).stat(cwd).then(s => s.isDirectory()))
      throw new Error('cwd is not a directory');
    return cwd;
  }
  async create(
    workspaceId: string,
    relativeCwd = '.',
    sessionFile?: string,
    profile: AgentProfile = 'default',
    template?: AgentTemplateSnapshot
  ) {
    const cwd = await this.resolveCwd(workspaceId, relativeCwd);
    const id = `agent-${randomUUID()}`,
      backend = await this.factory(id, cwd, sessionFile, profile, template ? {template} : {}),
      now = new Date().toISOString();
    const record: AgentRecord = {
      ...(await backend.getState()),
      workspaceId,
      profile,
      ...(template ? {template: {...template}} : {}),
      createdAt: now,
      lastActiveAt: now
    };
    this.attach(id, record, backend);
    return {...record};
  }
  /** Build a disposable session so the UI sees the models actually available for this project and its extensions. */
  async capabilityPreview(workspaceId: string, relativeCwd = '.') {
    const cwd = await this.resolveCwd(workspaceId, relativeCwd),
      backend = await this.factory(`preview-${randomUUID()}`, cwd);
    try {
      return await backend.getCapabilities();
    } finally {
      await backend.dispose();
    }
  }
  /**
   * The system prompt an Agent created here would start with. `template` previews a template;
   * `piDefaultPrompt` ignores SYSTEM.md / APPEND_SYSTEM.md to show Pi's built-in prompt.
   */
  async systemPromptPreview(workspaceId: string, relativeCwd = '.', options: BackendOptions = {}) {
    const cwd = await this.resolveCwd(workspaceId, relativeCwd),
      backend = await this.factory(`preview-${randomUUID()}`, cwd, undefined, 'default', options);
    try {
      return {...(await backend.getSystemPrompt()), cwd};
    } finally {
      await backend.dispose();
    }
  }
  private connect(entry: AgentEntry, backend: AgentBackend) {
    entry.backend = backend;
    entry.feed?.close();
    const agentId = entry.record.agentId,
      feed = new AgentFeed(
        () => backend.timeline(),
        message => {
          for (const listener of this.detailListeners.get(agentId) ?? []) listener(message);
        }
      );
    entry.feed = feed;
    backend.subscribe(event => {
      if (entry.backend !== backend) return;
      const record = entry.record,
        type = event.type;
      if (type === 'agent_start' || type === 'auto_retry_start') entry.streaming = true;
      else if (type === 'agent_end') entry.streaming = event.willRetry === true;
      else if (type === 'agent_settled') entry.streaming = false;
      if (type === 'queue_update')
        entry.queue = {steering: toStringList(event.steering), followUp: toStringList(event.followUp)};
      const activityChanged = entry.activity.apply(event);
      // Keep dialog payloads so reconnecting clients can rebuild their controls.
      if (typeof event.requestId === 'string') {
        if (type === 'extension_ui_request') entry.dialogRequests.set(event.requestId, event);
        else if (type === 'extension_ui_response') entry.dialogRequests.delete(event.requestId);
      }
      record.status = runStatus(entry, entry.streaming === true);
      if (type === 'session_info_changed')
        record.sessionName =
          typeof event.name === 'string' && event.name.trim() ? event.name.trim() : undefined;
      feed.handle(event);
      const slim = slimEvent(event);
      if (slim) this.publish(entry, slim);
      if (activityChanged) this.publishActivity(entry);
    });
  }
  private publishActivity(entry: AgentEntry) {
    this.publish(entry, {type: 'activity_changed', activity: entry.activity.snapshot()});
  }
  /** Loading or unloading a backend is not activity: it must not reorder the Agent list. */
  private publish(entry: AgentEntry, event: AgentEvent) {
    const record = entry.record;
    if (!LIFECYCLE_ONLY.has(event.type)) record.lastActiveAt = new Date().toISOString();
    // Every event carries the authoritative status, so clients never have to derive it from event types.
    const item = {timestamp: Date.now(), status: record.status, event};
    for (const listener of this.globalListeners) listener(record.agentId, item);
  }
  private attach(id: string, record: AgentRecord, backend: AgentBackend) {
    const entry: AgentEntry = {
      record,
      backend,
      activity: new ActivityTracker(),
      dialogRequests: new Map(),
      queue: emptyQueue()
    };
    this.connect(entry, backend);
    this.agents.set(id, entry);
  }
  async restore(records: AgentRecord[]) {
    for (const saved of records) {
      try {
        const ws = this.workspaces.get(saved.workspaceId);
        if (!ws) continue;
        const cwd = await this.workspaces.resolve(ws, pathRelative(ws.rootPath, saved.cwd));
        const sessionModified = saved.sessionFile
          ? await import('node:fs/promises').then(fs =>
              fs
                .stat(saved.sessionFile!)
                .then(value => value.mtime.toISOString())
                .catch(() => undefined)
            )
          : undefined;
        const record = {
          ...saved,
          profile: saved.profile ?? 'default',
          cwd,
          status: 'unloaded' as const,
          lastActiveAt:
            sessionModified && sessionModified > saved.lastActiveAt ? sessionModified : saved.lastActiveAt
        };
        this.agents.set(saved.agentId, {
          record,
          activity: new ActivityTracker(),
          dialogRequests: new Map(),
          queue: emptyQueue()
        });
      } catch {
        /* Keep server startup resilient to deleted workspaces. */
      }
    }
  }
  get(id: string) {
    const x = this.agents.get(id);
    if (!x) throw Object.assign(new Error('Agent not found'), {code: 'AGENT_NOT_FOUND'});
    return x;
  }
  list() {
    return [...this.agents.values()].map(x => ({...x.record}));
  }
  isLoaded(id: string) {
    return !!this.get(id).backend;
  }
  private async ensureLoaded(id: string) {
    const entry = this.get(id);
    if (entry.backend) return entry.backend;
    if (entry.record.status === 'stopped')
      throw Object.assign(new Error('Agent is not running'), {code: 'AGENT_NOT_RUNNING'});
    if (entry.loading) return entry.loading;
    entry.record.status = 'starting';
    entry.loading = (async () => {
      try {
        const backend = await this.factory(
          id,
          entry.record.cwd,
          entry.record.sessionFile,
          entry.record.profile,
          entry.record.template ? {template: entry.record.template} : {}
        );
        const state = await backend.getState();
        entry.record = {
          ...entry.record,
          ...state,
          sessionName: state.sessionName?.trim() || entry.record.sessionName,
          status: state.status === 'stopped' ? 'idle' : state.status
        };
        this.connect(entry, backend);
        // The status moved from unloaded to idle without a Pi event; tell clients.
        this.publish(entry, {type: 'agent_loaded'});
        return backend;
      } catch (error) {
        entry.record.status = 'error';
        throw error;
      } finally {
        entry.loading = undefined;
      }
    })();
    return entry.loading;
  }
  async command(id: string, kind: 'prompt' | 'steer' | 'follow-up' | 'abort', message = '') {
    const entry = this.get(id);
    if (kind === 'abort' && !entry.backend) return;
    if (entry.record.status === 'stopped')
      throw Object.assign(new Error('Agent is not running'), {code: 'AGENT_NOT_RUNNING'});
    if (entry.templateChanging)
      throw Object.assign(new Error('System Prompt is being changed'), {code: 'SESSION_BUSY'});
    const backend = await this.ensureLoaded(id);
    if (kind === 'abort') {
      if (entry.activity.stopping()) this.publishActivity(entry);
      return backend.abort();
    }
    const busy = entry.promptPending || entry.streaming || (await backend.getState()).status === 'streaming';
    const effective = busy ? (kind === 'prompt' ? 'follow-up' : kind) : 'prompt';
    if (effective === 'prompt') entry.promptPending = true;
    try {
      return await backend[effective === 'follow-up' ? 'followUp' : effective](message);
    } finally {
      if (effective === 'prompt') entry.promptPending = false;
    }
  }
  /** Queued steering and follow-up messages waiting for the running turn. */
  // Both read through to the backend and leave the cache to `queue_update`, which stays correct when a
  // message is queued while these run.
  async queue(id: string) {
    const entry = this.get(id);
    return entry.backend
      ? entry.backend.getQueue()
      : {steering: [...entry.queue.steering], followUp: [...entry.queue.followUp]};
  }
  /** Drop queued messages and return them so the caller can restore them to its composer. */
  async clearQueue(id: string) {
    const entry = this.get(id);
    return entry.backend ? entry.backend.clearQueue() : emptyQueue();
  }
  async moveQueue(id: string, from: keyof AgentQueue, index: number, expected: string) {
    const backend = await this.ensureLoaded(id);
    return backend.moveQueue(from, index, expected);
  }
  snapshotState(id: string): AgentSnapshotState {
    const a = this.get(id);
    return {
      ...a.record,
      activity: {
        ...a.activity.snapshot(),
        dialogRequests: [...a.dialogRequests.values()],
        queue: {steering: [...a.queue.steering], followUp: [...a.queue.followUp]}
      }
    };
  }
  /**
   * Start viewing an Agent in detail: load it, then subscribe and take a snapshot together, with
   * nothing in between, so every message the listener gets is newer than the snapshot.
   */
  async focus(id: string, listener: (message: DetailMessage) => void, limit?: number) {
    await this.ensureLoaded(id);
    const entry = this.get(id);
    // Snapshot first: it publishes pending changes, which it includes, before this listener exists.
    const snapshot = {
      ...entry.feed!.snapshot(limit),
      // Dialog controls live in the transcript, which a viewer replaces when it starts viewing.
      dialogRequests: [...entry.dialogRequests.values()]
    };
    if (!this.detailListeners.has(id)) this.detailListeners.set(id, new Set());
    this.detailListeners.get(id)!.add(listener);
    return {unsubscribe: () => this.detailListeners.get(id)?.delete(listener), snapshot};
  }
  toolOutput(id: string, toolCallId: string) {
    return this.get(id).feed?.output(toolCallId);
  }
  /** Events of every Agent: server-side consumers and the overview stream. */
  subscribeAll(listener: (agentId: string, e: PublishedEvent) => void) {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }
  async dispose(id: string) {
    const a = this.get(id);
    if (a.loading) await a.loading.catch(() => {});
    await a.backend?.dispose();
    a.backend = undefined;
    a.feed?.close();
    a.feed = undefined;
    a.record.status = 'unloaded';
    a.streaming = false;
    a.dialogRequests.clear();
    a.activity.reset(); // agent_unloaded below tells clients the activity is gone.
    a.queue = emptyQueue();
    this.publish(a, {type: 'agent_unloaded'});
  }
  async remove(id: string) {
    await this.dispose(id);
    this.agents.delete(id);
    this.detailListeners.delete(id);
  }
  async archive(id: string) {
    const current = this.get(id).record;
    if (['starting', 'streaming', 'waiting_for_user', 'stopping'].includes(current.status))
      throw Object.assign(new Error('Active Agent cannot be archived'), {code: 'AGENT_ACTIVE'});
    const record = {...current, status: 'unloaded' as const};
    await this.remove(id);
    return record;
  }
  // The record status, not the backend's, is authoritative: it also knows about pending dialogs.
  async state(id: string) {
    const state = await (await this.ensureLoaded(id)).getState(),
      record = this.get(id).record;
    return {...state, status: record.status, sessionName: state.sessionName?.trim() || record.sessionName};
  }
  /** Older history: the page before item `before` (or the newest one). Live viewers get it from focus(). */
  async timeline(id: string, limit?: number, before?: string) {
    const source = (await this.ensureLoaded(id)).timeline(),
      page = pageTimeline(buildTimeline(source.entries()), limit, before);
    if (!page) throw Object.assign(new Error('Timeline item not found'), {code: 'TIMELINE_ITEM_NOT_FOUND'});
    return {sessionId: source.sessionId, ...page};
  }
  /** The full body of one timeline item of the given session. It never changes. */
  async item(id: string, sessionId: string, itemId: string) {
    const source = (await this.ensureLoaded(id)).timeline(),
      body = source.sessionId === sessionId ? itemBody(buildTimeline(source.entries()), itemId) : undefined;
    if (body === undefined)
      throw Object.assign(new Error('Timeline item not found'), {code: 'TIMELINE_ITEM_NOT_FOUND'});
    return {id: itemId, body};
  }
  async systemPrompt(id: string) {
    const info = await (await this.ensureLoaded(id)).getSystemPrompt();
    return {...info, template: this.get(id).record.template ?? null};
  }
  /** Replace the disposable, still-empty session. Never rewrite a conversation's system prompt. */
  async setTemplate(id: string, template?: AgentTemplateSnapshot) {
    const entry = this.get(id);
    if (entry.record.profile !== 'default' || entry.record.status === 'stopped' || entry.streaming || entry.promptPending)
      throw Object.assign(new Error('System Prompt can only change before the first turn'), {code: 'SESSION_STARTED'});
    if (entry.templateChanging) throw Object.assign(new Error('System Prompt is being changed'), {code: 'SESSION_BUSY'});
    entry.templateChanging = true;
    try {
      const old = await this.ensureLoaded(id);
      const session = await old.getSession();
      if ((session.entries as any[]).some(x => x.type === 'message'))
        throw Object.assign(new Error('This session already has messages'), {code: 'SESSION_STARTED'});
      const capabilities = await old.getCapabilities();
      const replacement = await this.factory(
        id, entry.record.cwd, entry.record.sessionFile, entry.record.profile, template ? {template} : {}
      );
      try {
        const model = capabilities.model as {provider?: string; id?: string} | undefined;
        if (model?.provider && model?.id) await replacement.setModel(model.provider, model.id);
        if (typeof capabilities.thinkingLevel === 'string') await replacement.setThinkingLevel(capabilities.thinkingLevel);
        if (entry.record.sessionName) await replacement.setSessionName(entry.record.sessionName);
        const state = await replacement.getState();
        entry.record = {...entry.record, ...state, template};
        this.connect(entry, replacement);
        await old.dispose().catch(() => {});
        this.publish(entry, {type: 'agent_loaded'});
        return entry.record;
      } catch (error) {
        await replacement.dispose();
        throw error;
      }
    } finally {
      entry.templateChanging = false;
    }
  }
  async capabilities(id: string) {
    return (await this.ensureLoaded(id)).getCapabilities();
  }
  async session(id: string) {
    const info = await (await this.ensureLoaded(id)).getSession(),
      name =
        typeof info.sessionName === 'string' && info.sessionName.trim()
          ? info.sessionName
          : this.get(id).record.sessionName;
    return {...info, sessionName: name};
  }
  async sessionInfo(id: string) {
    const info = await (await this.ensureLoaded(id)).getSessionInfo(),
      name =
        typeof info.sessionName === 'string' && info.sessionName.trim()
          ? info.sessionName
          : this.get(id).record.sessionName;
    return {...info, sessionName: name};
  }
  async compact(id: string, instructions?: string) {
    return (await this.ensureLoaded(id)).compact(instructions);
  }
  async setModel(id: string, provider: string, modelId: string) {
    return (await this.ensureLoaded(id)).setModel(provider, modelId);
  }
  async setThinkingLevel(id: string, level: string) {
    return (await this.ensureLoaded(id)).setThinkingLevel(level);
  }
  async setSessionName(id: string, name: string) {
    await (await this.ensureLoaded(id)).setSessionName(name);
    this.get(id).record.sessionName = name.trim();
  }
  async navigate(id: string, entryId: string) {
    const result = await (await this.ensureLoaded(id)).navigate(entryId);
    this.get(id).feed?.sync(); // Moving the leaf back is no event; tell viewers to reload.
    return result;
  }
  async fork(id: string, entryId: string) {
    const source = this.get(id),
      result = await (await this.ensureLoaded(id)).fork(entryId);
    if (!result.sessionFile)
      throw Object.assign(new Error('Session persistence is disabled'), {code: 'SESSION_NOT_PERSISTED'});
    const ws = this.workspaces.get(source.record.workspaceId)!;
    const agent = await this.create(
      source.record.workspaceId,
      pathRelative(ws.rootPath, source.record.cwd),
      result.sessionFile,
      source.record.profile,
      source.record.template
    );
    return {agent, selectedText: result.selectedText};
  }
  async extensionResponse(id: string, requestId: string, value: unknown) {
    return (await this.ensureLoaded(id)).extensionResponse(requestId, value);
  }
  async listCommands(id: string) {
    return (await this.ensureLoaded(id)).listCommands();
  }
  /** Session-scoped bash. Output is streamed as `bash_execution_update` events and recorded in the Session. */
  async runBash(id: string, command: string, excludeFromContext = false) {
    return (await this.ensureLoaded(id)).runBash(command, excludeFromContext);
  }
  async abortBash(id: string) {
    const entry = this.get(id);
    if (entry.loading) await entry.loading;
    entry.backend?.abortBash();
  }
}
