import {afterEach,describe,expect,it} from 'vitest';
import WebSocket from 'ws';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';
import {TerminalManager,type PtyProcess} from '../src/terminals.js';

class FakePty implements PtyProcess {
  emitter=new EventEmitter();writes:string[]=[];sizes:{cols:number,rows:number}[]=[];killed=false;
  write(data:string){this.writes.push(data)} resize(cols:number,rows:number){this.sizes.push({cols,rows})} kill(){this.killed=true}
  onData(listener:(data:string)=>void){this.emitter.on('data',listener);return{dispose:()=>this.emitter.off('data',listener)}}
  onExit(listener:(event:{exitCode:number})=>void){this.emitter.on('exit',listener);return{dispose:()=>this.emitter.off('exit',listener)}}
  output(data:string){this.emitter.emit('data',data)}
}

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

describe('terminal API',()=>{
  it('creates a terminal and streams input/output over an authenticated websocket',async()=>{
    const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-ws-'));
    const workspaces=new WorkspaceStore(),workspace=workspaces.add('x',root),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd)),ptys:FakePty[]=[];
    const terminals=new TerminalManager(workspaces,()=>{const value=new FakePty();ptys.push(value);return value});
    server=new RemotePiServer({port:0,dataDir,workspaces,agents,terminals});const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
    const headers={authorization:`Bearer ${auth.token}`,'content-type':'application/json'};
    const response=await fetch(base+'/api/v1/terminals',{method:'POST',headers,body:JSON.stringify({workspaceId:workspace.id,relativeCwd:'.'})});
    expect(response.status).toBe(201);const terminal=(await response.json()).data;
    const output=await new Promise<string>((resolve,reject)=>{
      const ws=new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/terminals/${terminal.terminalId}/ws`,[`access-token.${auth.token}`]);
      ws.on('message',raw=>{const message=JSON.parse(String(raw));if(message.type==='snapshot'){ws.send(JSON.stringify({type:'input',data:'hello'}));ws.send(JSON.stringify({type:'resize',cols:100,rows:30}));ptys[0].output('world');}else if(message.type==='output'){ws.close();resolve(message.data)}});ws.on('error',reject);
    });
    expect(output).toBe('world');for(let i=0;i<20&&!ptys[0].writes.length;i++)await new Promise(resolve=>setTimeout(resolve,10));expect(ptys[0].writes).toEqual(['hello']);expect(ptys[0].sizes).toEqual([{cols:100,rows:30}]);
    expect((await (await fetch(base+'/api/v1/terminals',{headers})).json()).data).toHaveLength(1);
    expect((await fetch(`${base}/api/v1/terminals/${terminal.terminalId}`,{method:'DELETE',headers})).status).toBe(200);expect(ptys[0].killed).toBe(true);
  });
});
