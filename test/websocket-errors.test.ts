import {afterEach,describe,expect,it} from 'vitest';
import WebSocket from 'ws';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

describe('agent websocket errors',()=>{
  it('reports malformed JSON without an unhandled rejection or server failure',async()=>{
    const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-'));
    server=new RemotePiServer({port:0,dataDir});
    const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
    const message=await new Promise<any>((resolve,reject)=>{
      const ws=new WebSocket(base.replace('http','ws')+'/api/v1/ws',{headers:{authorization:`Bearer ${auth.token}`}});
      ws.on('open',()=>ws.send('{'));
      ws.on('message',raw=>{ws.close();resolve(JSON.parse(String(raw)))});
      ws.on('error',reject);
    });
    expect(message).toMatchObject({type:'command_result',success:false,error:{code:'BAD_REQUEST',message:'Invalid JSON'}});
    expect((await fetch(base+'/health')).status).toBe(200);
  });
});
