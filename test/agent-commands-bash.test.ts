import {describe,it,expect,afterEach} from 'vitest';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {RemotePiServer} from '../src/server.js';import {WorkspaceStore} from '../src/workspaces.js';import {AgentManager,MockBackend,type AgentEvent} from '../src/agents.js';
let server:RemotePiServer|undefined;afterEach(async()=>{await server?.stop();server=undefined});
describe('slash commands and session bash',()=>{
 it('lists commands and runs bash inside the session',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'remote-pi-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-ws-'));
  const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd));
  server=new RemotePiServer({port:0,dataDir:dir,workspaces,agents});
  const first=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`,headers={authorization:`Bearer ${first.token}`,'content-type':'application/json'};
  const post=(url:string,body={})=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
  const workspace=(await (await post('/api/v1/workspaces',{label:'x',rootPath:root})).json()).data;
  const agent=(await (await post('/api/v1/agents',{workspaceId:workspace.id})).json()).data;
  const commands=(await (await fetch(base+`/api/v1/agents/${agent.agentId}/commands`,{headers})).json()).data;
  expect(commands).toEqual([{name:'mock',description:'Mock prompt template',source:'prompt'}]);
  const events:AgentEvent[]=[];agents.subscribe(agent.agentId,stored=>events.push(stored.event));
  const result=(await (await post(`/api/v1/agents/${agent.agentId}/bash`,{command:'echo hi'})).json()).data;
  expect(result).toMatchObject({output:'Mock bash: echo hi',exitCode:0,cancelled:false});
  expect(events.some(event=>event.type==='bash_execution_update'&&event.id===result.id)).toBe(true);
  expect(events.some(event=>event.type==='bash_execution_end'&&event.id===result.id)).toBe(true);
  // Both ! and !! are recorded; !! only excludes the message from model context.
  let messages=(await (await fetch(base+`/api/v1/agents/${agent.agentId}/messages`,{headers})).json()).data;
  expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({role:'bashExecution',command:'echo hi',output:'Mock bash: echo hi',excludeFromContext:false});
  await post(`/api/v1/agents/${agent.agentId}/bash`,{command:'echo hidden',excludeFromContext:true});
  messages=(await (await fetch(base+`/api/v1/agents/${agent.agentId}/messages`,{headers})).json()).data;
  expect(messages).toHaveLength(2);expect(messages[1]).toMatchObject({role:'bashExecution',command:'echo hidden',excludeFromContext:true});
  expect((await post(`/api/v1/agents/${agent.agentId}/bash`,{command:'   '})).status).toBe(400);
  expect((await post(`/api/v1/agents/${agent.agentId}/bash`,{command:'x'.repeat(8001)})).status).toBe(400);
  expect((await post(`/api/v1/agents/${agent.agentId}/bash-abort`)).status).toBe(200);
 });
});
