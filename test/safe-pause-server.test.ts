import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import WebSocket from 'ws';
import {Check} from 'typebox/value';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};

/** A run that stays streaming until the test releases it. */
class HeldBackend extends MockBackend {
  release = () => {};
  protected override runTurn() {
    return new Promise<void>(resolve => {
      this.release = () => resolve();
    });
  }
}

let server: RemotePiServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-pi-pause-')),
    root = await mkdtemp(path.join(tmpdir(), 'remote-pi-pause-ws-'));
  const workspaces = new WorkspaceStore(),
    backends: HeldBackend[] = [];
  const agents = new AgentManager(workspaces, (id, cwd) => {
    const backend = new HeldBackend(id, cwd);
    backends.push(backend);
    return backend;
  });
  server = new RemotePiServer({port: 0, dataDir: dir, workspaces, agents});
  const {token} = await server.auth.init(),
    address = await server.start(),
    base = `http://127.0.0.1:${address!.port}`;
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const request = (method: string, url: string, body?: unknown) =>
    fetch(base + url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const workspace = (await (await request('POST', '/api/v1/workspaces', {label: 'x', rootPath: root})).json())
    .data;
  const agent = (await (await request('POST', '/api/v1/agents', {workspaceId: workspace.id})).json()).data;
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, {
    headers: {authorization: `Bearer ${token}`}
  });
  await once(socket, 'open');
  const frames: any[] = [];
  socket.on('message', data => frames.push(JSON.parse(String(data))));
  socket.send(JSON.stringify({type: 'subscribe_all'}));
  await expect.poll(() => frames.some(frame => frame.type === 'subscribed_all')).toBe(true);
  const pauseEvents = () =>
    frames.filter(frame => frame.type === 'agent_event' && frame.event.type === 'safe_pause');
  const lastActivity = () =>
    frames.filter(frame => frame.type === 'agent_event' && frame.event.type === 'activity_changed').at(-1)
      ?.event.activity;
  return {agents, agent, backends, request, socket, pauseEvents, lastActivity};
}

describe('safe pause over HTTP and the overview WebSocket', () => {
  it('publishes pause progress and the pending pause in the activity', async () => {
    const {agents, agent, backends, request, socket, pauseEvents, lastActivity} = await setup();
    const running = request('POST', `/api/v1/agents/${agent.agentId}/prompt`, {message: 'work'});
    await expect.poll(() => agents.get(agent.agentId).record.status).toBe('streaming');

    const paused = await request('POST', `/api/v1/agents/${agent.agentId}/pause`);
    expect(paused.status).toBe(200);
    await expect.poll(() => pauseEvents().map(frame => frame.event.state)).toEqual(['requested']);
    await expect.poll(() => lastActivity()?.pauseRequested).toEqual({since: expect.any(Number)});

    expect((await request('DELETE', `/api/v1/agents/${agent.agentId}/pause`)).status).toBe(200);
    await expect
      .poll(() => pauseEvents().map(frame => frame.event.state))
      .toEqual(['requested', 'cancelled']);
    await expect.poll(() => lastActivity()).not.toHaveProperty('pauseRequested');

    // A mock run is one final answer, so a pause it never reaches ends as `finished`.
    await request('POST', `/api/v1/agents/${agent.agentId}/pause`);
    backends[0].release();
    await running;
    await expect
      .poll(() => pauseEvents().map(frame => frame.event.state))
      .toEqual(['requested', 'cancelled', 'requested', 'finished']);
    for (const frame of pauseEvents()) expect(Check(schema, frame)).toBe(true);
    socket.terminate();
  });

  it('rejects a pause while the agent is idle', async () => {
    const {agent, request, socket} = await setup();
    const response = await request('POST', `/api/v1/agents/${agent.agentId}/pause`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('AGENT_NOT_RUNNING');
    socket.terminate();
  });
});
