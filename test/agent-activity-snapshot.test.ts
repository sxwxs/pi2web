import {afterEach, describe, expect, it, vi} from 'vitest';
import {once} from 'node:events';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {AgentManager, MockBackend, type AgentEvent} from '../src/agents.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {Check} from 'typebox/value';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};

class ControlledBackend extends MockBackend {
  publish!: (event: AgentEvent) => void;
  override subscribe(listener: (event: AgentEvent) => void) {
    this.publish = listener;
    return super.subscribe(listener);
  }
  /** Record a message the way Pi does: after listeners saw it. */
  record(message: Record<string, unknown>) {
    return this.append(message);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-agent-socket-'));
  const workspaceDir = path.join(dir, 'workspace');
  await mkdir(workspaceDir);
  const workspaces = new WorkspaceStore(),
    workspace = workspaces.add('test', workspaceDir);
  const backends: ControlledBackend[] = [];
  const agents = new AgentManager(workspaces, (id, cwd) => {
    const backend = new ControlledBackend(id, cwd);
    backends.push(backend);
    return backend;
  });
  const server = new RemotePiServer({port: 0, dataDir: path.join(dir, 'data'), workspaces, agents});
  const sockets: WebSocket[] = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    await server.stop();
    await rm(dir, {recursive: true, force: true});
  });
  const {token} = await server.auth.init(),
    address = await server.start();
  const agent = await agents.create(workspace.id),
    backend = backends[0];
  const publish = (event: AgentEvent) => backend.publish(event);
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/ws`, {
      headers: {authorization: `Bearer ${token}`}
    });
    sockets.push(socket);
    const messages: any[] = [];
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(socket, 'open');
    return {
      socket,
      messages,
      send: (message: unknown) => socket.send(JSON.stringify(message)),
      async wait(predicate: (message: any) => boolean) {
        await vi.waitFor(() => expect(messages.some(predicate)).toBe(true));
        return messages.find(predicate);
      },
      /** Round trip: everything the server sent before this is in `messages`. */
      async barrier() {
        const count = messages.filter(m => m.type === 'subscribed_drafts').length;
        socket.send(JSON.stringify({type: 'subscribe_drafts'}));
        await vi.waitFor(() =>
          expect(messages.filter(m => m.type === 'subscribed_drafts')).toHaveLength(count + 1)
        );
      }
    };
  }
  return {
    agents,
    agent,
    backend,
    backends,
    publish,
    connect,
    workspaces,
    unload: () =>
      fetch(`http://127.0.0.1:${address!.port}/api/v1/agents/${agent.agentId}`, {
        method: 'DELETE',
        headers: {authorization: `Bearer ${token}`}
      })
  };
}

const dialogRequest = {
  type: 'extension_ui_request',
  requestId: 'dialog-1',
  kind: 'confirm',
  title: 'Confirm',
  message: 'Continue?'
};
const startWork = (publish: (event: AgentEvent) => void) => {
  publish({type: 'bash_execution_start', id: 'bash-1', command: 'sleep 30'});
  publish(dialogRequest);
};
const emptyQueue = {steering: [], followUp: []};
const since = expect.any(Number);
const active = {
  run: null,
  phase: {kind: 'idle', since},
  bash: [{id: 'bash-1', command: 'sleep 30', since}],
  dialogs: [{requestId: 'dialog-1', title: 'Confirm', since}],
  dialogRequests: [dialogRequest],
  queue: emptyQueue
};
const idle = {
  run: null,
  phase: {kind: 'idle', since},
  bash: [],
  dialogs: [],
  dialogRequests: [],
  queue: emptyQueue
};
/** `active` with concrete times, for schema checks. */
const activeValue = {
  ...active,
  phase: {kind: 'idle', since: 1},
  bash: [{id: 'bash-1', command: 'sleep 30', since: 1}],
  dialogs: [{requestId: 'dialog-1', title: 'Confirm', since: 1}]
};

describe('WebSocket schema', () => {
  it('requires core state fields and validates activity', () => {
    const state = {agentId: 'agent-a', sessionId: 'session-a', cwd: '/workspace', status: 'idle'};
    const message = {type: 'agent_state', agentId: state.agentId, state};
    expect(Check(schema, message)).toBe(true);
    expect(Check(schema, {...message, state: {...state, activity: activeValue}})).toBe(true);
    expect(
      Check(schema, {
        ...message,
        state: {...state, activity: {...activeValue, phase: {kind: 'nope', since: 1}}}
      })
    ).toBe(false);
    for (const key of ['agentId', 'sessionId', 'cwd', 'status']) {
      const incomplete: Record<string, unknown> = {...state};
      delete incomplete[key];
      expect(Check(schema, {...message, state: incomplete})).toBe(false);
    }
  });

  it('accepts the detail messages', () => {
    const item = {id: 'e1.0', kind: 'tool', status: 'pending', toolCallId: 't', size: 2, body: '{}'};
    for (const message of [
      {type: 'focus_state', agentId: 'a', sessionId: 's', live: {text: 'hi', thinking: ''}},
      {type: 'delta', agentId: 'a', kind: 'text', delta: 'hi'},
      {type: 'items', agentId: 'a', sessionId: 's', items: [item], clearLive: true},
      {type: 'timeline_reset', agentId: 'a', sessionId: 's'},
      {type: 'tool_output', agentId: 'a', toolCallId: 't', output: 'line'}
    ])
      expect(Check(schema, message)).toBe(true);
    expect(Check(schema, {type: 'items', agentId: 'a', sessionId: 's', items: [{id: 'x'}]})).toBe(false);
  });
});

