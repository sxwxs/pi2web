import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/hid-keyboard.js', import.meta.url), 'utf8');
const storageKey = 'rpSessionKeyboardBindings';
const agent = (status = 'idle') => ({agentId:'agent-a', status});

/** Load the actual browser controller without a DOM, WebHID device, or new dependencies. */
function loadKeyboard(storage = new Map<string, string>()) {
  const window = {} as any;
  runInNewContext(source, {
    window, navigator:{}, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    localStorage:{getItem:(key:string) => storage.get(key) ?? null, setItem:(key:string, value:string) => storage.set(key, value)},
  }, {filename:'web/hid-keyboard.js'});
  const onBindingsChange = vi.fn();
  const keyboard = new window.SessionKeyboardController({onBindingsChange});
  return {keyboard, storage, onBindingsChange};
}

function boundKeyboard() {
  const {keyboard} = loadKeyboard();
  keyboard.bind('agent-a', 0, '#FF3040');
  keyboard.setAgents([agent()]);
  return keyboard;
}

const light = (keyboard:any) => keyboard.lightState(0);
const event = (keyboard:any, type:string, fields:Record<string, unknown> = {}) => keyboard.handleAgentEvent('agent-a', {type, ...fields});

describe('session keyboard bindings', () => {
  it('leaves memory, storage and observers unchanged after a rejected move', () => {
    const {keyboard, storage, onBindingsChange} = loadKeyboard();
    keyboard.bind('agent-a', 0, '#FF3040');
    keyboard.bind('agent-b', 1, '#00D9FF');
    const saved = storage.get(storageKey);
    onBindingsChange.mockClear();

    expect(() => keyboard.bind('agent-a', 1)).toThrow('已被其他 Session 使用');
    expect(keyboard.getBinding('agent-a')).toEqual({agentId:'agent-a', slot:0, color:'#FF3040'});
    expect(storage.get(storageKey)).toBe(saved);
    expect(onBindingsChange).not.toHaveBeenCalled();

    keyboard.setColor('agent-b', '#0000FF');
    expect(loadKeyboard(storage).keyboard.getBinding('agent-a')).toEqual(keyboard.getBinding('agent-a'));
  });

  it('moves a binding to a free slot without leaving duplicate entries', () => {
    const {keyboard, storage} = loadKeyboard();
    keyboard.bind('agent-a', 0);
    keyboard.bind('agent-a', 3, '#00D9FF');
    expect(keyboard.getSlot(0)).toBeNull();
    expect(loadKeyboard(storage).keyboard.getBindings()).toEqual([{slot:3, agentId:'agent-a', color:'#00D9FF'}]);
  });

  it('allows clearing an unavailable slot without deleting other persisted bindings', () => {
    const {keyboard, storage} = loadKeyboard();
    for (let slot = 0; slot < 6; slot++) keyboard.autoBind(`old-${slot}`);
    keyboard.setAgents([agent()]);
    expect(keyboard.autoBind('agent-a')).toBeNull();
    expect(light(keyboard).effect).toBe(0);

    // The slot-level UI uses the persisted binding, not the current agent list.
    keyboard.unbind(keyboard.getSlot(0).agentId);
    expect(keyboard.autoBind('agent-a').slot).toBe(0);
    expect(loadKeyboard(storage).keyboard.getBindings()).toHaveLength(6);
    expect(keyboard.getSlot(1).agentId).toBe('old-1');
  });
});

