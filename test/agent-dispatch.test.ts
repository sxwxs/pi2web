import {describe, it, expect, vi} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentManager, MockBackend} from '../src/agents.js';
import {WorkspaceStore} from '../src/workspaces.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
};
class HeldBackend extends MockBackend {
  turn = deferred<void>();
  protected override runTurn() {
    return this.turn.promise;
  }
}
async function setup() {
  const workspaces = new WorkspaceStore();
  await workspaces.add('test', await mkdtemp(path.join(tmpdir(), 'pi2web-dispatch-')));
  const backends: HeldBackend[] = [];
  const agents = new AgentManager(workspaces, (id, cwd) => {
    const backend = new HeldBackend(id, cwd);
    backends.push(backend);
    return backend;
  });
  const agent = await agents.create(workspaces.list()[0].id);
  return {agents, id: agent.agentId, backend: backends[0], backends};
}
const template = {id: 't', name: 'T', mode: 'append' as const, systemPrompt: 'Review only.'};

describe('Agent command admission', () => {
  it.each(['prompt', 'steer', 'follow-up'] as const)(
    'reserves one first turn and queues a concurrent %s',
    async kind => {
      const {agents, id, backend} = await setup();
      const prompt = vi.spyOn(backend, 'prompt');
      const first = agents.command(id, 'prompt', 'one');
      expect(await agents.command(id, kind, 'two')).toBe('queued');
      expect(prompt).toHaveBeenCalledOnce();
      expect(await agents.queue(id)).toEqual(
        kind === 'steer' ? {steering: ['two'], followUp: []} : {steering: [], followUp: ['two']}
      );
      backend.turn.resolve();
      await first;
      await agents.dispose(id);
    }
  );

  it('does not dispatch an admitted command while its session is being replaced', async () => {
    const {agents, id, backend} = await setup();
    const prompt = vi.spyOn(backend, 'prompt');
    const pending = agents.command(id, 'prompt', 'one').catch(error => error);
    await agents.setTemplate(id, template, vi.fn());
    expect((await pending).code).toBe('SESSION_BUSY');
    expect(prompt).not.toHaveBeenCalled();
    expect(agents.get(id).backend).not.toBe(backend);
    await agents.dispose(id);
  });

  it('rejects a stale backend after a state read outlives the entire replacement', async () => {
    const {agents, id, backend} = await setup();
    const snapshot = await backend.getState(),
      state = deferred<typeof snapshot>();
    vi.spyOn(backend, 'getState').mockReturnValue(state.promise);
    const prompt = vi.spyOn(backend, 'prompt');
    const pending = agents.command(id, 'prompt', 'one').catch(error => error);
    await Promise.resolve();
    await agents.setTemplate(id, template, vi.fn());
    state.resolve(snapshot);
    expect((await pending).code).toBe('SESSION_BUSY');
    expect(prompt).not.toHaveBeenCalled();
    await agents.dispose(id);
  });

  it('disposes only the candidate when template persistence fails', async () => {
    const {agents, id, backend, backends} = await setup();
    const original = agents.get(id).record;
    const persist = vi.fn(() => {
      expect(agents.get(id).record).toBe(original);
      expect(agents.get(id).backend).toBe(backend);
      throw Error('save failed');
    });
    await expect(agents.setTemplate(id, template, persist)).rejects.toThrow('save failed');
    expect(persist).toHaveBeenCalledOnce();
    expect(agents.get(id).record).toBe(original);
    expect(agents.get(id).backend).toBe(backend);
    expect((await backend.getState()).status).toBe('idle');
    expect((await backends[1].getState()).status).toBe('stopped');
    expect(agents.get(id).templateChanging).toBe(false);
    await agents.dispose(id);
  });

  it('rejects replacement once a prompt owns the turn, without blocking abort', async () => {
    const {agents, id, backend} = await setup();
    const running = agents.command(id, 'prompt', 'one');
    await vi.waitFor(() => expect(agents.get(id).promptPending).toBe(true));
    const persist = vi.fn();
    await expect(agents.setTemplate(id, template, persist)).rejects.toMatchObject({code: 'SESSION_STARTED'});
    expect(persist).not.toHaveBeenCalled();
    await agents.command(id, 'abort');
    expect((await backend.getState()).status).toBe('idle');
    backend.turn.resolve();
    await running;
    await agents.dispose(id);
  });
});
