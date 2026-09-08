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
import schema from '../packages/protocol/websocket.schema.json' with {type:'json'};

class ControlledBackend extends MockBackend {
  publish!:(event:AgentEvent) => void;
  override subscribe(listener:(event:AgentEvent) => void) {
    this.publish = listener;
    return super.subscribe(listener);
  }
}

const cleanup:Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-activity-snapshot-'));
  const workspaceDir = path.join(dir, 'workspace'); await mkdir(workspaceDir);
  const workspaces = new WorkspaceStore(), workspace = workspaces.add('test', workspaceDir);
  const backends:ControlledBackend[] = [];
  const agents = new AgentManager(workspaces, (id, cwd) => {
    const backend = new ControlledBackend(id, cwd); backends.push(backend); return backend;
  });
  const server = new RemotePiServer({port:0, dataDir:path.join(dir, 'data'), workspaces, agents});
  const sockets:WebSocket[] = [], releases:Array<() => void> = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    for (const release of releases) release();
    await server.stop();
    await rm(dir, {recursive:true, force:true});
  });
  const {token} = await server.auth.init(), address = await server.start();
  const agent = await agents.create(workspace.id), backend = backends[0];
  const publish = (event:AgentEvent) => backend.publish(event);

  function blockMessages() {
    let resolve!:(messages:unknown[]) => void, reject!:(error:Error) => void;
    const promise = new Promise<unknown[]>((yes, no) => { resolve = yes; reject = no; });
    backend.getMessages = vi.fn(() => promise);
    releases.push(() => resolve([]));
    return {resolve, reject, started:() => vi.waitFor(() => expect(backend.getMessages).toHaveBeenCalled())};
  }
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/ws`, {headers:{authorization:`Bearer ${token}`}});
    sockets.push(socket);
    const messages:any[] = [];
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(socket, 'open');
    return {
      socket, messages,
      send:(message:unknown) => socket.send(JSON.stringify(message)),
      async wait(predicate:(message:any) => boolean) {
        await vi.waitFor(() => expect(messages.some(predicate)).toBe(true));
        return messages.find(predicate);
      },
    };
  }
  return {server, agents, agent, backend, backends, publish, blockMessages, connect, workspaces,
    unload:() => fetch(`http://127.0.0.1:${address!.port}/api/v1/agents/${agent.agentId}`, {method:'DELETE', headers:{authorization:`Bearer ${token}`}}),
  };
}

const dialogRequest = {type:'extension_ui_request', requestId:'dialog-1', kind:'confirm', title:'Confirm', message:'Continue?'};
const startWork = (publish:(event:AgentEvent) => void) => {
  publish({type:'bash_execution_start', id:'bash-1', command:'sleep 30'});
  publish(dialogRequest);
};
const active = {bashIds:['bash-1'], dialogIds:['dialog-1'], dialogRequests:[dialogRequest]};
const idle = {bashIds:[], dialogIds:[], dialogRequests:[]};

describe('WebSocket state schema', () => {
  it.each(['agent_snapshot', 'agent_state'])('requires core state fields but accepts older servers without activity: %s', type => {
    const state = {agentId:'agent-a', sessionId:'session-a', cwd:'/workspace', status:'idle'};
    const message = {type, agentId:state.agentId, state, sequence:0, lastSequence:0, messages:[]};
    expect(Check(schema, message)).toBe(true);
    expect(Check(schema, {...message, state:{...state, activity:active}})).toBe(true);
    for (const key of ['agentId', 'sessionId', 'cwd', 'status']) {
      const incomplete:Record<string, unknown> = {...state}; delete incomplete[key];
      expect(Check(schema, {...message, state:incomplete})).toBe(false);
    }
    expect(Check(schema, {...message, state:{...state, status:'unknown'}})).toBe(false);
  });
});

