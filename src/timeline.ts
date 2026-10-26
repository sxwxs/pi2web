import {toolSummary} from './activity.js';

/**
 * The Web UI's view of a session: the current branch's persisted entries projected into
 * display items.
 *
 * Invariant: an item is derived from exactly one entry (or one part of an assistant entry), and
 * entries never change, so neither does an item. A tool call and its result are separate entries
 * and therefore separate items; the client shows them as one card. Whether a call is executing is
 * not part of any item: it is the Agent's activity.
 */
export type TimelineEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
};
export type ItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'error'
  | 'tool_call'
  | 'tool_result'
  | 'bash'
  | 'compaction'
  | 'branch_summary'
  | 'custom'
  | 'system';
export type TimelineItem = {
  id: string;
  kind: ItemKind;
  /** Epoch milliseconds. */
  timestamp?: number;
  /** Tool name, shell command, or what a system item is. */
  title?: string;
  /** One line describing the item: a tool's command or path, an exit code, or a preview of a large body. */
  summary?: string;
  /** tool_result and bash: how it ended. */
  status?: 'ok' | 'error' | 'cancelled';
  durationMs?: number;
  /** tool_call and tool_result: pairs them, and names a running call to watch. */
  toolCallId?: string;
  /** Length of the full body in characters. */
  size: number;
  /** The full body, present for the kinds people read linearly and for small bodies. */
  body?: string;
};
type ItemRecord = {item: TimelineItem; body: () => string};

/**
 * Bodies of collapsed kinds (tools, thinking...) up to this many characters travel with the
 * timeline; larger ones load when expanded. Tool calls and results are 90% of a session's bytes
 * and rarely opened, so this is kept small.
 */
export const INLINE_LIMIT = 256;
const ALWAYS_INLINE = new Set<ItemKind>(['user', 'assistant', 'error']);
const PREVIEW_LIMIT = 160;

const memos = new WeakMap<object, unknown>();
/** Entries never change, so anything derived from one entry object can be computed once. */
function memo<T>(key: object, compute: () => T): T {
  if (!memos.has(key)) memos.set(key, compute());
  return memos.get(key) as T;
}

/** Text of message content: strings, text parts, and a marker per image. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) =>
      part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[image]' : ''
    )
    .filter(Boolean)
    .join('\n');
}

/** A failed provider response: Pi persists it as an assistant message with stopReason "error". */
function assistantError(message: any) {
  if (message?.stopReason !== 'error' && !message?.errorMessage) return '';
  const detail = String(message.errorMessage || 'LLM request failed').trim(),
    source = [message.provider, message.model].filter(Boolean).join(' · ');
  return source ? `${detail}\n\n${source}` : detail;
}

