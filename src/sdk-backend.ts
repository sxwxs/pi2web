import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionUIContext
} from '@earendil-works/pi-coding-agent';
import type {AgentTurnDecision} from '@earendil-works/pi-agent-core';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {
  AgentBackend,
  AgentEvent,
  AgentProfile,
  AgentQueue,
  AgentState,
  QueuedInputDisposition
} from './agents.js';
import type {AgentTemplateSnapshot} from './agent-templates.js';
import type {TimelineSource} from './agent-feed.js';
import type {TimelineEntry} from './timeline.js';
import {PERFORMANCE_ENTRY, SessionPerformanceTracker} from './session-performance.js';

export type BackendOptions = {
  /** System prompt template copied onto the Agent at creation time. */
  template?: AgentTemplateSnapshot;
  /** Ignore SYSTEM.md / APPEND_SYSTEM.md and templates: Pi's built-in prompt, used for previews only. */
  piDefaultPrompt?: boolean;
};
import {createCollabExtension, type CollabToolBridge} from './collab/pi-extension.js';

/** Older Pi builds resolved steer()/followUp() with undefined; treat anything but an explicit `handled` as queued. */
const normalizeDisposition = (value: unknown): QueuedInputDisposition =>
  value === 'handled' ? 'handled' : 'queued';

/**
 * Safe pause progress, published as a `safe_pause` event:
 * `requested` the run stops at its next safe point; `paused` it stopped there;
 * `cancelled` the user withdrew the request; `finished` the run ended on its own first.
 */
export type SafePauseState = 'requested' | 'paused' | 'cancelled' | 'finished';