describe('authoritative activity snapshots', () => {
  it('tracks parallel operations independently of LLM turns and clears them by ID', async () => {
    const {agents, agent, backend, publish} = await setup();
    startWork(publish);
    publish({type:'bash_execution_start', id:'bash-2'});
    publish({type:'bash_execution_update', id:'bash-1', delta:'output'});
    publish({type:'extension_ui_request', requestId:'dialog-2'});
    publish({type:'agent_start'});
    publish({type:'agent_end'});
    publish({type:'agent_settled'});
    expect((await backend.getState()).status).toBe('idle');
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status:'idle', activity:{bashIds:['bash-1','bash-2'], dialogIds:['dialog-1','dialog-2']}});
    expect(agents.get(agent.agentId).record).not.toHaveProperty('activity');
    publish({type:'bash_execution_end', id:'bash-2'});
    publish({type:'extension_ui_response', requestId:'dialog-2'});
    publish({type:'bash_execution_end', id:'unknown'});
    expect(agents.snapshotState(agent.agentId).activity).toEqual(active);
    publish({type:'bash_execution_end', id:'bash-1'});
    publish({type:'extension_ui_response', requestId:'dialog-1'});
    expect(agents.snapshotState(agent.agentId).activity).toEqual(idle);
  });

  it.each([undefined, 25])('captures status, IDs and cursor together before reading messages (limit %s)', async limit => {
    const {agents, agent, publish, blockMessages} = await setup();
    publish({type:'agent_start'});
    startWork(publish);
    const cursor = agents.currentSequence(agent.agentId), gate = blockMessages();
    const pending = agents.snapshot(agent.agentId, limit);
    await gate.started();
    publish({type:'bash_execution_end', id:'bash-1'});
    publish({type:'extension_ui_response', requestId:'dialog-1'});
    publish({type:'agent_end'});
    gate.resolve([]);
    const snapshot = await pending;
    expect(snapshot.lastSequence).toBe(cursor);
    expect(snapshot.state).toMatchObject({status:'streaming', activity:active});
    expect(agents.events(agent.agentId, cursor).map(event => event.sequence)).toEqual([cursor+1,cursor+2,cursor+3]);
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status:'idle', activity:idle});
    expect(snapshot.state.activity).toEqual(active); // Later events did not mutate the captured arrays.
  });

  it('drops runtime activity on unload/restore and ignores late events from the old backend', async () => {
    const {agents, agent, publish, workspaces} = await setup();
    startWork(publish);
    const saved = {...agents.get(agent.agentId).record};
    await agents.dispose(agent.agentId);
    publish({type:'bash_execution_update', id:'bash-1', delta:'late output'});
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status:'unloaded', activity:idle});
    const restored = new AgentManager(workspaces, () => { throw Error('must remain unloaded'); });
    await restored.restore([saved]);
    expect(restored.snapshotState(agent.agentId)).toMatchObject({status:'unloaded', activity:idle});
  });
});

