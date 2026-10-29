import {describe, expect, it} from 'vitest';
import {ActivityTracker, toolSummary} from '../src/activity.js';

function tracker() {
  let now = 1000;
  const t = new ActivityTracker(() => now);
  return {
    t,
    at: (ms: number) => (now = ms),
    apply: (type: string, fields: Record<string, unknown> = {}) => t.apply({type, ...fields}),
    phase: () => t.snapshot().phase
  };
}
const update = (type: string, extra: Record<string, unknown> = {}) => ({
  assistantMessageEvent: {type, ...extra}
});

describe('ActivityTracker', () => {
  it('follows a run through LLM phases and tools, keeping start times', () => {
    const {t, at, apply, phase} = tracker();
    at(2000);
    expect(apply('agent_start')).toBe(true);
    expect(t.snapshot().run).toEqual({startedAt: 2000});
    expect(phase()).toEqual({kind: 'waiting_llm', since: 2000});
    at(3000);
    expect(apply('message_update', update('thinking_delta'))).toBe(true);
    at(3500);
    // Further deltas of the same phase are not changes and keep the timer.
    expect(apply('message_update', update('thinking_delta'))).toBe(false);
    expect(phase()).toEqual({kind: 'thinking', since: 3000});
    at(4000);
    apply('message_update', update('text_delta'));
    expect(phase()).toEqual({kind: 'generating', since: 4000});
    at(5000);
    apply('message_update', update('toolcall_start', {contentIndex: 1, partial: {content: [{}, {}]}}));
    at(5100);
    // The tool name arrives with a later delta; fill it in without restarting the timer.
    apply(
      'message_update',
      update('toolcall_delta', {contentIndex: 1, partial: {content: [{}, {name: 'write'}]}})
    );
    expect(phase()).toEqual({kind: 'preparing_tool', since: 5000, toolName: 'write'});
    expect(
      apply(
        'message_update',
        update('toolcall_delta', {contentIndex: 1, partial: {content: [{}, {name: 'write'}]}})
      )
    ).toBe(false);
    at(6000);
    apply('tool_execution_start', {toolCallId: 'a', toolName: 'bash', args: {command: 'npm test'}});
    at(6500);
    apply('tool_execution_start', {toolCallId: 'b', toolName: 'read', args: {path: 'src/x.ts'}});
    // Tools called by another tool run inside their caller's time.
    expect(apply('tool_execution_start', {toolCallId: 'c', toolName: 'read', parentToolCallId: 'a'})).toBe(
      false
    );
    expect(phase()).toEqual({
      kind: 'running_tools',
      since: 6000,
      tools: [
        {toolCallId: 'a', toolName: 'bash', summary: 'npm test', since: 6000},
        {toolCallId: 'b', toolName: 'read', summary: 'src/x.ts', since: 6500}
      ]
    });
    apply('tool_execution_end', {toolCallId: 'a'});
    expect(phase()).toMatchObject({kind: 'running_tools', since: 6000, tools: [{toolCallId: 'b'}]});
    at(7000);
    apply('tool_execution_end', {toolCallId: 'b'});
    expect(phase()).toEqual({kind: 'waiting_llm', since: 7000});
    at(8000);
    apply('agent_end', {willRetry: false});
    expect(t.snapshot()).toMatchObject({run: null, phase: {kind: 'idle', since: 8000}});
    expect(apply('agent_settled')).toBe(false);
  });

  it('tracks TTFT and throttles estimated text throughput without retaining output text', () => {
    const {t, at, apply} = tracker();
    apply('agent_start');
    at(1100);
    apply('turn_start');
    at(1600);
    apply('message_update', update('thinking_delta', {delta: 'thought'}));
    expect(t.snapshot().metrics?.firstResponseAt).toBe(1600);
    at(1800);
    apply('message_update', update('text_delta', {delta: 'hello世界'}));
    expect(t.snapshot().metrics).toMatchObject({
      turnStartedAt: 1100,
      firstResponseAt: 1600,
      textStartedAt: 1800,
      chars: 7,
      estimatedTokens: 5 / 4 + 2 / 1.5
    });
    at(1900);
    expect(apply('message_update', update('text_delta', {delta: 'more'}))).toBe(false);
    at(2900);
    expect(apply('message_update', update('text_delta', {delta: 'x'}))).toBe(true);
    expect(t.snapshot().metrics?.chars).toBe(12);
    apply('turn_start');
    expect(t.snapshot().metrics).toMatchObject({chars: 0, estimatedTokens: 0});
    apply('agent_end');
    expect(t.snapshot().metrics).toBeUndefined();
  });

  it('publishes the new turn even when the last tool already left the phase waiting', () => {
    const {t, at, apply} = tracker();
    apply('agent_start');
    at(1500);
    apply('message_update', update('text_delta', {delta: 'hello'}));
    apply('tool_execution_start', {toolCallId: 'tool-1', toolName: 'read'});
    at(2000);
    apply('tool_execution_end', {toolCallId: 'tool-1'});
    expect(t.snapshot().phase.kind).toBe('waiting_llm');
    expect(t.snapshot().metrics?.firstResponseAt).toBe(1500);
    at(2100);
    expect(apply('turn_start')).toBe(true);
    expect(t.snapshot().phase).toEqual({kind: 'waiting_llm', since: 2000});
    expect(t.snapshot().metrics).toEqual({turnStartedAt: 2100, chars: 0, estimatedTokens: 0});
  });

  it('keeps the run across retries and restarts the retry timer on each attempt', () => {
    const {t, at, apply, phase} = tracker();
    apply('agent_start');
    expect(apply('agent_end', {willRetry: true})).toBe(false);
    at(2000);
    apply('auto_retry_start', {attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: 'overloaded'});
    expect(phase()).toEqual({
      kind: 'retrying',
      since: 2000,
      attempt: 1,
      maxAttempts: 3,
      retryAt: 2500,
      error: 'overloaded'
    });
    at(3000);
    expect(
      apply('auto_retry_start', {attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'overloaded'})
    ).toBe(true);
    expect(phase().since).toBe(3000);
    apply('agent_start');
    expect(t.snapshot().run).toEqual({startedAt: 1000});
    expect(phase().kind).toBe('waiting_llm');
  });

  it('shows compaction that continues after the run until it settles', () => {
    const {t, apply, phase} = tracker();
    apply('agent_start');
    apply('agent_end');
    apply('compaction_start', {reason: 'threshold'});
    expect(phase()).toMatchObject({kind: 'compacting', reason: 'threshold'});
    apply('compaction_end');
    expect(t.snapshot()).toMatchObject({run: null, phase: {kind: 'idle'}});
  });

  it('ends compaction when the agent settles, even without compaction_end', () => {
    const {t, apply, phase} = tracker();
    apply('agent_start');
    apply('compaction_start', {reason: 'overflow'});
    apply('agent_end');
    expect(phase().kind).toBe('compacting');
    apply('bash_execution_start', {id: 'b'});
    expect(apply('agent_settled')).toBe(true);
    expect(t.snapshot()).toMatchObject({run: null, phase: {kind: 'idle'}, bash: [{id: 'b'}]});
  });

  it('tracks dialogs and user shell commands independently of runs', () => {
    const {t, apply} = tracker();
    apply('bash_execution_start', {id: 'one', command: 'ls'});
    apply('extension_ui_request', {requestId: 'q', title: 'Proceed?'});
    apply('agent_start');
    apply('agent_end');
    apply('agent_settled');
    expect(t.snapshot()).toMatchObject({
      run: null,
      phase: {kind: 'idle'},
      bash: [{id: 'one', command: 'ls'}],
      dialogs: [{requestId: 'q', title: 'Proceed?'}]
    });
    expect(apply('extension_ui_response', {requestId: 'other'})).toBe(false);
    apply('extension_ui_response', {requestId: 'q'});
    apply('bash_execution_end', {id: 'one'});
    expect(t.snapshot()).toMatchObject({bash: [], dialogs: []});
  });

  it('marks an abort and resets everything on unload', () => {
    const {t, apply, phase} = tracker();
    expect(t.stopping()).toBe(false);
    apply('agent_start');
    expect(t.stopping()).toBe(true);
    expect(phase().kind).toBe('stopping');
    apply('bash_execution_start', {id: 'b'});
    expect(t.reset()).toBe(true);
    expect(t.snapshot()).toMatchObject({run: null, phase: {kind: 'idle'}, bash: [], dialogs: []});
    expect(t.reset()).toBe(false);
  });

  it('ignores events that do not affect activity', () => {
    const {apply} = tracker();
    for (const type of ['message_start', 'message_end', 'turn_end', 'queue_update', 'session_info_changed'])
      expect(apply(type)).toBe(false);
  });
});

describe('toolSummary', () => {
  it('prefers well-known argument names and keeps one short line', () => {
    expect(toolSummary({content: 'body', path: 'a.ts'})).toBe('a.ts');
    expect(toolSummary({command: 'echo  a\n  b'})).toBe('echo a b');
    expect(toolSummary({other: 'x'})).toBe('x');
    expect(toolSummary({n: 1})).toBeUndefined();
    expect(toolSummary({command: 'y'.repeat(200)})).toHaveLength(80);
  });
});
