import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WebSocket} from 'ws';
import {AgentManager,MockBackend} from '../src/agents.js';
import {WorkspaceStore} from '../src/workspaces.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});
const start=async()=>{const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-hardening-'));const workspaces=new WorkspaceStore([{id:'ws',label:'ws',rootPath:process.cwd(),createdAt:new Date().toISOString()}]);server=new RemotePiServer({port:0,dataDir,workspaces,agents:new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd))});const auth=await server.auth.init(),address=await server.start();return {base:`http://127.0.0.1:${address!.port}`,token:auth.token!}};

describe('pairing rate limit',()=>{
  it('locks a source address after repeated failed pairing attempts and clears the lock on success',async()=>{
    const {base,token}=await start();
    const attempt=(value:string)=>fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:value})});
    for(let i=0;i<9;i+=1)expect((await attempt('wrong')).status).toBe(401);
    const locking=await attempt('wrong');expect(locking.status).toBe(401);expect(Number(locking.headers.get('retry-after'))).toBeGreaterThan(0);
    const blocked=await attempt('wrong');expect(blocked.status).toBe(429);expect((await blocked.json()).error.code).toBe('TOO_MANY_ATTEMPTS');
    const socketStatus=await new Promise<number|undefined>(resolve=>{const socket=new WebSocket(base.replace('http','ws')+'/api/v1/ws',[`access-token.${token}`]);socket.on('unexpected-response',(_request,response)=>resolve(response.statusCode));socket.on('open',()=>{socket.close();resolve(200)});socket.on('error',()=>resolve(undefined))});
    expect(socketStatus).toBe(429);
    server!['loginFailures'].clear();
    expect((await attempt(token)).status).toBe(200);
    expect((await attempt('wrong')).status).toBe(401);
  });
});

describe('request body handling',()=>{
  it('decodes multi-byte bodies that span chunk boundaries',async()=>{
    const {base,token}=await start();
    const agent=(await (await fetch(base+'/api/v1/agents',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({workspaceId:'ws',relativeCwd:'.'})})).json()).data;
    const message='中文提示😀'.repeat(20000);
    const response=await fetch(`${base}/api/v1/agents/${agent.agentId}/prompt`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({message})});
    expect(response.status).toBe(200);
    const messages=(await (await fetch(`${base}/api/v1/agents/${agent.agentId}/messages`,{headers:{authorization:`Bearer ${token}`}})).json()).data;
    expect(messages[0]).toEqual({role:'user',content:message});
  });
  it('rejects oversized bodies before buffering the whole request',async()=>{
    const {base,token}=await start();
    const response=await fetch(base+'/api/v1/workspaces',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({label:'x'.repeat(2*1024*1024+1024),rootPath:process.cwd()})});
    expect(response.status).toBe(413);expect((await response.json()).error.code).toBe('REQUEST_TOO_LARGE');
  });
});
