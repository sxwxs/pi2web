import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/hid-keyboard.js', import.meta.url), 'utf8');
const storageKey = 'rpSessionKeyboardBindings';
const agent = (status = 'idle') => ({agentId: 'agent-a', status});

/** Load the actual browser controller without a DOM, WebHID device, or new dependencies. */
function loadKeyboard(storage = new Map<string, string>()) {
  const window = {} as any;
  runInNewContext(
    source,
    {
      window,
      navigator: {},
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    },
    {filename: 'web/hid-keyboard.js'}
  );
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

const light = (keyboard: any) => keyboard.lightState(0);

describe('session keyboard bindings', () => {
  it('leaves memory, storage and observers unchanged after a rejected move', () => {
    const {keyboard, storage, onBindingsChange} = loadKeyboard();
    keyboard.bind('agent-a', 0, '#FF3040');
    keyboard.bind('agent-b', 1, '#00D9FF');
    const saved = storage.get(storageKey);
    onBindingsChange.mockClear();

    expect(() => keyboard.bind('agent-a', 1)).toThrow('已被其他 Session 使用');
    expect(keyboard.getBinding('agent-a')).toEqual({agentId: 'agent-a', slot: 0, color: '#FF3040'});
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
    expect(loadKeyboard(storage).keyboard.getBindings()).toEqual([
      {slot: 3, agentId: 'agent-a', color: '#00D9FF'}
    ]);
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
  // Event-by-event tracking lives on the server (test/activity.test.ts); lights only map its state.
  const activity = (fields: Record<string, unknown> = {}) => ({
    run: null,
    phase: {kind: 'idle', since: 1},
    bash: [],
    dialogs: [],
    ...fields
  });
  const phase = (kind: string, extra: Record<string, unknown> = {}) =>
    activity({run: {startedAt: 1}, phase: {kind, since: 1, ...extra}});

  it.each([
    ['waiting_llm', 4, 0.12],
    ['thinking', 4, 0.12],
    ['generating', 4, 0.12],
    ['preparing_tool', 4, 0.12],
    ['compacting', 4, 0.12],
    ['running_tools', 4, 0.45],
    ['retrying', 4, 0.8]
  ])('maps the %s phase to its light', (kind, effect, speed) => {
    const keyboard = boundKeyboard();
    keyboard.setActivity(
      'agent-a',
      phase(kind, kind === 'running_tools' ? {tools: [{toolCallId: 't'}]} : {})
    );
    expect(light(keyboard)).toMatchObject({effect, speed});
  });

  it('lets dialogs win over tools, and shell commands count as tools while the LLM is idle', () => {
    const keyboard = boundKeyboard();
    keyboard.setActivity('agent-a', activity({bash: [{id: 'b', since: 1}]}));
    expect(light(keyboard)).toMatchObject({effect: 4, speed: 0.45});
    keyboard.setActivity('agent-a', {...phase('running_tools'), dialogs: [{requestId: 'q', since: 1}]});
    expect(light(keyboard)).toMatchObject({effect: 6, speed: 0.1});
    keyboard.setActivity('agent-a', activity());
    expect(light(keyboard)).toMatchObject({effect: 1, speed: 0});
    expect(keyboard.activities.size).toBe(0);
  });

  it('takes activity from status updates that carry it and keeps it for those that do not', () => {
    const keyboard = boundKeyboard();
    keyboard.updateAgent({...agent('streaming'), activity: phase('running_tools')});
    keyboard.updateAgent(agent('streaming'));
    expect(light(keyboard).speed).toBe(0.45);
    keyboard.updateAgent({...agent(), activity: activity()});
    expect(light(keyboard).effect).toBe(1);
  });

  it('falls back to the Agent status without activity', () => {
    const keyboard = boundKeyboard();
    keyboard.updateAgent(agent('streaming'));
    expect(light(keyboard)).toMatchObject({effect: 4, speed: 0.15});
    keyboard.updateAgent(agent('waiting_for_user'));
    expect(light(keyboard)).toMatchObject({effect: 6, speed: 0.1});
  });

  it.each(['unloaded', 'stopped', 'error'])('clears activity when an agent becomes %s', status => {
    const keyboard = boundKeyboard();
    keyboard.setActivity('agent-a', activity({bash: [{id: 'b', since: 1}]}));
    keyboard.updateAgent(agent(status));
    expect(light(keyboard).effect).toBe(1);
    expect(keyboard.activities.size).toBe(0);
  });

  it('turns lights off and clears activity, but keeps bindings, when a server disconnects', () => {
    const keyboard = boundKeyboard();
    keyboard.setActivity('agent-a', phase('running_tools'));
    keyboard.setAgents([]);
    expect(light(keyboard).effect).toBe(0);
    expect(keyboard.activities.size).toBe(0);
    expect(keyboard.getBinding('agent-a')).not.toBeNull();
    keyboard.setAgents([agent()]);
    expect(light(keyboard).effect).toBe(1);
  });
});
