import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/activity-view.js', import.meta.url), 'utf8');
const window = {} as any;
runInNewContext(source, {window}, {filename: 'web/activity-view.js'});
const {activityParts, formatElapsed, isBusy} = window.ActivityView;

describe('activity view', () => {
  it('formats elapsed time as m:ss or h:mm:ss', () => {
    expect(formatElapsed(-5)).toBe('0:00');
    expect(formatElapsed(42_900)).toBe('0:42');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  it('lists dialogs first, then each running tool, then shell commands', () => {
    const parts = activityParts({
      run: {startedAt: 1},
      phase: {
        kind: 'running_tools',
        since: 10,
        tools: [
          {toolCallId: 'a', toolName: 'bash', summary: 'npm test', since: 10},
          {toolCallId: 'b', toolName: 'read', since: 12}
        ]
      },
      bash: [{id: 'x', command: 'ls', since: 3}],
      dialogs: [{requestId: 'q', title: 'Proceed?', since: 20}]
    });
    expect(parts.map((part: any) => [part.text, part.since])).toEqual([
      ['等待你回答：Proceed?', 20],
      ['bash: npm test', 10],
      ['read', 12],
      ['ls', 3]
    ]);
  });

  it('describes LLM phases', () => {
    const text = (phase: Record<string, unknown>) => activityParts({phase: {since: 1, ...phase}})[0]?.text;
    expect(text({kind: 'waiting_llm'})).toBe('等待 LLM 响应');
    expect(text({kind: 'preparing_tool', toolName: 'write'})).toBe('生成工具参数：write');
    expect(text({kind: 'retrying', attempt: 2, maxAttempts: 3, error: 'overloaded'})).toBe(
      '重试 2/3 · overloaded'
    );
    expect(text({kind: 'idle'})).toBeUndefined();
  });

  it('shows TTFT and makes the approximate throughput available to the status chip', () => {
    const metrics = {
      turnStartedAt: 1000,
      firstResponseAt: 1750,
      textStartedAt: 2000,
      chars: 10,
      estimatedTokens: 3
    };
    const thinking = activityParts({phase: {kind: 'thinking', since: 1750}, metrics})[0];
    expect(thinking.text).toBe('LLM 思考中 · TTFT 750 ms');
    const generating = activityParts({phase: {kind: 'generating', since: 2000}, metrics})[0];
    expect(generating.text).toBe('LLM 输出中 · TTFT 750 ms · 已输出 10 字');
    expect(generating.speed).toEqual({tokens: 3, since: 2000});
    const tool = activityParts({phase: {kind: 'preparing_tool', since: 2000, toolName: 'write'}, metrics})[0];
    expect(tool.text).toBe('生成工具参数：write · TTFT 750 ms');
  });

  it('treats an idle activity as not busy', () => {
    expect(isBusy(null)).toBe(false);
    expect(isBusy({run: null, phase: {kind: 'idle', since: 1}, bash: [], dialogs: []})).toBe(false);
    expect(isBusy({run: null, phase: {kind: 'compacting', since: 1}, bash: [], dialogs: []})).toBe(true);
  });
});
