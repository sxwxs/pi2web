import {describe,it,expect,afterEach} from 'vitest';
import WebSocket from 'ws';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';
import {DraftHub} from '../src/drafts.js';
import {voiceAllowed} from '../src/voice-api.js';
import {Check} from 'typebox/value';
import schema from '../packages/protocol/websocket.schema.json' with {type:'json'};

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

async function setup(){
  const dir=await mkdtemp(path.join(tmpdir(),'remote-pi-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-ws-'));
  const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd));
  server=new RemotePiServer({port:0,dataDir:dir,workspaces,agents});
  const first=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
  const fullToken=first.token!,voiceToken=await server.auth.rotateVoice();
  const headers=(t:string)=>({authorization:`Bearer ${t}`,'content-type':'application/json'});
  const call=async(token:string,method:string,url:string,body?:unknown)=>{
    const res=await fetch(base+url,{method,headers:headers(token),body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json() as any};
  };
  const workspace=(await call(fullToken,'POST','/api/v1/workspaces',{label:'ws',rootPath:root})).json.data;
  const newAgent=async()=>(await call(fullToken,'POST','/api/v1/agents',{workspaceId:workspace.id})).json.data;
  /** Opens a socket like the Web UI does and collects every message. */
  const openUi=async(token=fullToken)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/ws`,[`access-token.${token}`]);
    const msgs:any[]=[];ws.on('message',raw=>msgs.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject)});
    return {ws,msgs,send:(m:unknown)=>ws.send(JSON.stringify(m))};
  };
  const wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));
  return {call,fullToken,voiceToken,newAgent,openUi,wait};
}

describe('draft (text into the Web UI input box)',()=>{
  it('is delivered live to subscribed Web UIs and targets an agent or a numbered slot',async()=>{
    const {call,fullToken,voiceToken,newAgent,openUi,wait}=await setup();
    const a1=await newAgent(),a2=await newAgent();
    await call(fullToken,'PUT','/api/v1/session-aliases',{bindings:[{slot:1,agentId:a1.agentId},{slot:2,agentId:a2.agentId}]});
    const ui=await openUi();
    ui.send({type:'subscribe_drafts'});await wait();
    expect(ui.msgs.map(m=>m.type)).toEqual(['subscribed_drafts']);
    expect(Check(schema,ui.msgs[0])).toBe(true);

    const current=await call(voiceToken,'POST','/api/v1/draft',{text:'帮我看下测试',source:'sotto'});
    expect(current.status).toBe(200);
    expect(current.json.data).toMatchObject({agentId:null,slot:null,mode:'append',delivered:1,queued:true});
    const bySlot=await call(voiceToken,'POST','/api/v1/session-aliases/2/draft',{text:'第二个会话',mode:'replace'});
    expect(bySlot.json.data).toMatchObject({agentId:a2.agentId,slot:2,mode:'replace'});
    const byAgent=await call(voiceToken,'POST',`/api/v1/agents/${a1.agentId}/draft`,{text:'直接'});
    expect(byAgent.json.data.agentId).toBe(a1.agentId);
    await wait();

    const drafts=ui.msgs.filter(m=>m.type==='draft_event');
    expect(drafts.map(m=>[m.draft.text,m.draft.agentId??null,m.draft.mode,m.replay])).toEqual([
      ['帮我看下测试',null,'append',false],['第二个会话',a2.agentId,'replace',false],['直接',a1.agentId,'append',false]]);
    expect(drafts[0].draft.source).toBe('sotto');
    expect(drafts.every(m=>Check(schema,m))).toBe(true);
    expect(Check(schema,{type:'draft_ack',id:drafts[0].draft.id})).toBe(true);
    ui.ws.close();
  });

  it('keeps drafts pending until a Web UI acknowledges them',async()=>{
    const {call,voiceToken,openUi,wait}=await setup();
    const r=await call(voiceToken,'POST','/api/v1/draft',{text:'没人在线时说的话'});
    expect(r.json.data.delivered).toBe(0);                 // nobody is listening yet, but it is stored
    const ui=await openUi();
    ui.send({type:'subscribe_drafts'});await wait();
    const replay=ui.msgs.filter(m=>m.type==='draft_event');
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({replay:true,draft:{text:'没人在线时说的话'}});
    ui.send({type:'draft_ack',id:replay[0].draft.id});await wait();
    ui.ws.close();
    const ui2=await openUi();
    ui2.send({type:'subscribe_drafts'});await wait();
    expect(ui2.msgs.filter(m=>m.type==='draft_event')).toHaveLength(0); // acknowledged → gone
    ui2.ws.close();
  });

  it('validates input and reports missing targets',async()=>{
    const {call,fullToken,voiceToken,newAgent}=await setup();
    const a1=await newAgent();
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'   '})).status).toBe(400);
    expect((await call(voiceToken,'POST','/api/v1/draft',{})).status).toBe(400);
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'x',mode:'nope'})).status).toBe(400);
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'x'.repeat(20001)})).status).toBe(413);
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'x',agentId:'agent-none'})).json.error.code).toBe('AGENT_NOT_FOUND');
    expect((await call(voiceToken,'POST','/api/v1/agents/agent-none/draft',{text:'x'})).status).toBe(404);
    expect((await call(voiceToken,'POST','/api/v1/session-aliases/5/draft',{text:'x'})).json.error.code).toBe('ALIAS_NOT_FOUND');
    await call(fullToken,'PUT','/api/v1/session-aliases',{bindings:[{slot:3,agentId:'agent-gone'}]});
    const gone=await call(voiceToken,'POST','/api/v1/session-aliases/3/draft',{text:'x'});
    expect(gone.status).toBe(404);expect(gone.json.error.code).toBe('ALIAS_TARGET_MISSING');
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'ok',agentId:a1.agentId})).status).toBe(200);
  });

  it('allows voice clients to post drafts but not change bindings',async()=>{
    await setup();
    expect(voiceAllowed('POST','/api/v1/draft')).toBe(true);
    expect(voiceAllowed('POST','/api/v1/agents/a1/draft')).toBe(true);
    expect(voiceAllowed('POST','/api/v1/session-aliases/1/draft')).toBe(true);
    expect(voiceAllowed('GET','/api/v1/draft')).toBe(false);
  });

  it('DraftHub expires and bounds pending drafts',()=>{
    const hub=new DraftHub(),seen:string[]=[];
    for(let i=0;i<60;i++)hub.add({text:`t${i}`});
    expect(hub.list()).toHaveLength(50);
    expect(hub.list()[0].text).toBe('t10');
    const unsubscribe=hub.subscribe((d,replay)=>seen.push(`${replay?'r':'n'}:${d.text}`));
    expect(seen).toHaveLength(50);
    hub.add({text:'live'});
    expect(seen.at(-1)).toBe('n:live');
    unsubscribe();
    expect(hub.add({text:'x'}).delivered).toBe(0);
  });
});
