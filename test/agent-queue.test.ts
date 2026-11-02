import {describe, it, expect, afterEach, vi} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {once} from 'node:events';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend, type AgentEvent} from '../src/agents.js';
import {Check} from 'typebox/value';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};

/** Steering and follow-up messages Pi queues for a running turn, surfaced so a client can show and clear them. */
class HeldBackend extends MockBackend {
  release = () => {};
  protected override runTurn() {
    return new Promise<void>(resolve => {
      this.release = () => resolve();
    });
  }
}
let server: RemotePiServer | undefined;
const runningBackends: HeldBackend[] = [];
afterEach(async () => {
  for (const backend of runningBackends.splice(0)) backend.release();
  await server?.stop();
  server = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-pi-queue-')),
    root = await mkdtemp(path.join(tmpdir(), 'remote-pi-queue-ws-'));
  const workspaces = new WorkspaceStore(),
    backends: HeldBackend[] = [];
  const agents = new AgentManager(workspaces, (id, cwd) => {
    const backend = new HeldBackend(id, cwd);
    backends.push(backend);
    runningBackends.push(backend);
    return backend;
  });
  server = new RemotePiServer({port: 0, dataDir: dir, workspaces, agents});
  const {token} = await server.auth.init(),
    address = await server.start(),
    base = `http://127.0.0.1:${address!.port}`;
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const post = (url: string, body = {}) =>
    fetch(base + url, {method: 'POST', headers, body: JSON.stringify(body)});
  const workspace = (await (await post('/api/v1/workspaces', {label: 'x', rootPath: root})).json()).data;
  const agent = (await (await post('/api/v1/agents', {workspaceId: workspace.id})).json()).data;
  return {agents, agent, backends, base, token, headers, post};
}

describe('queued steering and follow-up messages', () => {
  it.each(['prompt', 'steer', 'follow-up'])(
    'acknowledges an idle HTTP %s before the running turn completes',
    async kind => {
      const {agents, agent, backends, base, headers} = await setup();
      const response = await fetch(`${base}/api/v1/agents/${agent.agentId}/${kind}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({message: 'work'}),
        signal: AbortSignal.timeout(3000)
      });
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({success: true});
      expect(agents.get(agent.agentId)).toMatchObject({
        promptPending: true,
        writes: 1,
        record: {status: 'streaming'}
      });
      expect(await agents.queue(agent.agentId)).toEqual({steering: [], followUp: []});
      backends[0].release();
      await expect.poll(() => agents.get(agent.agentId).record.status).toBe('idle');
      expect((await agents.timeline(agent.agentId)).items.filter(item => item.kind === 'user')).toHaveLength(
        1
      );
    }
  );

  it('returns a preflight rejection instead of acknowledging a message that cannot run', async () => {
    const {agent, backends, post} = await setup();
    vi.spyOn(backends[0], 'prompt').mockRejectedValue(
      Object.assign(new Error('No API key'), {code: 'PI_MODEL_UNAVAILABLE'})
    );
    const response = await post(`/api/v1/agents/${agent.agentId}/prompt`, {message: 'work'});
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: 'PI_MODEL_UNAVAILABLE',
      message: 'No API key'
    });
  });

  it('acknowledges WebSocket commands before completion and reconnects without repeating them', async () => {
    const {agents, agent, backends, base, token} = await setup();
    const prompt = vi.spyOn(backends[0], 'prompt');
    const open = async () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, [`access-token.${token}`]);
      await once(socket, 'open');
      const messages: any[] = [];
      socket.on('message', data => messages.push(JSON.parse(String(data))));
      return {socket, messages};
    };
    const first = await open();
    try {
      first.socket.send(
        JSON.stringify({type: 'prompt', requestId: 'send-1', agentId: agent.agentId, message: 'work'})
      );
      await vi.waitFor(() =>
        expect(first.messages).toContainEqual({type: 'command_result', requestId: 'send-1', success: true})
      );
      expect(agents.get(agent.agentId).record.status).toBe('streaming');
    } finally {
      first.socket.terminate();
    }
    const resumed = await open();
    try {
      resumed.socket.send(JSON.stringify({type: 'subscribe_all'}));
      resumed.socket.send(JSON.stringify({type: 'focus', agentId: agent.agentId}));
      await vi.waitFor(() =>
        expect(resumed.messages.some(message => message.type === 'focus_state')).toBe(true)
      );
      expect(resumed.messages).toContainEqual(
        expect.objectContaining({type: 'agent_state', state: expect.objectContaining({status: 'streaming'})})
      );
      expect(prompt).toHaveBeenCalledOnce();
      expect(await agents.queue(agent.agentId)).toEqual({steering: [], followUp: []});
    } finally {
      resumed.socket.terminate();
    }
  });

  it('continues a prompt accepted after the HTTP client disconnects, without adding a retry on reconnect', async () => {
    const {agents, agent, backends, base, headers} = await setup();
    let accept!: () => void;
    const preflight = new Promise<void>(resolve => {
      accept = resolve;
    });
    const original = backends[0].prompt.bind(backends[0]);
    const prompt = vi.spyOn(backends[0], 'prompt').mockImplementation(async (...args) => {
      await preflight;
      return original(...args);
    });
    const controller = new AbortController();
    const response = fetch(`${base}/api/v1/agents/${agent.agentId}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({message: 'work'}),
      signal: controller.signal
    }).catch(error => error);
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      controller.abort();
      expect((await response).name).toBe('AbortError');
    } finally {
      accept();
    }
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('streaming');
    const state = await fetch(`${base}/api/v1/agents/${agent.agentId}/state`, {headers});
    expect((await state.json()).data.status).toBe('streaming');
    expect(prompt).toHaveBeenCalledOnce();
    expect(await agents.queue(agent.agentId)).toEqual({steering: [], followUp: []});
  });

  it('reports whether a message reached the turn and exposes the queue', async () => {
    const {agents, agent, backends, base, headers, post} = await setup();
    const events: AgentEvent[] = [];
    agents.subscribeAll((agentId, published) => agentId === agent.agentId && events.push(published.event));
    // An idle steer must start a real turn, not report success without doing work.
    const first = post(`/api/v1/agents/${agent.agentId}/steer`, {message: 'now'});
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('streaming');
    backends[0].release();
    expect((await (await first).json()).data).toEqual({success: true});
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('idle');
    expect(
      (await (await fetch(base + `/api/v1/agents/${agent.agentId}/queue`, {headers})).json()).data
    ).toEqual({steering: [], followUp: []});

    const running = post(`/api/v1/agents/${agent.agentId}/prompt`, {message: 'work'});
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('streaming');
    expect(
      (await (await post(`/api/v1/agents/${agent.agentId}/steer`, {message: 'redirect'})).json()).data
    ).toEqual({success: true, disposition: 'queued'});
    expect(
      (await (await post(`/api/v1/agents/${agent.agentId}/follow-up`, {message: 'and then'})).json()).data
    ).toEqual({success: true, disposition: 'queued'});
    const queued = {steering: ['redirect'], followUp: ['and then']};
    expect(
      (await (await fetch(base + `/api/v1/agents/${agent.agentId}/queue`, {headers})).json()).data
    ).toEqual(queued);
    expect(agents.snapshotState(agent.agentId).activity.queue).toEqual(queued);
    expect(events.filter(event => event.type === 'queue_update').at(-1)).toMatchObject(queued);
    const move = `/api/v1/agents/${agent.agentId}/queue/move`;
    expect(
      (await (await post(move, {from: 'steering', index: 0, expected: 'redirect'})).json()).data
    ).toEqual({steering: [], followUp: ['and then', 'redirect']});
    const stale = await post(move, {from: 'steering', index: 0, expected: 'redirect'});
    expect(stale.status).toBe(400);
    expect((await stale.json()).error.code).toBe('QUEUE_CHANGED');
    expect(
      (await (await post(move, {from: 'followUp', index: 1, expected: 'redirect'})).json()).data
    ).toEqual(queued);

    // Clearing returns the messages so a client can restore them to its composer.
    expect(
      (
        await (
          await fetch(base + `/api/v1/agents/${agent.agentId}/queue`, {method: 'DELETE', headers})
        ).json()
      ).data
    ).toEqual(queued);
    expect(agents.snapshotState(agent.agentId).activity.queue).toEqual({steering: [], followUp: []});
    // A message queued while the clear runs stays queued: the cache follows queue_update, not the reply.
    await post(`/api/v1/agents/${agent.agentId}/steer`, {message: 'after clear'});
    expect(agents.snapshotState(agent.agentId).activity.queue).toEqual({
      steering: ['after clear'],
      followUp: []
    });
    backends[0].release();
    await running;
  });

  it('clears the queue over the WebSocket within the published protocol', async () => {
    const {agents, agent, base, token, post, backends} = await setup();
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, {
      headers: {authorization: `Bearer ${token}`}
    });
    await once(socket, 'open');
    const messages: any[] = [];
    socket.on('message', data => messages.push(JSON.parse(String(data))));
    socket.send(JSON.stringify({type: 'subscribe', agentId: agent.agentId}));
    const running = post(`/api/v1/agents/${agent.agentId}/prompt`, {message: 'work'});
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('streaming');
    await post(`/api/v1/agents/${agent.agentId}/steer`, {message: 'redirect'});
    const command = {type: 'clear-queue', requestId: 'r1', agentId: agent.agentId};
    expect(Check(schema, command)).toBe(true);
    socket.send(JSON.stringify(command));
    const result = await new Promise<any>(resolve => {
      const check = () => {
        const found = messages.find(
          message => message.type === 'command_result' && message.requestId === 'r1'
        );
        found ? resolve(found) : setTimeout(check, 10);
      };
      check();
    });
    expect(result).toMatchObject({success: true, queue: {steering: ['redirect'], followUp: []}});
    expect(Check(schema, result)).toBe(true);
    socket.terminate();
    backends[0].release();
    await running;
  });
});