describe('authoritative activity state', () => {
  it('tracks parallel operations independently of LLM turns and clears them by ID', async () => {
    const {agents, agent, backend, publish} = await setup();
    startWork(publish);
    publish({type: 'bash_execution_start', id: 'bash-2'});
    publish({type: 'bash_execution_update', id: 'bash-1', delta: 'output'});
    publish({type: 'extension_ui_request', requestId: 'dialog-2'});
    publish({type: 'agent_start'});
    publish({type: 'agent_end'});
    publish({type: 'agent_settled'});
    expect((await backend.getState()).status).toBe('idle');
    // A pending dialog blocks the run, which is reported as waiting_for_user rather than idle.
    expect(agents.snapshotState(agent.agentId)).toMatchObject({
      status: 'waiting_for_user',
      activity: {
        run: null,
        phase: {kind: 'idle'},
        bash: [{id: 'bash-1'}, {id: 'bash-2'}],
        dialogs: [{requestId: 'dialog-1'}, {requestId: 'dialog-2'}]
      }
    });
    expect(agents.get(agent.agentId).record).not.toHaveProperty('activity');
    publish({type: 'bash_execution_end', id: 'bash-2'});
    publish({type: 'extension_ui_response', requestId: 'dialog-2'});
    publish({type: 'bash_execution_end', id: 'unknown'});
    expect(agents.snapshotState(agent.agentId).activity).toEqual(active);
    publish({type: 'bash_execution_end', id: 'bash-1'});
    publish({type: 'extension_ui_response', requestId: 'dialog-1'});
    expect(agents.snapshotState(agent.agentId).activity).toEqual(idle);
  });

  it('drops runtime activity on unload/restore and ignores late events from the old backend', async () => {
    const {agents, agent, publish, workspaces} = await setup();
    startWork(publish);
    const saved = {...agents.get(agent.agentId).record};
    await agents.dispose(agent.agentId);
    publish({type: 'bash_execution_update', id: 'bash-1', delta: 'late output'});
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status: 'unloaded', activity: idle});
    const restored = new AgentManager(workspaces, () => {
      throw Error('must remain unloaded');
    });
    await restored.restore([saved]);
    expect(restored.snapshotState(agent.agentId)).toMatchObject({status: 'unloaded', activity: idle});
  });
});

describe('overview stream', () => {
  it('starts with the state of every Agent, including pending dialog payloads', async () => {
    const {agent, publish, connect} = await setup();
    startWork(publish);
    const client = await connect();
    client.send({type: 'subscribe_all'});
    await client.wait(m => m.type === 'subscribed_all');
    expect(client.messages.map(m => m.type)).toEqual(['agent_state', 'subscribed_all']);
    const state = client.messages[0];
    expect(state).toMatchObject({
      agentId: agent.agentId,
      state: {status: 'waiting_for_user', activity: active}
    });
    expect(Check(schema, state)).toBe(true);
  });

  it('sends the current status with every event, and nothing a viewer alone needs', async () => {
    const {agents, agent, publish, connect} = await setup();
    const client = await connect();
    client.send({type: 'subscribe_all'});
    await client.wait(m => m.type === 'subscribed_all');
    publish({type: 'agent_start'});
    expect(await client.wait(m => m.event?.type === 'agent_start')).toMatchObject({status: 'streaming'});
    publish(dialogRequest);
    expect(await client.wait(m => m.event?.type === 'extension_ui_request')).toMatchObject({
      status: 'waiting_for_user'
    });
    expect((await agents.state(agent.agentId)).status).toBe('waiting_for_user');
    publish({type: 'extension_ui_response', requestId: 'dialog-1'});
    expect(await client.wait(m => m.event?.type === 'extension_ui_response')).toMatchObject({
      status: 'streaming'
    });
    publish({
      type: 'message_end',
      message: {role: 'assistant', content: [{type: 'text', text: 'x'.repeat(5000)}]}
    });
    publish({type: 'bash_execution_start', id: 'b', command: 'ls'});
    publish({type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: {path: 'a'}});
    await client.barrier();
    const types = client.messages.filter(m => m.type === 'agent_event').map(m => m.event.type);
    for (const type of ['message_end', 'bash_execution_start', 'tool_execution_start'])
      expect(types).not.toContain(type);
    expect(client.messages.some(m => ['delta', 'items'].includes(m.type))).toBe(false);
  });

  it('broadcasts unloading so other clients can clear activity without reconnecting', async () => {
    const {agents, agent, publish, connect, unload, backends} = await setup();
    const observer = await connect();
    observer.send({type: 'subscribe_all'});
    await observer.wait(m => m.type === 'subscribed_all');
    startWork(publish);
    await observer.wait(m => m.event?.type === 'extension_ui_request');
    expect((await unload()).status).toBe(200);
    expect(await observer.wait(m => m.event?.type === 'agent_unloaded')).toMatchObject({
      type: 'agent_event',
      agentId: agent.agentId,
      status: 'unloaded'
    });
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status: 'unloaded', activity: idle});
    expect(backends).toHaveLength(1); // Observing unload must not reload the backend.
  });
});

