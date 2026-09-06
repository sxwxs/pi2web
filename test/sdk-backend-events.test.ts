import {afterEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {createAgentSession, SessionManager, type ExtensionUIContext} from '@earendil-works/pi-coding-agent';
import {SdkBackend} from '../src/sdk-backend.js';
import type {AgentEvent} from '../src/agents.js';

vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({
  ...await importOriginal<typeof import('@earendil-works/pi-coding-agent')>(),
  createAgentSession:vi.fn(),
}));

const backends:SdkBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Exercise the public SDK adapter with a fake session: no model calls or user files. */
async function createBackend() {
  const sessionEvents = new EventEmitter();
  let ui!:ExtensionUIContext;
  const session = {
    sessionId:'test-session', isStreaming:false, state:{messages:[], model:null},
    bindExtensions:async (options:{uiContext:ExtensionUIContext}) => { ui = options.uiContext; },
    executeBash:vi.fn(), abort:vi.fn(async () => {}), dispose:vi.fn(),
    subscribe(listener:(event:AgentEvent) => void) {
      sessionEvents.on('event', listener);
      return () => { sessionEvents.off('event', listener); };
    },
  };
  vi.spyOn(SessionManager, 'create').mockReturnValue(SessionManager.inMemory(process.cwd()));
  vi.mocked(createAgentSession).mockResolvedValue({session} as any);
  const backend = await SdkBackend.create('agent-a', process.cwd());
  backends.push(backend);
  const events:AgentEvent[] = [], otherClientEvents:AgentEvent[] = [];
  backend.subscribe(event => events.push(event));
  backend.subscribe(event => otherClientEvents.push(event));
  return {backend, session, sessionEvents, ui, events, otherClientEvents};
}

const bashResult = {output:'', exitCode:0, cancelled:false, truncated:false};

describe('SDK backend activity events', () => {
  it('announces a silent bash command before waiting for its completion', async () => {
    const {backend, session, events, otherClientEvents} = await createBackend();
    let finish!:(value:typeof bashResult) => void;
    session.executeBash.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const running = backend.runBash('sleep 30');
    expect(events).toEqual([{type:'bash_execution_start', id:expect.any(String), command:'sleep 30'}]);
    const id = events[0].id;
    expect(session.executeBash).toHaveBeenCalledWith('sleep 30', undefined, {excludeFromContext:false, id});
    finish(bashResult);
    expect(await running).toEqual({id, ...bashResult});
    expect(events[1]).toMatchObject({type:'bash_execution_end', id, ...bashResult});
    expect(otherClientEvents).toEqual(events);
  });

  it('pairs the start with an end event when bash execution fails', async () => {
    const {backend, session, events} = await createBackend();
    session.executeBash.mockRejectedValue(new Error('Shell unavailable'));
    await expect(backend.runBash('command')).rejects.toThrow('Shell unavailable');
    expect(events.map(event => event.type)).toEqual(['bash_execution_start', 'bash_execution_end']);
    expect(events[1]).toMatchObject({id:events[0].id, isError:true, errorMessage:'Shell unavailable'});
  });

  it('broadcasts dialog completion before the extension can emit its next event', async () => {
    const {backend, sessionEvents, ui, events, otherClientEvents} = await createBackend();
    const answer = ui.confirm('Continue?', 'Confirm the operation').then(value => {
      sessionEvents.emit('event', {type:'agent_settled'});
      return value;
    });
    const requestId = String(events[0].requestId);
    await backend.extensionResponse(requestId, true);
    expect(await answer).toBe(true);
    expect(events.map(event => event.type)).toEqual(['extension_ui_request', 'extension_ui_response', 'agent_settled']);
    expect(events[1]).toEqual({type:'extension_ui_response', requestId});
    expect(otherClientEvents).toEqual(events);
    expect((await backend.getState()).status).toBe('idle');
  });

  it('resolves only the matching dialog and does not broadcast the answer value', async () => {
    const {backend, ui, events} = await createBackend();
    const first = ui.input('First'), second = ui.input('Second');
    const firstId = String(events[0].requestId), secondId = String(events[1].requestId);
    await backend.extensionResponse(secondId, 'private answer');
    expect(await second).toBe('private answer');
    expect(events[2]).toEqual({type:'extension_ui_response', requestId:secondId});
    await backend.extensionResponse(firstId, 'other answer');
    expect(await first).toBe('other answer');
    await expect(backend.extensionResponse(firstId, 'duplicate')).rejects.toMatchObject({code:'EXTENSION_REQUEST_NOT_FOUND'});
    expect(events).toHaveLength(4);
  });

  it('broadcasts timeout once, so other clients can leave the waiting phase', async () => {
    vi.useFakeTimers();
    const {backend, ui, events, otherClientEvents} = await createBackend();
    const answer = ui.confirm('Continue?', 'No client answers this');
    const requestId = String(events[0].requestId);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await answer).toBe(false);
    expect(events[1]).toEqual({type:'extension_ui_response', requestId});
    expect(otherClientEvents).toEqual(events);
    await expect(backend.extensionResponse(requestId, true)).rejects.toMatchObject({code:'EXTENSION_REQUEST_NOT_FOUND'});
    expect(events).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes pending dialogs when disposed and does not resolve them twice', async () => {
    vi.useFakeTimers();
    const {backend, ui, events} = await createBackend();
    const first = ui.input('First'), second = ui.input('Second');
    const requestIds = events.map(event => event.requestId);
    await backend.dispose();
    expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
    expect(events.slice(2)).toEqual(requestIds.map(requestId => ({type:'extension_ui_response', requestId})));
    await backend.dispose();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(events).toHaveLength(4);
    expect((await backend.getState()).status).toBe('stopped');
  });
});