const preview = (text: string) => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT - 1)}…` : line;
};
const timeOf = (message: any, entry: TimelineEntry) => {
  const value = Number(message?.timestamp);
  if (Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(entry.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
};

function record(item: Omit<TimelineItem, 'size' | 'body'>, size: number, body: () => string): ItemRecord {
  const full: TimelineItem = {...item, size};
  if (ALWAYS_INLINE.has(item.kind) || size <= INLINE_LIMIT) full.body = body();
  else if (!full.summary) full.summary = preview(body());
  for (const key of Object.keys(full) as (keyof TimelineItem)[])
    if (full[key] === undefined) delete full[key];
  return {item: full, body};
}

const NESTED_MARK: Record<string, string> = {ok: '✓', error: '✗', unfinished: '⊘'};
/** Calls the tool made to other tools (codemode scripts, MCP batches), one line each. */
function nestedText(nested: any) {
  const calls = Array.isArray(nested?.calls) ? nested.calls : [];
  if (!calls.length) return '';
  const lines = calls.map((call: any) => {
    const target = toolSummary(call.arguments),
      duration = Number.isFinite(call.durationMs) ? ` · ${call.durationMs} ms` : '';
    return `${NESTED_MARK[call.status] ?? '•'} ${call.name}${target ? `: ${target}` : ''}${duration}${call.error ? ` · ${call.error}` : ''}`;
  });
  return `\n\n— 嵌套调用（${calls.length}${nested.complete === false ? '，不完整' : ''}）—\n${lines.join('\n')}`;
}

function text(id: string, kind: ItemKind, value: string, item: Partial<TimelineItem> = {}) {
  return record({id, kind, ...item}, value.length, () => value);
}

/** The items of one entry, computed once per entry object. */
function entryItems(entry: TimelineEntry): ItemRecord[] {
  return memo(entry, () => {
    const e = entry as any,
      at = timeOf(undefined, entry);
    if (entry.type === 'compaction')
      return [
        text(entry.id, 'compaction', String(e.summary ?? ''), {
          timestamp: at,
          title: '上下文已压缩',
          summary: Number.isFinite(e.tokensBefore) ? `压缩前 ${e.tokensBefore} tokens` : undefined
        })
      ];
    if (entry.type === 'branch_summary')
      return [text(entry.id, 'branch_summary', String(e.summary ?? ''), {timestamp: at, title: '分支摘要'})];
    if (entry.type === 'custom_message')
      return e.display
        ? [
            text(entry.id, 'custom', contentText(e.content), {
              timestamp: at,
              title: String(e.customType ?? 'custom')
            })
          ]
        : [];
    if (entry.type !== 'message') return [];
    const message = e.message,
      role = message?.role,
      timestamp = timeOf(message, entry);
    if (role === 'user' || role === 'system') {
      const value = contentText(message.content);
      return value ? [text(entry.id, role, value, {timestamp})] : [];
    }
    if (role === 'bashExecution')
      return [
        text(entry.id, 'bash', String(message.output ?? ''), {
          timestamp,
          title: String(message.command ?? ''),
          summary: message.cancelled
            ? '已取消'
            : message.exitCode === undefined
              ? undefined
              : `exit ${message.exitCode}${message.truncated ? ' · 输出已截断' : ''}`,
          status: message.cancelled ? 'cancelled' : Number(message.exitCode) > 0 ? 'error' : 'ok'
        })
      ];
    if (role === 'toolResult')
      return [
        text(
          entry.id,
          'tool_result',
          (contentText(message.content) || (message.isError ? '执行失败' : '执行完成')) +
            nestedText(message.nestedCalls),
          {
            timestamp,
            title: String(message.toolName ?? 'tool'),
            status: message.isError ? 'error' : 'ok',
            durationMs: Number.isFinite(message.durationMs) ? message.durationMs : undefined,
            toolCallId: String(message.toolCallId ?? '')
          }
        )
      ];
    if (role !== 'assistant') return [];
    const items: ItemRecord[] = [];
    (Array.isArray(message.content) ? message.content : []).forEach((part: any, index: number) => {
      const id = `${entry.id}.${index}`;
      if (part?.type === 'text' && part.text)
        items.push(text(id, 'assistant', String(part.text), {timestamp}));
      else if (part?.type === 'thinking' && (part.thinking || part.text))
        items.push(text(id, 'thinking', String(part.thinking || part.text), {timestamp}));
      else if (part?.type === 'toolCall') {
        const args = part.arguments;
        items.push(
          text(
            id,
            'tool_call',
            args && typeof args === 'object' && Object.keys(args).length ? JSON.stringify(args, null, 2) : '',
            {
              timestamp,
              title: String(part.name ?? 'tool'),
              summary: toolSummary(args),
              toolCallId: String(part.id ?? '')
            }
          )
        );
      }
    });
    const error = assistantError(message);
    if (error) items.push(text(`${entry.id}.error`, 'error', error, {timestamp}));
    return items;
  });
}

/** Project a branch (root to leaf) into display items. */
export function buildTimeline(entries: TimelineEntry[]): ItemRecord[] {
  return entries.flatMap(entryItems);
}

export type TimelinePage = {items: TimelineItem[]; total: number; start: number; hasMore: boolean};

/**
 * About `limit` items before `before` (or the newest ones). A page never splits a tool call from its
 * result: it starts early enough to include the calls of the results it holds. Undefined when
 * `before` is not on the timeline.
 */
export function pageTimeline(records: ItemRecord[], limit = 50, before?: string): TimelinePage | undefined {
  const size = Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 50)),
    end = before === undefined ? records.length : records.findIndex(r => r.item.id === before);
  if (end < 0) return undefined;
  let start = Math.max(0, end - size);
  const callIndex = new Map<string, number>();
  records.slice(0, end).forEach((r, index) => {
    if (r.item.kind === 'tool_call') callIndex.set(r.item.toolCallId!, index);
  });
  for (let i = end - 1; i >= start; i--) {
    const call =
      records[i].item.kind === 'tool_result' ? callIndex.get(records[i].item.toolCallId!) : undefined;
    if (call !== undefined && call < start) start = call; // The loop then also checks what this brought in.
  }
  return {
    items: records.slice(start, end).map(r => r.item),
    total: records.length,
    start,
    hasMore: start > 0
  };
}

/** The full body of one item. */
export function itemBody(records: ItemRecord[], id: string) {
  return records.find(r => r.item.id === id)?.body();
}
