import type {AgentEvent} from './agents.js';
import {buildTimeline, contentText, type TimelineEntry, type TimelineItem} from './timeline.js';

/** What a backend exposes of its session for the timeline. */
export type TimelineSource = {sessionId: string; leafId: string | null; entries(): TimelineEntry[]};

/** Messages for clients viewing one Agent in detail. */
export type DetailMessage =
  /** Streamed text of the assistant message being generated. */
  | {type: 'delta'; kind: 'text' | 'thinking'; delta: string}
  /** New items, and items whose status changed. `clearLive` drops the streamed text they replace. */
  | {type: 'items'; sessionId: string; items: TimelineItem[]; clearLive?: true}
  /** The branch changed in a way that is not an append (navigation, new session): reload the timeline. */
  | {type: 'timeline_reset'; sessionId: string}
  /** Latest output of a running tool. Sockets forward it only for tools a client has expanded. */
  | {type: 'tool_output'; toolCallId: string; output: string}
  /** Events only the focused view renders, such as user shell command output. */
  | {type: 'event'; event: AgentEvent};

type Published = {sessionId: string; leafId: string | null; ids: string[]; pending: Map<string, string>};
const signature = (item: TimelineItem) => JSON.stringify(item);

/**
 * Turns one backend's raw events into the detail stream. The timeline itself is never
 * streamed as events: after any event, if the session's leaf moved, the branch is projected
 * again and only new items and items whose status changed are published.
 */
export class AgentFeed {
  private published: Published;
  private live = {active: false, text: '', thinking: ''};
  private clearLive = false;
  private outputs = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly source: () => TimelineSource,
    private readonly emit: (message: DetailMessage) => void
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
      previous = this.published;
    if (source.sessionId === previous.sessionId && source.leafId === previous.leafId && !this.clearLive)
      return;
    const {published, records} = this.project(source);
    this.published = published;
    const appended =
      previous.ids.length <= published.ids.length && previous.ids.every((id, i) => published.ids[i] === id);
    if (source.sessionId !== previous.sessionId || !appended) {
      this.clearLive = false;
      this.emit({type: 'timeline_reset', sessionId: source.sessionId});
      return;
    }
    const known = new Set(previous.ids),
      changed = records
        .map(r => r.item)
        .filter(
          item =>
            !known.has(item.id) ||
            (previous.pending.has(item.id) && previous.pending.get(item.id) !== signature(item))
        );
    if (!changed.length && !this.clearLive) return;
    const message: DetailMessage = {type: 'items', sessionId: source.sessionId, items: changed};
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

  private project(source = this.source()) {
    const records = buildTimeline(source.entries()),
      published: Published = {
        sessionId: source.sessionId,
        leafId: source.leafId,
        ids: records.map(r => r.item.id),
        // Only running tools change after they appear; remember them to detect when they finish.
        pending: new Map(
          records.filter(r => r.item.status === 'pending').map(r => [r.item.id, signature(r.item)])
        )
      };
    return {published, records};
  }
}
