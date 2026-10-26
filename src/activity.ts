import type {AgentEvent} from './agents.js';

/** What the Agent's current run is doing right now. Times are server epoch milliseconds. */
export type ActivityPhase =
  | {kind: 'idle'; since: number}
  /** Request sent, no token received yet. */
  | {kind: 'waiting_llm'; since: number}
  | {kind: 'thinking'; since: number}
  | {kind: 'generating'; since: number}
  /** The model is writing a tool call's arguments (e.g. a whole file for `write`). */
  | {kind: 'preparing_tool'; since: number; toolName?: string}
  | {kind: 'running_tools'; since: number; tools: RunningTool[]}
  | {
      kind: 'retrying';
      since: number;
      attempt?: number;
      maxAttempts?: number;
      retryAt?: number;
      error?: string;
    }
  | {kind: 'compacting'; since: number; reason?: string}
  | {kind: 'stopping'; since: number};
export type RunningTool = {toolCallId: string; toolName: string; summary?: string; since: number};
export type Activity = {
  /** The current LLM run, from agent_start until it ends. */
  run: {startedAt: number} | null;
  phase: ActivityPhase;
  /** User `!` shell commands; independent of runs. */
  bash: Array<{id: string; command?: string; since: number}>;
  /** Extension dialogs waiting for a human answer; independent of runs. */
  dialogs: Array<{requestId: string; title?: string; since: number}>;
};

const SUMMARY_LIMIT = 80;
const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url'];

