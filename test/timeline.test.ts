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
        rev: output.id,
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

  it('marks a call without a result running only while it executes or its run is about to execute it', () => {
    const entries = [message({role: 'assistant', content: [call('c1'), call('c2')]})];
    const status = (runtime: {active: boolean; running: string[]}) =>
      buildTimeline(entries, {active: runtime.active, running: new Set(runtime.running)}).map(r => [
        r.item.status,
        r.item.toolCallId
      ]);
    expect(status({active: true, running: ['c1']})).toEqual([
      ['pending', 'c1'],
      ['pending', 'c2']
    ]);
    // Interrupted, restored after a restart, or the session moved back to this call: nothing runs it.
    expect(status({active: false, running: []})).toEqual([
      ['cancelled', undefined],
      ['cancelled', undefined]
    ]);
    expect(items(entries)[0].status).toBe('cancelled');
    // In a run that moved past the call, it is not about to execute.
    const moved = [...entries, message({role: 'user', content: 'never mind'})];
    expect(buildTimeline(moved, {active: true, running: new Set()})[0].item.status).toBe('cancelled');
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

  it('versions a tool body by the result it includes, so a rerun is never served from a cache', () => {
    const ask = message({role: 'assistant', content: [call('c1')]}),
      first = result('c1', 'first run'),
      second = result('c1', 'second run');
    const [before] = buildTimeline([ask, first]),
      [after] = buildTimeline([ask, second]);
    expect(before.item.id).toBe(after.item.id);
    expect([before.item.rev, after.item.rev]).toEqual([first.id, second.id]);
    const records = buildTimeline([ask, second]);
    expect(itemDetail(records, after.item.id, second.id)?.body).toContain('second run');
    expect(itemDetail(records, after.item.id, first.id)).toBeUndefined();
    expect(itemDetail(records, after.item.id)).toBeUndefined();
  });

  it('pages backwards and returns full bodies, pending ones marked as still changing', () => {
    const entries = [
      message({role: 'user', content: 'a'}),
      message({role: 'user', content: 'b'}),
      message({role: 'assistant', content: [call('c1')]})
    ];
    const records = buildTimeline(entries, {active: true, running: new Set(['c1'])});
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
      runtime = {active: false, running: new Set<string>()},
      agentFeed = new AgentFeed(
        source,
        message => sent.push(message),
        () => runtime
      );
    return {entries, sent, runtime, feed: agentFeed, switchSession: (id: string) => (sessionId = id)};
  }

  it('publishes appended items once and a finished tool as an update', () => {
    vi.useFakeTimers();
    try {
      const {entries, sent, runtime, feed: agentFeed} = feed();
      runtime.active = true;
      entries.push(message({role: 'assistant', content: [call('c1')]}));
      runtime.running.add('c1');
      agentFeed.handle({type: 'tool_execution_start', toolCallId: 'c1'});
      agentFeed.handle({
        type: 'tool_execution_update',
        toolCallId: 'c1',
        partialResult: {content: [{type: 'text', text: 'half'}]}
      });
      vi.runAllTimers();
      expect(agentFeed.output('c1')).toBe('half');
      entries.push(result('c1', 'all'));
      runtime.running.delete('c1');
      agentFeed.handle({type: 'tool_execution_end', toolCallId: 'c1'});
      vi.runAllTimers();
      agentFeed.handle({type: 'turn_end'});
      vi.runAllTimers();
      const batches = sent.filter(m => m.type === 'items') as any[];
      expect(
        batches.map(m => [m.version, m.items.map((i: any) => i.status), m.updated?.map((i: any) => i.status)])
      ).toEqual([
        [1, ['pending'], undefined],
        [2, [], ['ok']]
      ]);
      expect(agentFeed.currentVersion()).toBe(2);
      expect(agentFeed.output('c1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets viewers when moving back from a tool result to its call, though every item id stays', () => {
    const {entries, sent, feed: agentFeed} = feed();
    entries.push(message({role: 'assistant', content: [call('c1')]}), result('c1', 'done'));
    agentFeed.sync();
    entries.pop();
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's1', version: 2});
  });

  it('updates a call when it stops running without a result, though the leaf did not move', () => {
    const {entries, sent, runtime, feed: agentFeed} = feed();
    runtime.active = true;
    runtime.running.add('c1');
    entries.push(message({role: 'assistant', content: [call('c1')]}));
    agentFeed.sync();
    runtime.active = false;
    runtime.running.clear();
    agentFeed.handle({type: 'agent_end'});
    agentFeed.sync();
    expect(sent.at(-1)).toMatchObject({type: 'items', items: [], updated: [{status: 'cancelled'}]});
  });

  it('resets viewers when the branch or session changes', () => {
    const {entries, sent, feed: agentFeed, switchSession} = feed();
    entries.push(message({role: 'user', content: 'a'}), message({role: 'user', content: 'b'}));
    agentFeed.sync();
    entries.pop();
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's1', version: 2});
    switchSession('s2');
    agentFeed.sync();
    expect(sent.at(-1)).toEqual({type: 'timeline_reset', sessionId: 's2', version: 3});
  });
});