describe('detail stream of the focused Agent', () => {
  it('starts with the text streamed so far and publishes recorded items replacing it', async () => {
    const {agent, backend, publish, connect} = await setup();
    publish({type: 'message_start', message: {role: 'assistant'}});
    publish({type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta: 'hmm '}});
    publish({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Hel'}});
    const client = await connect();
    client.send({type: 'focus', agentId: agent.agentId});
    const focus = await client.wait(m => m.type === 'focus_state');
    expect(focus).toMatchObject({
      agentId: agent.agentId,
      live: {text: 'Hel', thinking: 'hmm '},
      dialogRequests: []
    });
    publish({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'lo'}});
    const answer = {
      role: 'assistant',
      content: [
        {type: 'thinking', thinking: 'hmm '},
        {type: 'text', text: 'Hello'}
      ]
    };
    publish({type: 'message_end', message: answer});
    const entryId = backend.record(answer);
    const items = await client.wait(m => m.type === 'items');
    expect(items).toEqual({
      type: 'items',
      agentId: agent.agentId,
      sessionId: focus.sessionId,
      clearLive: true,
      items: [
        expect.objectContaining({id: `${entryId}.0`, kind: 'thinking', body: 'hmm '}),
        expect.objectContaining({id: `${entryId}.1`, kind: 'assistant', body: 'Hello'})
      ]
    });
    expect(client.messages.filter(m => m.type === 'delta')).toEqual([
      {type: 'delta', agentId: agent.agentId, kind: 'text', delta: 'lo'}
    ]);
  });

  it('updates a running tool in place and streams its output only to clients watching it', async () => {
    const {agent, backend, publish, connect} = await setup();
    const call = {type: 'toolCall', id: 'call-1', name: 'bash', arguments: {command: 'npm test'}};
    const watcher = await connect(),
      other = await connect();
    for (const client of [watcher, other]) {
      client.send({type: 'focus', agentId: agent.agentId});
      await client.wait(m => m.type === 'focus_state');
    }
    const entryId = backend.record({role: 'assistant', content: [call]});
    publish({type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: call.arguments});
    const pending = await watcher.wait(m => m.type === 'items');
    expect(pending.items).toEqual([
      expect.objectContaining({id: `${entryId}.0`, kind: 'tool', status: 'pending', summary: 'npm test'})
    ]);
    publish({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: {content: [{type: 'text', text: 'one'}]}
    });
    watcher.send({type: 'watch', toolCallId: 'call-1'});
    // Watching mid-run starts with the latest output.
    expect(await watcher.wait(m => m.type === 'tool_output')).toMatchObject({
      toolCallId: 'call-1',
      output: 'one'
    });
    publish({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: {content: [{type: 'text', text: 'two'}]}
    });
    await watcher.wait(m => m.type === 'tool_output' && m.output === 'two');
    backend.record({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{type: 'text', text: 'ok'}],
      isError: false,
      durationMs: 1200
    });
    publish({type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', isError: false});
    // A finished tool is an update to an item published before, not a new item.
    const done = await watcher.wait(m => m.type === 'items' && m.updated?.[0].status === 'ok');
    expect(done).toMatchObject({items: []});
    expect(done.updated).toEqual([
      expect.objectContaining({id: `${entryId}.0`, status: 'ok', durationMs: 1200, rev: expect.any(String)})
    ]);
    await other.barrier();
    expect(other.messages.some(m => m.type === 'tool_output')).toBe(false);
    expect(other.messages.some(m => m.type === 'items' && m.updated?.[0].status === 'ok')).toBe(true);
  });

  it('stops details when the focus moves away and resets the timeline when the branch changes', async () => {
    const {agents, agent, backend, publish, connect} = await setup();
    const client = await connect();
    client.send({type: 'focus', agentId: agent.agentId});
    const focus = await client.wait(m => m.type === 'focus_state');
    const first = backend.record({role: 'user', content: 'one'});
    backend.record({role: 'user', content: 'two'});
    publish({type: 'turn_end'});
    expect((await client.wait(m => m.type === 'items')).items.map((item: any) => item.body)).toEqual([
      'one',
      'two'
    ]);
    await agents.navigate(agent.agentId, first);
    expect(await client.wait(m => m.type === 'timeline_reset')).toEqual({
      type: 'timeline_reset',
      agentId: agent.agentId,
      sessionId: focus.sessionId
    });
    client.send({type: 'focus', agentId: null});
    await client.barrier();
    const count = client.messages.length;
    await agents.command(agent.agentId, 'prompt', 'unseen');
    await client.barrier();
    expect(client.messages.slice(count).map(m => m.type)).toEqual(['subscribed_drafts']);
  });
});
