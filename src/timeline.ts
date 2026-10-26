import {toolSummary} from './activity.js';

/**
 * The Web UI's view of a session: the current branch's persisted entries projected into
 * display items. Entries are append-only and never change, so an item's id is derived from
 * its entry and a completed item's body can be cached by clients forever.
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
  | 'tool'
  | 'bash'
  | 'compaction'
  | 'branch_summary'
  | 'custom'
  | 'system';
export type ItemStatus = 'pending' | 'ok' | 'error' | 'cancelled';
export type TimelineItem = {
  id: string;
  kind: ItemKind;
  /** Epoch milliseconds. */
  timestamp?: number;
  title?: string;
  /** One line describing the item when its body is not inline: a tool's command or path, a preview. */
  summary?: string;
  status?: ItemStatus;
  durationMs?: number;
  toolCallId?: string;
  /** Length of the full body in characters. */
  size: number;
  /** The full body, present for the kinds people read linearly and for small bodies. */
  body?: string;
};
type ItemRecord = {item: TimelineItem; body: () => string};

/**
 * Bodies of collapsed kinds (tools, thinking...) up to this many characters travel with the
 * timeline; larger ones load when expanded. Tool calls are 90% of a session's bytes and are
 * rarely opened, so this is kept small.
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

const argsText = (call: any) =>
  memo(call, () =>
    call.arguments && typeof call.arguments === 'object' && Object.keys(call.arguments).length
      ? JSON.stringify(call.arguments, null, 2)
      : ''
  );
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
const resultText = (result: any) =>
  memo(
    result,
    () =>
      (contentText(result.content) || (result.isError ? '执行失败' : '执行完成')) +
      nestedText(result.nestedCalls)
  );
const RESULT_SEPARATOR = '\n\n— 结果 —\n';

function toolRecord(id: string, call: any, result: any, timestamp: number | undefined, status: ItemStatus) {
  const args = call ? argsText(call) : '',
    output = result ? resultText(result) : '',
    separator = args && result ? RESULT_SEPARATOR : '',
    toolName = String(call?.name ?? result?.toolName ?? 'tool');
  return record(
    {
      id,
      kind: 'tool',
      timestamp,
      title: toolName,
      summary: call ? toolSummary(call.arguments) : undefined,
      status,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : undefined,
      // Only needed to watch a running tool's output; provider ids can be long.
      toolCallId: status === 'pending' ? String(call?.id ?? '') : undefined
    },
    args.length + separator.length + output.length,
    () => args + separator + output
  );
}

/** Project a branch (root to leaf) into display items. */
export function buildTimeline(entries: TimelineEntry[]): ItemRecord[] {
  const results = new Map<string, any>();
  // A call without a result is still running unless the conversation moved on past it.
  let lastConversationIndex = -1;
  entries.forEach((entry, index) => {
    const message = entry.type === 'message' ? (entry as any).message : undefined;
    if (message?.role === 'toolResult') results.set(String(message.toolCallId), message);
    else if (message?.role === 'user' || message?.role === 'assistant') lastConversationIndex = index;
  });
  const consumed = new Set<string>(),
    records: ItemRecord[] = [];
  entries.forEach((entry, index) => {
    const e = entry as any;
    if (entry.type === 'compaction') {
      const summary = String(e.summary ?? '');
      records.push(
        record(
          {
            id: entry.id,
            kind: 'compaction',
            timestamp: timeOf(undefined, entry),
            title: '上下文已压缩',
            summary: Number.isFinite(e.tokensBefore) ? `压缩前 ${e.tokensBefore} tokens` : undefined
          },
          summary.length,
          () => summary
        )
      );
      return;
    }
    if (entry.type === 'branch_summary') {
      const summary = String(e.summary ?? '');
      records.push(
        record(
          {id: entry.id, kind: 'branch_summary', timestamp: timeOf(undefined, entry), title: '分支摘要'},
          summary.length,
          () => summary
        )
      );
      return;
    }
    if (entry.type === 'custom_message') {
      if (!e.display) return;
      const text = memo(entry, () => contentText(e.content));
      records.push(
        record(
          {
            id: entry.id,
            kind: 'custom',
            timestamp: timeOf(undefined, entry),
            title: String(e.customType ?? 'custom')
          },
          text.length,
          () => text
        )
      );
      return;
    }
    if (entry.type !== 'message') return;
    const message = e.message,
      role = message?.role,
      timestamp = timeOf(message, entry);
    if (role === 'user' || role === 'system') {
      const text = memo(message, () => contentText(message.content));
      if (text) records.push(record({id: entry.id, kind: role, timestamp}, text.length, () => text));
      return;
    }
    if (role === 'bashExecution') {
      const output = String(message.output ?? ''),
        failed = Number(message.exitCode) > 0;
      records.push(
        record(
          {
            id: entry.id,
            kind: 'bash',
            timestamp,
            title: String(message.command ?? ''),
            summary: message.cancelled
              ? '已取消'
              : message.exitCode === undefined
                ? undefined
                : `exit ${message.exitCode}${message.truncated ? ' · 输出已截断' : ''}`,
            status: message.cancelled ? 'cancelled' : failed ? 'error' : 'ok'
          },
          output.length,
          () => output
        )
      );
      return;
    }
    if (role === 'toolResult') {
      // Normally shown with its call; a result whose call is not on this branch stands alone.
      if (!consumed.has(String(message.toolCallId)))
        records.push(toolRecord(entry.id, undefined, message, timestamp, message.isError ? 'error' : 'ok'));
      return;
    }
    if (role !== 'assistant') return;
    (Array.isArray(message.content) ? message.content : []).forEach((part: any, partIndex: number) => {
      const id = `${entry.id}.${partIndex}`;
      if (part?.type === 'text' && part.text) {
        const text = String(part.text);
        records.push(record({id, kind: 'assistant', timestamp}, text.length, () => text));
      } else if (part?.type === 'thinking' && (part.thinking || part.text)) {
        const text = String(part.thinking || part.text);
        records.push(record({id, kind: 'thinking', timestamp}, text.length, () => text));
      } else if (part?.type === 'toolCall') {
        const result = results.get(String(part.id));
        if (result) consumed.add(String(part.id));
        const status: ItemStatus = result
          ? result.isError
            ? 'error'
            : 'ok'
          : index < lastConversationIndex
            ? 'cancelled'
            : 'pending';
        records.push(toolRecord(id, part, result, timestamp, status));
      }
    });
    const error = assistantError(message);
    if (error)
      records.push(record({id: `${entry.id}.error`, kind: 'error', timestamp}, error.length, () => error));
  });
  return records;
}

export type TimelinePage = {items: TimelineItem[]; total: number; start: number; hasMore: boolean};

/** The `limit` items before `before` (or the newest ones). Undefined when `before` is not on the timeline. */
export function pageTimeline(records: ItemRecord[], limit = 50, before?: string): TimelinePage | undefined {
  const size = Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 50)),
    end = before === undefined ? records.length : records.findIndex(r => r.item.id === before);
  if (end < 0) return undefined;
  const start = Math.max(0, end - size);
  return {
    items: records.slice(start, end).map(r => r.item),
    total: records.length,
    start,
    hasMore: start > 0
  };
}

/** The full body of one item, and whether it can still change. */
export function itemDetail(records: ItemRecord[], id: string) {
  const found = records.find(r => r.item.id === id);
  return found && {id, body: found.body(), complete: found.item.status !== 'pending'};
}
