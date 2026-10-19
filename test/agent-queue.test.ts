import {describe,it,expect,afterEach} from 'vitest';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import WebSocket from 'ws';import {once} from 'node:events';import {RemotePiServer} from '../src/server.js';import {WorkspaceStore} from '../src/workspaces.js';import {AgentManager,MockBackend,type AgentEvent} from '../src/agents.js';import {Check} from 'typebox/value';import schema from '../packages/protocol/websocket.schema.json' with {type:'json'};

/** Steering and follow-up messages Pi queues for a running turn, surfaced so a client can show and clear them. */
class HeldBackend extends MockBackend {
 release=()=>{};
 protected override runTurn(){return new Promise<void>(resolve=>{this.release=()=>resolve()})}
}
let server:RemotePiServer|undefined;afterEach(async()=>{await server?.stop();server=undefined});

async function setup(){
 const dir=await mkdtemp(path.join(tmpdir(),'remote-pi-queue-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-queue-ws-'));
 const workspaces=new WorkspaceStore(),backends:HeldBackend[]=[];
 const agents=new AgentManager(workspaces,(id,cwd)=>{const backend=new HeldBackend(id,cwd);backends.push(backend);return backend});
 server=new RemotePiServer({port:0,dataDir:dir,workspaces,agents});
 const {token}=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const post=(url:string,body={})=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
 const workspace=(await (await post('/api/v1/workspaces',{label:'x',rootPath:root})).json()).data;
 const agent=(await (await post('/api/v1/agents',{workspaceId:workspace.id})).json()).data;
 return {agents,agent,backends,base,token,headers,post};
}

describe('queued steering and follow-up messages',()=>{
 it('reports whether a message reached the turn and exposes the queue',async()=>{
  const {agents,agent,backends,base,headers,post}=await setup();
  const events:AgentEvent[]=[];agents.subscribe(agent.agentId,stored=>events.push(stored.event));
  // Nothing is running, so the message is handled immediately and the queue stays empty.
  expect((await (await post(`/api/v1/agents/${agent.agentId}/steer`,{message:'now'})).json()).data).toEqual({success:true,disposition:'handled'});
  expect((await (await fetch(base+`/api/v1/agents/${agent.agentId}/queue`,{headers})).json()).data).toEqual({steering:[],followUp:[]});

  const running=post(`/api/v1/agents/${agent.agentId}/prompt`,{message:'work'});
  await expect.poll(()=>agents.get(agent.agentId).record.status).toBe('streaming');
  expect((await (await post(`/api/v1/agents/${agent.agentId}/steer`,{message:'redirect'})).json()).data).toEqual({success:true,disposition:'queued'});
  expect((await (await post(`/api/v1/agents/${agent.agentId}/follow-up`,{message:'and then'})).json()).data).toEqual({success:true,disposition:'queued'});
  const queued={steering:['redirect'],followUp:['and then']};
  expect((await (await fetch(base+`/api/v1/agents/${agent.agentId}/queue`,{headers})).json()).data).toEqual(queued);
  expect(agents.snapshotState(agent.agentId).activity.queue).toEqual(queued);
  expect(events.filter(event=>event.type==='queue_update').at(-1)).toMatchObject(queued);

  // Clearing returns the messages so a client can restore them to its composer.
  expect((await (await fetch(base+`/api/v1/agents/${agent.agentId}/queue`,{method:'DELETE',headers})).json()).data).toEqual(queued);
  expect(agents.snapshotState(agent.agentId).activity.queue).toEqual({steering:[],followUp:[]});
  // A message queued while the clear runs stays queued: the cache follows queue_update, not the reply.
  await post(`/api/v1/agents/${agent.agentId}/steer`,{message:'after clear'});
  expect(agents.snapshotState(agent.agentId).activity.queue).toEqual({steering:['after clear'],followUp:[]});
  backends[0].release();
  await running;
 });

 it('clears the queue over the WebSocket within the published protocol',async()=>{
  const {agents,agent,base,token,post,backends}=await setup();
  const socket=new WebSocket(`${base.replace('http','ws')}/api/v1/ws`,{headers:{authorization:`Bearer ${token}`}});
  await once(socket,'open');
  const messages:any[]=[];socket.on('message',data=>messages.push(JSON.parse(String(data))));
  socket.send(JSON.stringify({type:'subscribe',agentId:agent.agentId}));
  const running=post(`/api/v1/agents/${agent.agentId}/prompt`,{message:'work'});
  await expect.poll(()=>agents.get(agent.agentId).record.status).toBe('streaming');
  await post(`/api/v1/agents/${agent.agentId}/steer`,{message:'redirect'});
  const command={type:'clear-queue',requestId:'r1',agentId:agent.agentId};
  expect(Check(schema,command)).toBe(true);
  socket.send(JSON.stringify(command));
  const result=await new Promise<any>(resolve=>{
   const check=()=>{const found=messages.find(message=>message.type==='command_result'&&message.requestId==='r1');found?resolve(found):setTimeout(check,10)};check();
  });
  expect(result).toMatchObject({success:true,queue:{steering:['redirect'],followUp:[]}});
  expect(Check(schema,result)).toBe(true);
  socket.terminate();backends[0].release();await running;
 });
});
