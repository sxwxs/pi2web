import {describe, expect, it, vi} from 'vitest';
import {
  PERFORMANCE_ENTRY,
  SessionPerformanceTracker,
  sessionPerformance
} from '../src/session-performance.js';

describe('session performance', () => {
  it('records first response, model time, and overlapping tool calls on the host clock', () => {
    let now = 1000;
    const save = vi.fn();
    const tracker = new SessionPerformanceTracker(save, () => now);
    const send = (time: number, event: any) => {
      now = time;
      tracker.apply(event);
    };
    send(1000, {type: 'agent_start'});
    send(1010, {type: 'turn_start'});
    send(1100, {type: 'message_update'});
    send(1300, {type: 'message_end', message: {role: 'assistant'}});
    send(1310, {type: 'tool_execution_start', toolCallId: 'a', toolName: 'read'});
    send(1320, {type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash'});
    send(1330, {type: 'tool_execution_start', toolCallId: 'nested', parentToolCallId: 'a'});
    send(1400, {type: 'tool_execution_end', toolCallId: 'a'});
    send(1500, {type: 'tool_execution_end', toolCallId: 'b'});
    send(1510, {type: 'turn_start'});
    send(1650, {type: 'message_end', message: {role: 'assistant'}});
    send(1700, {type: 'agent_end'});
    expect(save).toHaveBeenCalledWith({
      start: 1000,
      end: 1700,
      spans: [
        {kind: 'model', start: 1010, end: 1300, firstResponse: 1100},
        {kind: 'tool', start: 1310, end: 1400, name: 'read', toolCallId: 'a'},
        {kind: 'tool', start: 1320, end: 1500, name: 'bash', toolCallId: 'b'},
        {kind: 'model', start: 1510, end: 1650}
      ]
    });
    send(1800, {type: 'agent_end'});
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps auto-retries in one run and marks aborted tools incomplete', () => {
    let now = 0;
    const save = vi.fn();
    const t = new SessionPerformanceTracker(save, () => now);
    t.apply({type: 'agent_start'});
    now = 10;
    t.apply({type: 'agent_end', willRetry: true});
    now = 15;
    t.apply({type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash'});
    now = 20;
    t.apply({type: 'agent_end', aborted: true});
    expect(save).toHaveBeenCalledWith({
      start: 0,
      end: 20,
      incomplete: true,
      spans: [{kind: 'tool', name: 'bash', toolCallId: 'a', start: 15, end: 20, incomplete: true}]
    });
  });

  it('returns branch-local records and legacy tool durations without inventing model timings', () => {
    const run = {start: 100, end: 200, spans: []};
    const entries: any[] = [
      {type: 'message', message: {role: 'toolResult', timestamp: 50, durationMs: 20, toolName: 'read'}},
      {type: 'custom', customType: PERFORMANCE_ENTRY, data: run},
      {type: 'message', message: {role: 'toolResult', timestamp: 180, durationMs: 30, toolName: 'bash'}}
    ];
    expect(sessionPerformance(entries)).toEqual({
      runs: [run],
      legacyTools: [{kind: 'tool', start: 30, end: 50, name: 'read'}]
    });
  });
});