/** Real in-process Pi SDK backend with session/model/extension controls exposed to remote clients. */
export class SdkBackend implements AgentBackend {
  private disposed = false;
  /** The user asked the current run to stop at its next safe point. */
  private pauseRequested = false;
  /** The current run was ended at a safe point; reported once the session settles. */
  private pauseReached = false;
  /** Whether the last settled run ended at a safe point (tags its `agent_settled`). */
  private settledPaused = false;
  /** Messages queued when the run paused. Pi would run them at once, so they wait here for the next prompt. */
  private pausedQueue: AgentQueue = {steering: [], followUp: []};
  private events = new EventEmitter();
  private pendingUi = new Map<
    string,
    {resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout>}
  >();
  private constructor(
    private readonly session: AgentSession,
    private readonly agentId: string,
    private readonly cwd: string
  ) {
    const performance = new SessionPerformanceTracker(run =>
      this.session.sessionManager.appendCustomEntry(PERFORMANCE_ENTRY, run)
    );
    this.session.subscribe(event => performance.apply(event as AgentEvent));
    this.installSafePause();
  }
  /**
   * Safe pause ends the run after a turn's tool results are recorded and before the next model
   * request. The transcript then ends with tool results, which is a state Pi can carry on from.
   */
  private installSafePause() {
    const agent = this.session.agent;
    // AgentSession installs its own finishTurn (extension turn_end boundaries); keep it running first.
    const previous = agent.finishTurn;
    agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
      const decision = (await previous?.(turn, signal)) ?? undefined;
      if (!this.pauseRequested || decision?.action === 'end') return decision;
      // Error and aborted turns end the run anyway; a retry is caught on auto_retry_start.
      if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return decision;
      const wouldContinue =
        turn.toolResults.length > 0 || decision?.action === 'continue' || agent.hasQueuedMessages();
      // A final answer with nothing queued ends the run by itself: there is nothing to pause.
      if (!wouldContinue) return decision;
      this.pauseRequested = false;
      this.pauseReached = true;
      // Queued input would make Pi continue right after the run ends. Hold it for the next prompt.
      const cleared = this.session.clearQueue();
      this.pausedQueue = {
        steering: [...this.pausedQueue.steering, ...cleared.steering],
        followUp: [...this.pausedQueue.followUp, ...cleared.followUp]
      };
      return {action: 'end'};
    };
    this.session.subscribe(event => {
      // Only the agent_settled that ends a paused run carries the tag.
      if (event.type !== 'agent_settled') this.settledPaused = false;
      // A retry would send another model request. Stop it; the run ends with the failed response.
      if (event.type === 'auto_retry_start' && this.pauseRequested) {
        this.pauseRequested = false;
        this.pauseReached = true;
        this.session.abortRetry();
      }
      if (event.type !== 'agent_settled') return;
      if (this.pauseReached) {
        this.pauseReached = false;
        this.settledPaused = true;
        this.emitSafePause('paused');
        if (this.pausedQueue.steering.length || this.pausedQueue.followUp.length)
          this.events.emit('event', {type: 'queue_update', ...this.copyQueue(this.pausedQueue)});
      } else if (this.pauseRequested) {
        this.pauseRequested = false;
        this.emitSafePause('finished');
      }
    });
  }
  private emitSafePause(state: SafePauseState) {
    this.events.emit('event', {type: 'safe_pause', state});
  }
  private copyQueue(queue: AgentQueue): AgentQueue {
    return {steering: [...queue.steering], followUp: [...queue.followUp]};
  }
  /** Ask the running turn to stop before its next model request. */
  async requestPause() {
    if (!this.session.isStreaming)
      throw Object.assign(new Error('Agent is not running'), {code: 'AGENT_NOT_RUNNING'});
    if (!this.pauseRequested) {
      this.pauseRequested = true;
      this.emitSafePause('requested');
    }
  }
  async cancelPause() {
    if (!this.pauseRequested) return;
    this.pauseRequested = false;
    this.emitSafePause('cancelled');
  }
  static async create(
    agentId: string,
    cwd: string,
    sessionFile?: string,
    profile: AgentProfile = 'default',
    collabBridge?: CollabToolBridge,
    options: BackendOptions = {}
  ): Promise<SdkBackend> {
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd);
    const {template, piDefaultPrompt} = options;
    // This factory is deliberately inline instead of auto-discovered: normal Pi and normal pi2web agents
    // never load the collaboration tools or their collaboration-specific system guidance.
    const extensionFactories =
      profile === 'collab' && collabBridge
        ? [{name: 'pi2web-collab', factory: createCollabExtension(agentId, collabBridge)}]
        : [];
    // A template behaves like Pi's own prompt files: `replace` stands in for SYSTEM.md, `append` follows
    // APPEND_SYSTEM.md. `piDefaultPrompt` ignores both files to show what Pi itself would send.
    const systemPromptOverride = piDefaultPrompt
      ? () => undefined
      : template?.mode === 'replace'
        ? () => template.systemPrompt
        : undefined;
    const appendSystemPromptOverride = piDefaultPrompt
      ? () => []
      : template?.mode === 'append'
        ? (base: string[]) => [...base, template.systemPrompt]
        : undefined;
    const resourceLoader =
      extensionFactories.length || systemPromptOverride || appendSystemPromptOverride
        ? new DefaultResourceLoader({
            cwd,
            agentDir: getAgentDir(),
            extensionFactories,
            systemPromptOverride,
            appendSystemPromptOverride
          })
        : undefined;
    if (resourceLoader) await resourceLoader.reload();
    const {session, modelFallbackMessage} = await createAgentSession({cwd, sessionManager, resourceLoader});
    if (modelFallbackMessage && !session.state.model) {
      session.dispose();
      throw Object.assign(new Error(modelFallbackMessage), {code: 'PI_MODEL_UNAVAILABLE'});
    }
    return SdkBackend.fromSession(session, agentId, cwd);
  }
  /** Wrap an existing Pi session; tests use it to drive a real session with a scripted model. */
  static async fromSession(session: AgentSession, agentId: string, cwd: string) {
    const backend = new SdkBackend(session, agentId, cwd);
    await session.bindExtensions({uiContext: backend.extensionUi()});
    return backend;
  }
  // Slash commands, skills and prompt templates are expanded by prompt() itself (expandPromptTemplates defaults to true),
  // so `/name args` typed in the web composer behaves exactly like the Pi TUI.
  async prompt(message: string) {
    // Input held back by a safe pause goes in after this prompt, as Pi would have delivered it.
    // Queuing does not start a run, and the run's first poll picks the steering messages up.
    const held = this.pausedQueue;
    this.pausedQueue = {steering: [], followUp: []};
    for (const text of held.steering) await this.session.steer(text);
    for (const text of held.followUp) await this.session.followUp(text);
    return this.session.prompt(message);
  }
  // Since pi 0.99 steer()/followUp() report whether the message reached the running turn (`handled`)
  // or waits for it (`queued`); the web composer shows that difference instead of guessing.
  async steer(message: string): Promise<QueuedInputDisposition> {
    return normalizeDisposition(await this.session.steer(message));
  }
  async followUp(message: string): Promise<QueuedInputDisposition> {
    return normalizeDisposition(await this.session.followUp(message));
  }
  async getQueue(): Promise<AgentQueue> {
    return {
      steering: [...this.pausedQueue.steering, ...this.session.getSteeringMessages()],
      followUp: [...this.pausedQueue.followUp, ...this.session.getFollowUpMessages()]
    };
  }
  /** Drop queued steering and follow-up messages and hand them back so a client can restore them to its composer. */
  async clearQueue(): Promise<AgentQueue> {
    const held = this.pausedQueue;
    this.pausedQueue = {steering: [], followUp: []};
    const cleared = this.session.clearQueue();
    return {
      steering: [...held.steering, ...cleared.steering],
      followUp: [...held.followUp, ...cleared.followUp]
    };
  }
  async moveQueue(from: keyof AgentQueue, index: number, expected: string): Promise<AgentQueue> {
    const before = {
      steering: [...this.session.getSteeringMessages()],
      followUp: [...this.session.getFollowUpMessages()]
    };
    if (!this.session.isStreaming || before[from][index] !== expected)
      throw Object.assign(new Error('Queued message has changed or already been consumed'), {
        code: 'QUEUE_CHANGED'
      });
    const to = from === 'steering' ? 'followUp' : 'steering';
    before[from].splice(index, 1);
    before[to].push(expected);
    if ([...before.steering, ...before.followUp].some(text => text.startsWith('/')))
      throw Object.assign(new Error('Slash commands cannot be moved safely'), {code: 'QUEUE_CHANGED'});
    // Pi exposes clearQueue(), but no per-message move. Clear and requeue in the same JS turn:
    // steer()/followUp() enqueue synchronously before their promises settle. No model callback can
    // drain the half-updated queue between these calls. Never replace a stale queue by index alone.
    this.session.clearQueue();
    const pending = [
      ...before.steering.map(text => this.session.steer(text)),
      ...before.followUp.map(text => this.session.followUp(text))
    ];
    await Promise.all(pending);
    return this.getQueue();
  }
  abort() {
    return this.session.abort();
  }
  async getState(): Promise<AgentState> {
    return {
      agentId: this.agentId,
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
      sessionName: this.session.sessionName,
      cwd: this.cwd,
      status: this.disposed ? 'stopped' : this.session.isStreaming ? 'streaming' : 'idle'
    };
  }
  timeline(): TimelineSource {
    const manager = this.session.sessionManager;
    return {
      sessionId: this.session.sessionId,
      leafId: manager.getLeafId(),
      entries: () => manager.getBranch() as unknown as TimelineEntry[]
    };
  }
  /** The effective system prompt Pi will send next, plus the prompt files that contributed to it. */
  async getSystemPrompt() {
    const loader = this.session.resourceLoader;
    return {
      systemPrompt: this.session.systemPrompt,
      systemFile: loader.getSystemPromptSource()?.path,
      appendFiles: loader.getAppendSystemPromptSources().map(source => source.path),
      contextFiles: loader.getAgentsFiles().agentsFiles.map(file => file.path)
    };
  }
  async getCapabilities() {
    const current = this.session.model as any;
    // ModelRuntime.getAvailable() is async since 0.80.8 and may consult provider auth; the snapshot keeps
    // an unauthenticated or offline call from blocking the capabilities endpoint.
    const available = await this.session.modelRuntime
      .getAvailable()
      .catch(() => this.session.modelRuntime.getAvailableSnapshot());
    return {
      model: current ? this.modelInfo(current) : null,
      models: available.map((model: any) => this.modelInfo(model)),
      thinkingLevel: this.session.thinkingLevel,
      thinkingLevels: this.session.getAvailableThinkingLevels(),
      supportsThinking: this.session.supportsThinking()
    };
  }
  /** Slash commands the composer can offer: file-based prompt templates and skills discovered for this cwd. */
  async listCommands() {
    const loader = this.session.resourceLoader;
    const prompts = loader.getPrompts().prompts.map(prompt => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: 'prompt' as const
    }));
    const skills = loader.getSkills().skills.map(skill => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: 'skill' as const
    }));
    return [...prompts, ...skills].sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Run a command inside the Agent session so its output is recorded in the transcript (`!!` keeps it out of the model context). */
  async runBash(command: string, excludeFromContext = false) {
    const id = randomUUID();
    this.events.emit('event', {type: 'bash_execution_start', id, command});
    try {
      const result = await this.session.executeBash(command, undefined, {excludeFromContext, id});
      this.events.emit('event', {type: 'bash_execution_end', id, command, ...result});
      return {id, ...result};
    } catch (error) {
      this.events.emit('event', {
        type: 'bash_execution_end',
        id,
        command,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  abortBash() {
    this.session.abortBash();
  }
  async getSession() {
    return {
      ...(await this.getSessionInfo()),
      leafId: this.session.sessionManager.getLeafId(),
      entries: this.session.sessionManager.getEntries(),
      tree: this.session.sessionManager.getTree(),
      userMessages: this.session.getUserMessagesForForking()
    };
  }
  async getSessionInfo() {
    return {
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
      sessionName: this.session.sessionName,
      stats: this.session.getSessionStats(),
      contextUsage: this.session.getContextUsage()
    };
  }
  compact(instructions?: string) {
    return this.session.compact(instructions);
  }
  async setModel(provider: string, modelId: string) {
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw Object.assign(new Error('Model not found'), {code: 'MODEL_NOT_FOUND'});
    await this.session.setModel(model);
  }
  async setThinkingLevel(level: string) {
    if (level !== 'off' && !this.session.getAvailableThinkingLevels().includes(level as any))
      throw Object.assign(new Error('Invalid thinking level'), {code: 'INVALID_THINKING_LEVEL'});
    this.session.setThinkingLevel(level as any);
  }
  async setSessionName(name: string) {
    const value = name.trim();
    if (!value || value.length > 200)
      throw Object.assign(new Error('Session name must be 1-200 characters'), {code: 'INVALID_SESSION_NAME'});
    this.session.setSessionName(value);
  }
  navigate(entryId: string) {
    return this.session.navigateTree(entryId);
  }
  async fork(entryId: string) {
    const entry: any = this.session.sessionManager.getEntry(entryId);
    if (!entry || entry.type !== 'message' || entry.message?.role !== 'user')
      throw Object.assign(new Error('A user message entry is required'), {code: 'SESSION_ENTRY_NOT_FOUND'});
    const content = entry.message.content;
    const selectedText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((part: any) => part.type === 'text')
              .map((part: any) => part.text)
              .join('\n')
          : '';
    let sessionFile: string | undefined;
    if (entry.parentId) {
      sessionFile = this.session.sessionManager.createBranchedSession(entry.parentId);
    } else {
      const current = this.session.sessionFile;
      if (!current)
        throw Object.assign(new Error('Session persistence is disabled'), {code: 'SESSION_NOT_PERSISTED'});
      sessionFile = SessionManager.create(this.cwd, this.session.sessionManager.getSessionDir(), {
        parentSession: current
      }).getSessionFile();
    }
    return {sessionFile, selectedText};
  }
  async extensionResponse(requestId: string, value: unknown) {
    if (!this.resolveUiRequest(requestId, value))
      throw Object.assign(new Error('Extension UI request not found'), {code: 'EXTENSION_REQUEST_NOT_FOUND'});
  }
  subscribe(listener: (event: AgentEvent) => void) {
    // A paused run settles like a finished one; notifications must not report it as completed.
    const fromSession = (event: unknown) =>
      listener(
        (event as AgentEvent).type === 'agent_settled' && this.settledPaused
          ? {...(event as AgentEvent), paused: true}
          : (event as AgentEvent)
      );
    const unsubscribe = this.session.subscribe(fromSession);
    this.events.on('event', listener);
    return () => {
      unsubscribe();
      this.events.off('event', listener);
    };
  }
  async dispose() {
    if (this.disposed) return;
    for (const requestId of this.pendingUi.keys()) this.resolveUiRequest(requestId, undefined);
    await this.session.abort();
    this.session.dispose();
    this.disposed = true;
  }
  private modelInfo(model: any) {
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: !!model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    };
  }
  private resolveUiRequest(requestId: string, value: unknown) {
    const pending = this.pendingUi.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingUi.delete(requestId);
    // Publish before resuming the extension: every client sees the same order,
    // including requests answered elsewhere, timed out, or closed during disposal.
    this.events.emit('event', {type: 'extension_ui_response', requestId});
    pending.resolve(value);
    return true;
  }
  private request(kind: string, payload: Record<string, unknown>): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.resolveUiRequest(requestId, undefined), 5 * 60_000);
      this.pendingUi.set(requestId, {resolve, timer});
      this.events.emit('event', {type: 'extension_ui_request', requestId, kind, ...payload});
    });
  }
  private extensionUi(): ExtensionUIContext {
    return {
      select: async (title: string, options: string[], opts: unknown) =>
        (await this.request('select', {title, options, opts})) as string | undefined,
      confirm: async (title: string, message: string, opts: unknown) =>
        Boolean(await this.request('confirm', {title, message, opts})),
      input: async (title: string, placeholder: string | undefined, opts: unknown) =>
        (await this.request('input', {title, placeholder, opts})) as string | undefined,
      editor: async (title: string, prefill: string | undefined) =>
        (await this.request('editor', {title, prefill})) as string | undefined,
      notify: (message: string, type: string | undefined) =>
        this.events.emit('event', {type: 'extension_ui_notify', message, notificationType: type ?? 'info'}),
      setStatus: (key: string, text: string | undefined) =>
        this.events.emit('event', {type: 'extension_ui_status', key, text}),
      setWidget: (key: string, content: unknown, options: unknown) =>
        this.events.emit('event', {
          type: 'extension_ui_widget',
          key,
          content: Array.isArray(content) ? content : undefined,
          options
        }),
      setTitle: (title: string) => this.events.emit('event', {type: 'extension_ui_title', title}),
      setWorkingMessage: (message: string | undefined) =>
        this.events.emit('event', {type: 'extension_ui_working_message', message}),
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      onTerminalInput: () => () => {},
      setFooter: () => {},
      setHeader: () => {},
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      custom: async () => {
        throw Object.assign(new Error('Custom extension components are unsupported'), {
          code: 'EXTENSION_CUSTOM_UI_UNSUPPORTED'
        });
      }
    } as unknown as ExtensionUIContext;
  }
}
export const createSdkBackend = (
  agentId: string,
  cwd: string,
  sessionFile?: string,
  profile: AgentProfile = 'default',
  collabBridge?: CollabToolBridge,
  options: BackendOptions = {}
) => SdkBackend.create(agentId, cwd, sessionFile, profile, collabBridge, options);