describe('WebSocket snapshot ordering', () => {
  it('broadcasts and replays unloading so other clients can clear activity without reconnecting', async () => {
    const {agents, agent, publish, connect, unload, backends} = await setup();
    const client = await connect(), observer = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, fromNow:true});
    observer.send({type:'subscribe_all'});
    await client.wait(message => message.type === 'agent_state');
    await observer.wait(message => message.type === 'subscribed_all');
    startWork(publish);
    await client.wait(message => message.event?.type === 'extension_ui_request');
    await observer.wait(message => message.event?.type === 'extension_ui_request');
    const cursor = agents.currentSequence(agent.agentId);
    expect((await unload()).status).toBe(200);
    const unloaded = await client.wait(message => message.event?.type === 'agent_unloaded');
    expect(unloaded).toMatchObject({type:'agent_event', agentId:agent.agentId, sequence:cursor+1, event:{type:'agent_unloaded'}});
    expect(await observer.wait(message => message.event?.type === 'agent_unloaded')).toEqual(unloaded);
    expect(agents.snapshotState(agent.agentId)).toMatchObject({status:'unloaded', activity:idle});
    publish({type:'bash_execution_update', id:'bash-1', delta:'late output'});
    expect(agents.currentSequence(agent.agentId)).toBe(cursor+1);

    const reconnected = await connect();
    reconnected.send({type:'subscribe', agentId:agent.agentId, lastSequence:cursor});
    expect(await reconnected.wait(message => message.type === 'agent_event')).toEqual(unloaded);
    expect(await reconnected.wait(message => message.type === 'agent_state')).toMatchObject({state:{status:'unloaded', activity:idle}});
    expect(backends).toHaveLength(1); // Observing unload must not reload the backend.
  });

  it('includes current activity in fromNow without replaying the transcript', async () => {
    const {agent, publish, backend, connect} = await setup();
    startWork(publish);
    backend.getMessages = vi.fn(async () => []);
    const client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, fromNow:true});
    const subscribed = await client.wait(message => message.type === 'subscribed');
    expect(subscribed.currentSequence).toBe(2);
    const baseline = await client.wait(message => message.type === 'agent_state');
    expect(baseline).toMatchObject({sequence:2, state:{status:'idle', activity:active}});
    expect(backend.getMessages).not.toHaveBeenCalled();
    publish({type:'bash_execution_end', id:'bash-1'});
    const end = await client.wait(message => message.type === 'agent_event');
    expect(end.sequence).toBe(3);
    expect(client.messages.map(message => message.type)).toEqual(['subscribed','agent_state','agent_event']);
  });

  it('restores activity when a refreshed page already has an up-to-date saved cursor', async () => {
    const {agent, publish, backend, connect} = await setup();
    startWork(publish);
    backend.getMessages = vi.fn(async () => []);
    const client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:2});
    const baseline = await client.wait(message => message.type === 'agent_state');
    expect(baseline).toMatchObject({sequence:2, state:{status:'idle', activity:active}});
    expect(client.messages.map(message => message.type)).toEqual(['subscribed','agent_state']);
    expect(backend.getMessages).not.toHaveBeenCalled();
  });

  it('sends the gap snapshot before every event that occurred during its construction', async () => {
    const {agents, agent, publish, blockMessages, connect} = await setup();
    startWork(publish);
    const cursor = agents.currentSequence(agent.agentId), gate = blockMessages();
    const client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:999});
    await gate.started();
    publish({type:'bash_execution_end', id:'bash-1'});
    publish({type:'extension_ui_response', requestId:'dialog-1'});
    publish({type:'bash_execution_start', id:'bash-2'});
    gate.resolve([]);
    const baseline = await client.wait(message => message.type === 'agent_state');
    expect(baseline).toMatchObject({sequence:cursor+3, state:{activity:{bashIds:['bash-2'], dialogIds:[]}}});
    const snapshot = client.messages.find(message => message.type === 'agent_snapshot');
    expect(snapshot).toMatchObject({lastSequence:cursor, state:{status:'idle', activity:active}});
    expect(client.messages.map(message => message.type)).toEqual(['subscribed','agent_snapshot','agent_event','agent_event','agent_event','agent_state']);
    expect(client.messages.filter(message => message.type === 'agent_event').map(message => message.sequence)).toEqual([cursor+1,cursor+2,cursor+3]);
    expect(agents.snapshotState(agent.agentId).activity).toEqual({bashIds:['bash-2'], dialogIds:[], dialogRequests:[]});
  });

  it('recovers pending dialog payloads even after their request events leave the replay cache', async () => {
    const {agents, agent, publish, connect} = await setup();
    const request = {...dialogRequest, kind:'select', options:['Keep', 'Replace']};
    publish(request);
    for (let i = 0; i < 1001; i++) publish({type:'extension_ui_notify', message:String(i)});
    expect(agents.events(agent.agentId).some(item => item.event.type === 'extension_ui_request')).toBe(false);
    const client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:1});
    const snapshot = await client.wait(message => message.type === 'agent_snapshot');
    expect(snapshot.state.activity.dialogRequests).toEqual([request]);
    expect(Check(schema, snapshot)).toBe(true);
    publish({type:'extension_ui_response', requestId:request.requestId});
    await client.wait(message => message.event?.type === 'extension_ui_response');
    expect(agents.snapshotState(agent.agentId).activity.dialogRequests).toEqual([]);
  });

  it('sends ordinary replay before the current-state baseline, then switches to live events', async () => {
    const {agent, publish, connect} = await setup();
    startWork(publish);
    const client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:0});
    await client.wait(message => message.type === 'agent_state');
    expect(client.messages[0].state).toBeUndefined();
    expect(client.messages.map(message => message.type)).toEqual(['subscribed','agent_event','agent_event','agent_state']);
    publish({type:'extension_ui_response', requestId:'dialog-1'});
    expect((await client.wait(message => message.sequence === 3)).event.type).toBe('extension_ui_response');
  });

  it('does not deliver an old pending snapshot after a replacement subscription', async () => {
    const {agent, publish, blockMessages, connect} = await setup();
    startWork(publish);
    const gate = blockMessages(), client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:999});
    await gate.started();
    client.send({type:'subscribe', agentId:agent.agentId, fromNow:true});
    await client.wait(message => message.type === 'agent_state');
    gate.resolve([]);
    client.send({type:'subscribe_all'}); // Round-trip barrier after releasing the old snapshot.
    await client.wait(message => message.type === 'subscribed_all');
    expect(client.messages.some(message => message.type === 'agent_snapshot')).toBe(false);
    expect(client.messages.filter(message => message.type === 'agent_state')).toHaveLength(1);
    publish({type:'bash_execution_end', id:'bash-1'});
    await client.wait(message => message.type === 'agent_event');
    expect(client.messages.filter(message => message.type === 'agent_event')).toHaveLength(1);
  });

  it('releases a failed subscription so it cannot block subscribe_all forwarding', async () => {
    const {agent, publish, blockMessages, connect} = await setup();
    const gate = blockMessages(), client = await connect();
    client.send({type:'subscribe_all'});
    await client.wait(message => message.type === 'subscribed_all');
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:999});
    await gate.started();
    gate.reject(Error('snapshot read failed'));
    await client.wait(message => message.type === 'command_result' && !message.success);
    publish({type:'bash_execution_start', id:'bash-1'});
    expect((await client.wait(message => message.type === 'agent_event')).event.id).toBe('bash-1');
  });

  it('closes for retry rather than silently dropping events when the replay cache overflows', async () => {
    const {agent, publish, blockMessages, connect} = await setup();
    const gate = blockMessages(), client = await connect();
    client.send({type:'subscribe', agentId:agent.agentId, lastSequence:999});
    await gate.started();
    for (let i = 0; i < 1001; i++) publish({type:'extension_ui_notify', message:String(i)});
    const closed = once(client.socket, 'close');
    gate.resolve([]);
    const [code] = await closed;
    expect(code).toBe(1013);
    expect(client.messages.map(message => message.type)).toEqual(['subscribed']);
  });
});
