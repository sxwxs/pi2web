import type {AgentEvent} from './agents.js';
import type {ToolRuntime} from './activity.js';
import {buildTimeline, contentText, type TimelineEntry, type TimelineItem} from './timeline.js';

/** What a backend exposes of its session for the timeline. */
export type TimelineSource = {sessionId: string; leafId: string | null; entries(): TimelineEntry[]};

/**
 * Messages for clients viewing one Agent in detail. Timeline changes (`items`, `timeline_reset`)
 * carry consecutive versions; GET /timeline returns the version its page is at, so a client
 * applies exactly the changes after it, and reloads if it ever sees a gap.
 */
export type DetailMessage =
  /** Streamed text of the assistant message being generated. */
  | {type: 'delta'; kind: 'text' | 'thinking'; delta: string}
  /**
   * `items` were appended to the timeline; `updated` replace items published before (a running
   * tool finished), which a client may not have loaded. `clearLive` drops the streamed text
   * the appended items replace.
   */
  | {
      type: 'items';
      sessionId: string;
      version: number;
      items: TimelineItem[];
      updated?: TimelineItem[];
      clearLive?: true;
    }
  /** The branch changed in a way that is not an append (navigation, new session): reload the timeline. */
  | {type: 'timeline_reset'; sessionId: string; version: number}
  /** Latest output of a running tool. Sockets forward it only for tools a client has expanded. */
  | {type: 'tool_output'; toolCallId: string; output: string}
  /** Events only the focused view renders, such as user shell command output. */
  | {type: 'event'; event: AgentEvent};

type Published = {
  sessionId: string;
  leafId: string | null;
  /** Running tools change how unfinished calls display, without moving the leaf. */
  runtime: string;
  ids: string[];
  /** Tool calls without a result: the only items that change after they appear. */
  unresolved: Map<string, string>;
};
const signature = (item: TimelineItem) => JSON.stringify(item);
const runtimeKey = (runtime: ToolRuntime) => JSON.stringify([runtime.active, [...runtime.running].sort()]);
const NO_RUNTIME = (): ToolRuntime => ({active: false, running: new Set()});

/**
 * Turns one backend's raw events into the detail stream. The timeline itself is never
 * streamed as events: after any event, if the session's leaf moved, the branch is projected
 * again and only new items and items whose status changed are published.
 */
export class AgentFeed {
  private published: Published;
  private version = 0;
  private live = {active: false, text: '', thinking: ''};
  private clearLive = false;
  private outputs = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly source: () => TimelineSource,
    private readonly emit: (message: DetailMessage) => void,
    private readonly runtime: () => ToolRuntime = NO_RUNTIME
  ) {
    this.published = this.project().published;
  }

  /** Text streamed so far for the message being generated, for clients that start watching mid-stream. */
  liveState() {
    const {active, text, thinking} = this.live;
    return active || text || thinking ? {text, thinking} : null;
  }
  sessionId() {
    return this.published.sessionId;
  }
  /** Version of the last published timeline change. Call sync() first to include unpublished ones. */
  currentVersion() {
    return this.version;
  }
  output(toolCallId: string) {
    return this.outputs.get(toolCallId);
  }

  handle(event: AgentEvent) {
    const e = event as any;
    switch (event.type) {
      case 'message_start':
        if (e.message?.role === 'assistant' || e.role === 'assistant') {
          // The previous message is persisted by now; publish it before streaming the next.
          this.sync();
          this.live = {active: true, text: '', thinking: ''};
        }
        break;
      case 'message_update': {
        const update = e.assistantMessageEvent;
        if (
          (update?.type === 'text_delta' || update?.type === 'thinking_delta') &&
          typeof update.delta === 'string'
        ) {
          const kind = update.type === 'text_delta' ? 'text' : 'thinking';
          this.live[kind] += update.delta;
          this.emit({type: 'delta', kind, delta: update.delta});
        }
        return; // Deltas never change the persisted timeline.
      }
      case 'message_end':
        if (this.live.active) {
          this.live.active = false;
          this.clearLive = true;
        }
        break;
      case 'tool_execution_update':
        if (!e.parentToolCallId && typeof e.toolCallId === 'string') {
          const result = e.partialResult,
            output = contentText(result?.content ?? result) || (result ? JSON.stringify(result) : '');
          this.outputs.set(e.toolCallId, output);
          this.emit({type: 'tool_output', toolCallId: e.toolCallId, output});
        }
        return;
      case 'tool_execution_end':
        this.outputs.delete(String(e.toolCallId));
        break;
      case 'bash_execution_start':
      case 'bash_execution_update':
      case 'bash_execution_end':
        this.emit({type: 'event', event});
        break;
    }
    this.schedule();
  }

  /** Pi persists a message right after notifying listeners of it, so look once the event has finished. */
  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sync();
    }, 0);
  }

  /** Publish what changed on the timeline since the last call. Cheap when nothing was appended. */
  sync() {
    if (this.closed) return;
    const source = this.source(),
      runtime = this.runtime(),
      previous = this.published;
    if (
      source.sessionId === previous.sessionId &&
      source.leafId === previous.leafId &&
      runtimeKey(runtime) === previous.runtime &&
      !this.clearLive
    )
      return;
    const {published, records, entries} = this.project(source, runtime);
    this.published = published;
    // Append-only means the old leaf is still on the branch. Same item ids are not enough: moving
    // back from a tool's result to its call keeps every id but takes the result away.
    const appended =
      (previous.leafId === null || entries.some(entry => entry.id === previous.leafId)) &&
      previous.ids.length <= published.ids.length &&
      previous.ids.every((id, i) => published.ids[i] === id);
    if (source.sessionId !== previous.sessionId || !appended) {
      this.clearLive = false;
      this.emit({type: 'timeline_reset', sessionId: source.sessionId, version: ++this.version});
      return;
    }
    const items = records.slice(previous.ids.length).map(r => r.item),
      updated = records
        .slice(0, previous.ids.length)
        .map(r => r.item)
        .filter(
          item => previous.unresolved.has(item.id) && previous.unresolved.get(item.id) !== signature(item)
        );
    if (!items.length && !updated.length && !this.clearLive) return;
    const message: DetailMessage = {
      type: 'items',
      sessionId: source.sessionId,
      version: ++this.version,
      items
    };
    if (updated.length) message.updated = updated;
    if (this.clearLive) {
      message.clearLive = true;
      this.clearLive = false;
      this.live = {active: false, text: '', thinking: ''};
    }
    this.emit(message);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private project(source = this.source(), runtime = this.runtime()) {
    const entries = source.entries(),
      records = buildTimeline(entries, runtime),
      published: Published = {
        sessionId: source.sessionId,
        leafId: source.leafId,
        runtime: runtimeKey(runtime),
        ids: records.map(r => r.item.id),
        unresolved: new Map(
          records
            .filter(
              r =>
                r.item.kind === 'tool' && !r.item.rev && r.item.status !== 'ok' && r.item.status !== 'error'
            )
            .map(r => [r.item.id, signature(r.item)])
        )
      };
    return {published, records, entries};
  }
}
