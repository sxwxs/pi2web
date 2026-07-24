import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {MailNotifier} from '../src/mail-notifier.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});
const notifier=()=>new MailNotifier({endpoint:'https://mail.example.com/api/v1/messages',apiKey:'key',recipient:'owner@example.com'},async()=>Response.json({ok:true,message_id:'msg',status:'queued'},{status:202}));

describe('mail notification settings API',()=>{
  it('updates and persists server-wide MailDispatch notification settings',async()=>{
    const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-mail-'));
    server=new RemotePiServer({port:0,dataDir,mailNotifier:notifier()});const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`,headers={authorization:`Bearer ${auth.token}`,'content-type':'application/json'};
    const initial=(await (await fetch(base+'/api/v1/mail-notifications',{headers})).json()).data;expect(initial).toMatchObject({available:true,settings:{enabled:true,aggregationDelaySeconds:0,includeResponse:true,includeSessionDetails:true}});
    const updated=(await (await fetch(base+'/api/v1/mail-notifications',{method:'POST',headers,body:JSON.stringify({enabled:false,aggregationDelaySeconds:90,includeResponse:false,includeSessionDetails:true})})).json()).data.settings;
    expect(updated).toEqual({enabled:false,aggregationDelaySeconds:90,includeResponse:false,includeSessionDetails:true});
    await server.stop();server=new RemotePiServer({port:0,dataDir,mailNotifier:notifier()});const restarted=await server.start();const persisted=(await (await fetch(`http://127.0.0.1:${restarted!.port}/api/v1/mail-notifications`,{headers})).json()).data.settings;expect(persisted).toEqual(updated);
  });
});
