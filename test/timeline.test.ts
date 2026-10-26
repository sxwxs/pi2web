import {describe, expect, it} from 'vitest';
import {buildTimeline, INLINE_LIMIT, itemBody, pageTimeline, type TimelineEntry} from '../src/timeline.js';
import {AgentFeed, type DetailMessage, type TimelineSource} from '../src/agent-feed.js';

let counter = 0;
const message = (message: Record<string, unknown>): TimelineEntry => ({
  type: 'message',
  id: `e${++counter}`,
  parentId: null,
  timestamp: '2026-01-01T00:00:00.000Z',
  message: {timestamp: 1000 + counter, ...message}
});
const items = (entries: TimelineEntry[]) => buildTimeline(entries).map(r => r.item);
const call = (id: string, name = 'bash', args: Record<string, unknown> = {command: 'npm test'}) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
});
const result = (toolCallId: string, text: string, extra: Record<string, unknown> = {}) =>
  message({
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{type: 'text', text}],
    isError: false,
    ...extra
  });

describe('buildTimeline', () => {
  it('projects each entry, and each part of an answer, into items that never change', () => {
    const user = message({role: 'user', content: 'hi'}),
      answer = message({
        role: 'assistant',
        content: [{type: 'thinking', thinking: 'hmm'}, {type: 'text', text: 'Hello'}, call('c1')]
      }),
      output = result('c1', 'passed', {durationMs: 1200});
    const at = expect.any(Number);
    expect(items([user, answer, output])).toEqual([
      {id: user.id, kind: 'user', timestamp: at, size: 2, body: 'hi'},
      {id: `${answer.id}.0`, kind: 'thinking', timestamp: at, size: 3, body: 'hmm'},
      {id: `${answer.id}.1`, kind: 'assistant', timestamp: at, size: 5, body: 'Hello'},
      {
        id: `${answer.id}.2`,
        kind: 'tool_call',
        timestamp: at,
        title: 'bash',
        summary: 'npm test',
        toolCallId: 'c1',
        size: 27,
        body: '{\n  "command": "npm test"\n}'
      },
      {
        id: output.id,
        kind: 'tool_result',
        timestamp: at,
        title: 'bash',
        status: 'ok',
        durationMs: 1200,
        toolCallId: 'c1',
        size: 6,
        body: 'passed'
      }
    ]);
    // A call's item is the same before and after its result is recorded.
    expect(items([user, answer])[3]).toEqual(items([user, answer, output])[3]);
  });

  it('keeps large bodies out of the timeline but not the text people read', () => {
    const big = 'x'.repeat(INLINE_LIMIT + 1),
      [answer, , output] = items([
        message({role: 'assistant', content: [{type: 'text', text: big}, call('c1')]}),
        result('c1', `first line\n${big}`)
      ]);
    expect(answer.body).toBe(big);
    expect(output).toMatchObject({kind: 'tool_result', status: 'ok', summary: 'first line'});
    expect(output.body).toBeUndefined();
    expect(output.size).toBeGreaterThan(INLINE_LIMIT);
  });

  it('shows errors, shell commands, compaction and nested tool calls', () => {
    const entries = [
      message({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'overloaded',
        provider: 'p',
        model: 'm'
      }),
      message({role: 'bashExecution', command: 'ls', output: 'a\nb', exitCode: 2, cancelled: false}),
      {type: 'compaction', id: 'c', parentId: null, summary: 'sum', tokensBefore: 900},
      result('c9', 'done', {
        nestedCalls: {
          complete: true,
          calls: [{id: 'n', name: 'read', arguments: {path: 'a.ts'}, status: 'ok', durationMs: 3}]
        }
      })
    ];
    const [error, bash, compaction, tool] = items(entries as TimelineEntry[]);
    expect(error).toMatchObject({kind: 'error', body: 'overloaded\n\np · m'});
    expect(bash).toMatchObject({kind: 'bash', title: 'ls', status: 'error', summary: 'exit 2', body: 'a\nb'});
    expect(compaction).toMatchObject({kind: 'compaction', summary: '压缩前 900 tokens', body: 'sum'});
    expect(tool.body).toBe('done\n\n— 嵌套调用（1）—\n✓ read: a.ts · 3 ms');
  });

  it('pages backwards without splitting a tool call from its result', () => {
    const entries = [
      message({role: 'user', content: 'a'}),
      message({role: 'assistant', content: [{type: 'text', text: 'b'}, call('c1')]}),
      result('c1', 'c'),
      message({role: 'user', content: 'd'})
    ];
    const records = buildTimeline(entries);
    // The newest two items are the result and "d"; the page reaches back to the result's call.
    expect(pageTimeline(records, 2)?.items.map(i => i.kind)).toEqual(['tool_call', 'tool_result', 'user']);
    expect(pageTimeline(records, 2)).toMatchObject({start: 2, total: 5, hasMore: true});
    expect(pageTimeline(records, 2, records[2].item.id)?.items.map(i => i.body)).toEqual(['a', 'b']);
    expect(pageTimeline(records, 2, 'missing')).toBeUndefined();
    expect(itemBody(records, records[0].item.id)).toBe('a');
  });
});

describe('AgentFeed', () => {
  function feed() {
    const entries: TimelineEntry[] = [];
    let sessionId = 's1';
    const source = (): TimelineSource => ({
        sessionId,
        leafId: entries.at(-1)?.id ?? null,
        entries: () => [...entries]
      }),
      sent: DetailMessage[] = [],
      agentFeed = new AgentFeed(source, message => sent.push(message));
    return {entries, sent, feed: agentFeed, switchSession: (id: string) => (sessionId = id)};
  }

  it('appends each item once, and drops the streamed text when its message is recorded', () => {
    const {entries, sent, feed: agentFeed} = feed();
    agentFeed.handle({type: 'message_start', message: {role: 'assistant'}});
    agentFeed.handle({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Hi'}});
    expect(agentFeed.snapshot().live).toEqual({text: 'Hi', thinking: ''});
    agentFeed.handle({type: 'message_end'});
    entries.push(message({role: 'assistant', content: [{type: 'text', text: 'Hi'}, call('c1')]}));
    agentFeed.sync();
    entries.push(result('c1', 'ok'));
    agentFeed.sync();
    agentFeed.sync();
    expect(sent.map(m => (m.type === 'items' ? [m.items.map(i => i.kind), m.clearLive] : m.type))).toEqual([
      'delta',
      [['assistant', 'tool_call'], true],
      [['tool_result'], undefined]
    ]);
    expect(agentFeed.snapshot().live).toBeNull();
  });

  it('starts viewers from a snapshot that includes everything not yet published', () => {
    const {entries, sent, feed: agentFeed} = feed();
    entries.push(message({role: 'user', content: 'a'}));
    const snapshot = agentFeed.snapshot(10);
    expect(snapshot.page.items.map(i => i.body)).toEqual(['a']);
    // Published while taking the snapshot, so a subscriber added after it will not get it again.
    expect(sent).toHaveLength(1);
  });

  it('resets viewers when moving back from a tool result to its call, or to another session', () => {
    const {entries, sent, feed: agentFeed, switchSession} = feed();
    entries.push(message({role: 'assistant', content: [call('c1')]}), result('c1', 'done'));
    agentFeed.sync();
    entries.pop();
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's1'});
    switchSession('s2');
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's2'});
  });
});
