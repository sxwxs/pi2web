import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

describe('workspace creation',()=>{
  it('does not persist a workspace when its root directory does not exist',async()=>{
    const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-'));
    server=new RemotePiServer({port:0,dataDir});
    const auth=await server.auth.init();
    const address=await server.start();
    const response=await fetch(`http://127.0.0.1:${address!.port}/api/v1/workspaces`,{
      method:'POST',
      headers:{authorization:`Bearer ${auth.token}`,'content-type':'application/json'},
      body:JSON.stringify({label:'missing',rootPath:path.join(dataDir,'missing')})
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({error:{code:'WORKSPACE_ROOT_NOT_FOUND'}});
    expect(server.workspaces.list()).toEqual([]);
    expect(server.metadata.listWorkspaces()).toEqual([]);
  });
});