/** A one-line hint of what a tool call works on: its command, path, pattern... */
export function toolSummary(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const value =
    SUMMARY_KEYS.map(key => record[key]).find(v => typeof v === 'string' && v.trim()) ??
    Object.values(record).find(v => typeof v === 'string' && v.trim());
  if (typeof value !== 'string') return undefined;
  const line = value.trim().replace(/\s+/g, ' ');
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Server-side state machine over raw Pi events. It is the single source of truth for
 * "what is this Agent doing and since when", so any client can show it at any time,
 * including after switching sessions, reloading or reconnecting.
 */
export class ActivityTracker {
  private state: Activity;
  constructor(private readonly now: () => number = Date.now) {
    this.state = {run: null, phase: {kind: 'idle', since: now()}, bash: [], dialogs: []};
  }

  snapshot(): Activity {
    return structuredClone(this.state);
  }

  /** Forget everything, e.g. when the backend is unloaded. Returns whether anything changed. */
  reset() {
    const s = this.state;
    if (!s.run && s.phase.kind === 'idle' && !s.bash.length && !s.dialogs.length) return false;
    this.state = {run: null, phase: {kind: 'idle', since: this.now()}, bash: [], dialogs: []};
    return true;
  }

  /** The user asked to abort the current run. */
  stopping() {
    if (!this.state.run || this.state.phase.kind === 'stopping') return false;
    return this.setPhase({kind: 'stopping'});
  }

  /** Apply one raw Pi event. Returns whether the activity changed, so callers publish only real changes. */
  apply(event: AgentEvent): boolean {
    const e = event as any,
      s = this.state;
    switch (event.type) {
      case 'agent_start': {
        const startedRun = !s.run;
        if (startedRun) s.run = {startedAt: this.now()};
        return this.setPhase({kind: 'waiting_llm'}) || startedRun;
      }
      case 'turn_start':
        return this.setPhase({kind: 'waiting_llm'});
      case 'message_update': {
        const update = e.assistantMessageEvent,
          type = str(update?.type);
        if (type === 'thinking_start' || type === 'thinking_delta') return this.setPhase({kind: 'thinking'});
        if (type === 'text_start' || type === 'text_delta') return this.setPhase({kind: 'generating'});
        if (type === 'toolcall_start' || type === 'toolcall_delta') {
          const toolName = str(update.partial?.content?.[update.contentIndex]?.name);
          // The name may only arrive with a later delta: fill it in without restarting the timer.
          if (s.phase.kind === 'preparing_tool' && !s.phase.toolName && toolName) {
            s.phase.toolName = toolName;
            return true;
          }
          return this.setPhase({kind: 'preparing_tool', ...(toolName ? {toolName} : {})});
        }
        return false;
      }
      case 'tool_execution_start': {
        // Tools called by other tools run inside their caller's time; show only top-level calls.
        if (e.parentToolCallId) return false;
        const tool: RunningTool = {
          toolCallId: String(e.toolCallId ?? ''),
          toolName: str(e.toolName) ?? 'tool',
          summary: toolSummary(e.args),
          since: this.now()
        };
        if (s.phase.kind === 'running_tools') {
          s.phase.tools.push(tool);
          return true;
        }
        return this.setPhase({kind: 'running_tools', tools: [tool]});
      }
      case 'tool_execution_end': {
        if (e.parentToolCallId || s.phase.kind !== 'running_tools') return false;
        const tools = s.phase.tools.filter(tool => tool.toolCallId !== e.toolCallId);
        if (tools.length === s.phase.tools.length) return false;
        if (tools.length) {
          s.phase.tools = tools;
          return true;
        }
        return this.setPhase({kind: 'waiting_llm'});
      }
      case 'auto_retry_start': {
        if (!s.run) s.run = {startedAt: this.now()};
        const delay = num(e.delayMs);
        return this.setPhase(
          {
            kind: 'retrying',
            attempt: num(e.attempt),
            maxAttempts: num(e.maxAttempts),
            retryAt: delay === undefined ? undefined : this.now() + delay,
            error: str(e.errorMessage)
          },
          true
        );
      }
      case 'compaction_start':
        return this.setPhase({kind: 'compacting', reason: str(e.reason)});
      case 'compaction_end':
        return this.setPhase({kind: s.run ? 'waiting_llm' : 'idle'});
      case 'agent_end':
        if (e.willRetry === true) return false;
        return this.endRun();
      case 'agent_settled':
        return this.endRun();
      case 'bash_execution_start':
      case 'bash_execution_update': {
        const id = str(e.id);
        if (!id || s.bash.some(b => b.id === id)) return false;
        s.bash.push({id, command: str(e.command), since: this.now()});
        return true;
      }
      case 'bash_execution_end': {
        const before = s.bash.length;
        s.bash = s.bash.filter(b => b.id !== e.id);
        return s.bash.length !== before;
      }
      case 'extension_ui_request': {
        const requestId = str(e.requestId);
        if (!requestId || s.dialogs.some(d => d.requestId === requestId)) return false;
        s.dialogs.push({requestId, title: str(e.title) ?? str(e.message), since: this.now()});
        return true;
      }
      case 'extension_ui_response': {
        const before = s.dialogs.length;
        s.dialogs = s.dialogs.filter(d => d.requestId !== e.requestId);
        return s.dialogs.length !== before;
      }
      default:
        return false;
    }
  }

  private endRun() {
    const hadRun = !!this.state.run;
    this.state.run = null;
    // Compaction may continue after the run has ended; agent_settled will close it.
    if (this.state.phase.kind === 'compacting') return hadRun;
    return this.setPhase({kind: 'idle'}) || hadRun;
  }

  /**
   * Enter a phase. Staying in the same phase keeps its start time, so a stream of deltas
   * neither resets the timer nor counts as a change. `force` restarts it (e.g. each retry).
   */
  private setPhase(next: Record<string, unknown> & {kind: ActivityPhase['kind']}, force = false) {
    const current = this.state.phase as Record<string, unknown>;
    if (!force && current.kind === next.kind && Object.keys(next).every(key => current[key] === next[key]))
      return false;
    const phase = {...next, since: this.now()} as Record<string, unknown>;
    for (const key of Object.keys(phase)) if (phase[key] === undefined) delete phase[key];
    this.state.phase = phase as ActivityPhase;
    return true;
  }
}