describe('session keyboard activity', () => {
  it('tracks parallel tools, retries and completion', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'agent_start');
    expect(light(keyboard)).toMatchObject({effect:4, speed:0.12});
    event(keyboard, 'tool_execution_start', {toolCallId:'one'});
    event(keyboard, 'tool_execution_start', {toolCallId:'two'});
    event(keyboard, 'tool_execution_end', {toolCallId:'two'});
    expect(light(keyboard)).toMatchObject({effect:4, speed:0.45});
    event(keyboard, 'tool_execution_end', {toolCallId:'one'});
    expect(light(keyboard).speed).toBe(0.12);
    event(keyboard, 'agent_end', {willRetry:true});
    expect(light(keyboard).speed).toBe(0.8);
    event(keyboard, 'auto_retry_start');
    event(keyboard, 'agent_start');
    event(keyboard, 'auto_retry_end', {success:true});
    expect(light(keyboard).speed).toBe(0.12);
    event(keyboard, 'agent_end');
    event(keyboard, 'agent_settled');
    expect(light(keyboard)).toMatchObject({effect:1, speed:0});
    expect(keyboard.activities.size).toBe(0);
  });

  it.each(['agent_start', 'tool_execution_start', 'auto_retry_start'])('clears stale %s activity on an idle list refresh', type => {
    const keyboard = boundKeyboard();
    event(keyboard, type);
    keyboard.setAgents([agent('idle')]);
    expect(light(keyboard).effect).toBe(1);
    event(keyboard, 'session_info_changed', {name:'renamed'});
    expect(light(keyboard).effect).toBe(1);
    expect(keyboard.activities.size).toBe(0);
  });

  it.each([
    ['idle', 1, 0],
    ['streaming', 4, 0.15],
    ['waiting_for_user', 6, 0.1],
  ])('replaces stale details with a %s snapshot', (status, effect, speed) => {
    const keyboard = boundKeyboard();
    event(keyboard, 'tool_execution_start', {toolCallId:'old-tool'});
    event(keyboard, 'bash_execution_start', {id:'old-bash'});
    event(keyboard, 'extension_ui_request', {requestId:'old-request'});
    keyboard.setAgentSnapshot(agent(String(status)));
    expect(light(keyboard)).toMatchObject({effect, speed});
    expect(keyboard.activities.size).toBe(0);
    // Late/unknown responses must not resurrect work after a sequence reset.
    event(keyboard, 'extension_ui_response', {requestId:'old-request'});
    expect(light(keyboard)).toMatchObject({effect, speed});
  });

  it('does not start LLM activity when an idle extension dialog is answered', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'extension_ui_request', {requestId:'question'});
    expect(light(keyboard).effect).toBe(6);
    event(keyboard, 'extension_ui_response', {requestId:'question'});
    expect(light(keyboard).effect).toBe(1);
    event(keyboard, 'agent_settled');
    event(keyboard, 'extension_ui_response', {requestId:'question'});
    expect(light(keyboard).effect).toBe(1);
  });

  it('matches dialog completions by request id and waits for every open dialog', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'agent_start');
    event(keyboard, 'extension_ui_request', {requestId:'one'});
    event(keyboard, 'extension_ui_request', {requestId:'two'});
    event(keyboard, 'message_update');
    event(keyboard, 'extension_ui_response', {requestId:'one'});
    event(keyboard, 'extension_ui_response', {requestId:'unrelated'});
    expect(light(keyboard).effect).toBe(6);
    event(keyboard, 'extension_ui_response', {requestId:'two'});
    expect(light(keyboard)).toMatchObject({effect:4, speed:0.12});
  });

  it('keeps independent silent bash runs alive across LLM turns and idle refreshes', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'bash_execution_start', {id:'one'});
    event(keyboard, 'bash_execution_start', {id:'two'});
    expect(light(keyboard).speed).toBe(0.45);
    event(keyboard, 'agent_start');
    event(keyboard, 'agent_end');
    event(keyboard, 'agent_settled');
    keyboard.setAgents([agent('idle')]);
    event(keyboard, 'bash_execution_end', {id:'one'});
    expect(light(keyboard).speed).toBe(0.45);
    event(keyboard, 'bash_execution_end', {id:'two'});
    expect(light(keyboard).effect).toBe(1);
  });

  it('does not dismiss an out-of-turn dialog just because the LLM is idle', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'extension_ui_request', {requestId:'question'});
    keyboard.updateAgent(agent('idle'));
    keyboard.setAgents([agent('idle')]);
    expect(light(keyboard).effect).toBe(6);
    event(keyboard, 'extension_ui_response', {requestId:'question'});
    expect(light(keyboard).effect).toBe(1);
  });

  it.each(['unloaded', 'stopped', 'error'])('clears every activity when an agent becomes %s', status => {
    const keyboard = boundKeyboard();
    event(keyboard, 'bash_execution_start', {id:'bash'});
    event(keyboard, 'extension_ui_request', {requestId:'question'});
    keyboard.updateAgent(agent(status));
    expect(light(keyboard).effect).toBe(1);
    expect(keyboard.activities.size).toBe(0);
  });

  it('turns lights off and clears activity, but keeps bindings, when a server disconnects', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'tool_execution_start');
    keyboard.setAgents([]);
    expect(light(keyboard).effect).toBe(0);
    expect(keyboard.activities.size).toBe(0);
    expect(keyboard.getBinding('agent-a')).not.toBeNull();
    keyboard.setAgents([agent()]);
    expect(light(keyboard).effect).toBe(1);
  });

  it('ignores non-assistant message starts', () => {
    const keyboard = boundKeyboard();
    event(keyboard, 'message_start', {message:{role:'user'}});
    event(keyboard, 'message_start', {message:{role:'toolResult'}});
    expect(light(keyboard).effect).toBe(1);
    event(keyboard, 'message_start', {message:{role:'assistant'}});
    expect(light(keyboard).speed).toBe(0.12);
  });
});
