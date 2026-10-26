import {describe, expect, it, vi} from 'vitest';
import {buildTimeline, INLINE_LIMIT, itemDetail, pageTimeline, type TimelineEntry} from '../src/timeline.js';
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
  it('projects messages into items with ids derived from their entries', () => {
    const user = message({role: 'user', content: 'hi'}),
      answer = message({
        role: 'assistant',
        content: [{type: 'thinking', thinking: 'hmm'}, {type: 'text', text: 'Hello'}, call('c1')]
      }),
      output = result('c1', 'passed', {durationMs: 1200});
    expect(items([user, answer, output])).toEqual([
      {id: user.id, kind: 'user', timestamp: expect.any(Number), size: 2, body: 'hi'},
      {id: `${answer.id}.0`, kind: 'thinking', timestamp: expect.any(Number), size: 3, body: 'hmm'},
      {id: `${answer.id}.1`, kind: 'assistant', timestamp: expect.any(Number), size: 5, body: 'Hello'},
      {
        id: `${answer.id}.2`,
        kind: 'tool',
        timestamp: expect.any(Number),
        title: 'bash',
        summary: 'npm test',
        status: 'ok',
        durationMs: 1200,
        size: expect.any(Number),
        body: '{\n  "command": "npm test"\n}\n\n— 结果 —\npassed'
      }
    ]);
  });

  it('keeps large bodies out of the timeline but not the text people read', () => {
    const big = 'x'.repeat(INLINE_LIMIT + 1),
      [answer, tool] = items([
        message({role: 'assistant', content: [{type: 'text', text: big}, call('c1')]}),
        result('c1', `first line\n${big}`)
      ]);
    expect(answer.body).toBe(big);
    expect(tool).toMatchObject({status: 'ok', summary: 'npm test'});
    expect(tool.body).toBeUndefined();
    expect(tool.size).toBeGreaterThan(INLINE_LIMIT);
    const [thinking] = items([
      message({role: 'assistant', content: [{type: 'thinking', thinking: `idea\n${big}`}]})
    ]);
    expect(thinking).toMatchObject({kind: 'thinking', summary: 'idea'});
    expect(thinking.body).toBeUndefined();
  });

  it('tells running tool calls from ones the conversation moved past', () => {
    const running = items([message({role: 'assistant', content: [call('c1')]})]);
    expect(running[0]).toMatchObject({status: 'pending', toolCallId: 'c1'});
    const abandoned = items([
      message({role: 'assistant', content: [call('c1')]}),
      message({role: 'user', content: 'never mind'})
    ]);
    expect(abandoned[0].status).toBe('cancelled');
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
      message({
        role: 'bashExecution',
        command: 'ls',
        output: 'a\nb',
        exitCode: 2,
        cancelled: false,
        truncated: false
      }),
      {
        type: 'compaction',
        id: 'c',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        summary: 'sum',
        tokensBefore: 900
      },
      message({role: 'assistant', content: [call('c9', 'codemode', {})]}),
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
    expect(compaction).toMatchObject({
      kind: 'compaction',
      title: '上下文已压缩',
      summary: '压缩前 900 tokens',
      body: 'sum'
    });
    expect(tool.body).toBe('done\n\n— 嵌套调用（1）—\n✓ read: a.ts · 3 ms');
  });

  it('pages backwards and returns full bodies, pending ones marked as still changing', () => {
    const entries = [
      message({role: 'user', content: 'a'}),
      message({role: 'user', content: 'b'}),
      message({role: 'assistant', content: [call('c1')]})
    ];
    const records = buildTimeline(entries);
    expect(pageTimeline(records, 2)).toMatchObject({start: 1, total: 3, hasMore: true});
    expect(pageTimeline(records, 2, records[1].item.id)?.items.map(i => i.body)).toEqual(['a']);
    expect(pageTimeline(records, 2, 'missing')).toBeUndefined();
    expect(itemDetail(records, records[0].item.id)).toEqual({
      id: records[0].item.id,
      body: 'a',
      complete: true
    });
    expect(itemDetail(records, records[2].item.id)?.complete).toBe(false);
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

  it('publishes appended items once and a finished tool as an update', () => {
    vi.useFakeTimers();
    try {
      const {entries, sent, feed: agentFeed} = feed();
      entries.push(message({role: 'assistant', content: [call('c1')]}));
      agentFeed.handle({type: 'tool_execution_start', toolCallId: 'c1'});
      agentFeed.handle({
        type: 'tool_execution_update',
        toolCallId: 'c1',
        partialResult: {content: [{type: 'text', text: 'half'}]}
      });
      vi.runAllTimers();
      expect(agentFeed.output('c1')).toBe('half');
      entries.push(result('c1', 'all'));
      agentFeed.handle({type: 'tool_execution_end', toolCallId: 'c1'});
      vi.runAllTimers();
      agentFeed.handle({type: 'turn_end'});
      vi.runAllTimers();
      const updates = sent.filter(m => m.type === 'items') as any[];
      expect(updates.map(m => m.items.map((i: any) => i.status))).toEqual([['pending'], ['ok']]);
      expect(agentFeed.output('c1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets viewers when the branch or session changes', () => {
    const {entries, sent, feed: agentFeed, switchSession} = feed();
    entries.push(message({role: 'user', content: 'a'}), message({role: 'user', content: 'b'}));
    agentFeed.sync();
    entries.pop();
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's1'});
    switchSession('s2');
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's2'});
  });
});
