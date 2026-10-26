import type {AgentEvent} from './agents.js';
import {buildTimeline, contentText, pageTimeline, type TimelineEntry, type TimelineItem} from './timeline.js';

/** What a backend exposes of its session for the timeline. */
export type TimelineSource = {sessionId: string; leafId: string | null; entries(): TimelineEntry[]};

/**
 * Messages for clients viewing one Agent in detail. A client starts from snapshot(), taken
 * synchronously when it subscribes, so every message after it is new to the client and needs
 * no numbering: items only ever append, and anything else is a reset.
 */
export type DetailMessage =
  /** Streamed text of the assistant message being generated. */
  | {type: 'delta'; kind: 'text' | 'thinking'; delta: string}
  /** Items appended to the timeline. `clearLive`: they record the streamed message, drop its text. */
  | {type: 'items'; sessionId: string; items: TimelineItem[]; clearLive?: true}
  /** The branch changed other than by appending (rewind, new session): take a new snapshot. */
  | {type: 'timeline_reset'; sessionId: string}
  /** Output so far of a running tool. Sockets forward it only for tools a client has expanded. */
  | {type: 'tool_output'; toolCallId: string; output: string}
  /** Events only the focused view renders, such as user shell command output. */
  | {type: 'event'; event: AgentEvent};

type Published = {sessionId: string; leafId: string | null; ids: string[]};

/**
 * Turns one backend's raw events into the detail stream. After any event, if the session's
 * leaf moved, the branch is projected again and the items after the published ones are sent.
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

  /**
   * Everything a client needs to start viewing: the newest page and the text streamed so far.
   * Publishes pending changes first, so the next message a subscriber gets is newer than this.
   */
  snapshot(limit?: number) {
    this.sync();
    const source = this.source(),
      {active, text, thinking} = this.live;
    return {
      sessionId: source.sessionId,
      page: pageTimeline(buildTimeline(source.entries()), limit)!,
      live: active || text || thinking ? {text, thinking} : null
    };
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

  /** Publish what changed on the timeline since the last call. Cheap when the leaf did not move. */
  sync() {
    if (this.closed) return;
    const source = this.source(),
      previous = this.published;
    if (source.sessionId === previous.sessionId && source.leafId === previous.leafId && !this.clearLive)
      return;
    const {published, records, entries} = this.project(source);
    this.published = published;
    // An append keeps the old leaf on the branch and every item published so far.
    const appended =
      source.sessionId === previous.sessionId &&
      (previous.leafId === null || entries.some(entry => entry.id === previous.leafId)) &&
      previous.ids.every((id, i) => published.ids[i] === id);
    const clearLive = this.clearLive;
    this.clearLive = false;
    if (clearLive) this.live = {active: false, text: '', thinking: ''};
    if (!appended) {
      this.emit({type: 'timeline_reset', sessionId: source.sessionId});
      return;
    }
    const items = records.slice(previous.ids.length).map(r => r.item);
    if (!items.length && !clearLive) return;
    this.emit({
      type: 'items',
      sessionId: source.sessionId,
      items,
      ...(clearLive ? {clearLive: true as const} : {})
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private project(source = this.source()) {
    const entries = source.entries(),
      records = buildTimeline(entries);
    return {
      published: {sessionId: source.sessionId, leafId: source.leafId, ids: records.map(r => r.item.id)},
      records,
      entries
    };
  }
}
