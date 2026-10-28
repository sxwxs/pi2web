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
async function setup(onCreate?: (backend: HeldBackend, index: number) => Promise<void> | void) {
  const workspaces = new WorkspaceStore();
  await workspaces.add('test', await mkdtemp(path.join(tmpdir(), 'pi2web-dispatch-')));
  const backends: HeldBackend[] = [];
  const agents = new AgentManager(workspaces, async (id, cwd) => {
    const backend = new HeldBackend(id, cwd);
    backends.push(backend);
    await onCreate?.(backend, backends.length - 1);
    return backend;
  });
  const agent = await agents.create(workspaces.list()[0].id);
  return {agents, id: agent.agentId, backend: backends[0], backends, workspaces};
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

  it('reserves an admitted input before loading/state awaits, so replacement cannot overtake it', async () => {
    const {agents, id, backend} = await setup();
    const prompt = vi.spyOn(backend, 'prompt');
    const pending = agents.command(id, 'prompt', 'one');
    const persist = vi.fn();
    await expect(agents.setTemplate(id, template, persist)).rejects.toMatchObject({code: 'SESSION_STARTED'});
    expect(persist).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    backend.turn.resolve();
    await pending;
    await agents.dispose(id);
  });

  it('rejects an input whose state read outlives Stop', async () => {
    const {agents, id, backend} = await setup();
    const snapshot = await backend.getState(),
      state = deferred<typeof snapshot>();
    vi.spyOn(backend, 'getState').mockReturnValue(state.promise);
    const prompt = vi.spyOn(backend, 'prompt');
    const pending = agents.command(id, 'prompt', 'one').catch(error => error);
    await Promise.resolve();
    await agents.dispose(id);
    state.resolve(snapshot);
    expect((await pending).code).toBe('SESSION_BUSY');
    expect(prompt).not.toHaveBeenCalled();
    await agents.dispose(id);
  });

  it('rejects template replacement while a session write is running', async () => {
    const {agents, id, backend} = await setup();
    const release = deferred<void>();
    const run = backend.runBash.bind(backend);
    vi.spyOn(backend, 'runBash').mockImplementation(async (...args) => {
      await release.promise;
      return run(...args);
    });
    const bash = agents.runBash(id, 'mock command');
    const persist = vi.fn();
    await expect(agents.setTemplate(id, template, persist)).rejects.toMatchObject({code: 'SESSION_STARTED'});
    expect(persist).not.toHaveBeenCalled();
    release.resolve();
    await bash;
    await expect(agents.setTemplate(id, template, persist)).rejects.toMatchObject({code: 'SESSION_STARTED'});
    await agents.dispose(id);
  });

  it.each(['dispose', 'remove', 'archive'] as const)(
    'invalidates an unfinished template replacement on %s',
    async operation => {
      const {agents, id, backend} = await setup();
      const entered = deferred<void>(),
        release = deferred<void>();
      const capabilities = backend.getCapabilities.bind(backend);
      vi.spyOn(backend, 'getCapabilities').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return capabilities();
      });
      const persist = vi.fn();
      const changing = agents.setTemplate(id, template, persist).catch(error => error);
      await entered.promise;
      const bash = vi.spyOn(backend, 'runBash');
      await expect(agents.runBash(id, 'mock command')).rejects.toMatchObject({code: 'SESSION_BUSY'});
      expect(bash).not.toHaveBeenCalled();
      await agents[operation](id);
      release.resolve();
      expect((await changing).code).toBe('SESSION_BUSY');
      expect(persist).not.toHaveBeenCalled();
      if (operation === 'dispose') {
        expect(agents.isLoaded(id)).toBe(false);
        await agents.dispose(id);
      } else expect(() => agents.get(id)).toThrow('Agent not found');
    }
  );

  it('releases a candidate that finishes initializing after Stop', async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const {agents, id, backends} = await setup(async (_backend, index) => {
      if (index === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const persist = vi.fn();
    const changing = agents.setTemplate(id, template, persist).catch(error => error);
    await entered.promise;
    await agents.dispose(id);
    release.resolve();
    expect((await changing).code).toBe('SESSION_BUSY');
    expect(persist).not.toHaveBeenCalled();
    for (const candidate of backends.slice(1)) expect((await candidate.getState()).status).toBe('stopped');
    expect(agents.isLoaded(id)).toBe(false);
  });

  it('blocks new commands while Stop is releasing the backend', async () => {
    const {agents, id, backend} = await setup();
    const release = deferred<void>();
    const dispose = backend.dispose.bind(backend);
    vi.spyOn(backend, 'dispose').mockImplementation(async () => {
      await release.promise;
      await dispose();
    });
    const stopping = agents.dispose(id);
    await expect(agents.runBash(id, 'mock command')).rejects.toMatchObject({code: 'SESSION_BUSY'});
    await expect(agents.command(id, 'prompt', 'one')).rejects.toMatchObject({code: 'SESSION_BUSY'});
    release.resolve();
    await stopping;
    expect(agents.isLoaded(id)).toBe(false);
  });

  it('does not attach a lazy load that finishes after Stop was requested', async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const {agents, id, backends} = await setup(async (_backend, index) => {
      if (index === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    await agents.dispose(id);
    const loading = agents.command(id, 'prompt', 'one').catch(error => error);
    await entered.promise;
    const stopping = agents.dispose(id);
    expect(agents.dispose(id)).toBe(stopping);
    release.resolve();
    await stopping;
    expect((await loading).code).toBe('SESSION_BUSY');
    expect(agents.isLoaded(id)).toBe(false);
    expect((await backends[1].getState()).status).toBe('stopped');
  });

  it('blocks every session mutation while a replacement is being prepared', async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const {agents, id} = await setup(async (_backend, index) => {
      if (index === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const changing = agents.setTemplate(id, template, vi.fn());
    await entered.promise;
    const attempts = [
      () => agents.command(id, 'prompt', 'one'),
      () => agents.runBash(id, 'mock'),
      () => agents.compact(id),
      () => agents.setModel(id, 'p', 'm'),
      () => agents.setThinkingLevel(id, 'off'),
      () => agents.setSessionName(id, 'name'),
      () => agents.navigate(id, 'entry'),
      () => agents.fork(id, 'entry'),
      () => agents.extensionResponse(id, 'request', 'answer'),
      () => agents.moveQueue(id, 'steering', 0, 'queued'),
      () => agents.clearQueue(id)
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({code: 'SESSION_BUSY'});
    release.resolve();
    await changing;
    await agents.dispose(id);
  });

  it('releases write admission after a failed mutation', async () => {
    const {agents, id, backend} = await setup();
    vi.spyOn(backend, 'runBash').mockRejectedValueOnce(Error('command failed'));
    await expect(agents.runBash(id, 'mock')).rejects.toThrow('command failed');
    const persist = vi.fn();
    await agents.setTemplate(id, template, persist);
    expect(persist).toHaveBeenCalledOnce();
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
