import {describe,it,expect,afterEach} from 'vitest';
import WebSocket from 'ws';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {DraftHub} from '../src/drafts.js';
import {Check} from 'typebox/value';
import schema from '../packages/protocol/websocket.schema.json' with {type:'json'};

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

async function setup(){
  const dir=await mkdtemp(path.join(tmpdir(),'pi2web-draft-'));
  server=new RemotePiServer({port:0,dataDir:dir});
  const first=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
  const fullToken=first.token!,voiceToken=await server.auth.rotateVoice();
  const call=async(token:string,method:string,url:string,body?:unknown)=>{
    const res=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json() as any};
  };
  const openUi=async(token=fullToken)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/ws`,[`access-token.${token}`]);
    const msgs:any[]=[];ws.on('message',raw=>msgs.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject)});
    return {ws,msgs,send:(m:unknown)=>ws.send(JSON.stringify(m))};
  };
  return {call,base,fullToken,voiceToken,openUi,wait:(ms=50)=>new Promise(r=>setTimeout(r,ms))};
}

describe('draft-only voice client API',()=>{
  it('delivers text to subscribed pages without selecting or prompting an Agent',async()=>{
    const {call,voiceToken,openUi,wait}=await setup();
    const ui=await openUi();
    ui.send({type:'subscribe_drafts'});await wait();
    expect(ui.msgs.map(m=>m.type)).toEqual(['subscribed_drafts']);
    expect(Check(schema,ui.msgs[0])).toBe(true);
    const draft=await call(voiceToken,'POST','/api/v1/draft',{text:'请检查这段文字',mode:'replace',source:'sotto'});
    expect(draft.status).toBe(200);
    expect(draft.json.data).toMatchObject({delivered:1,queued:true,mode:'replace'});
    expect(draft.json.data).not.toHaveProperty('agentId');
    await wait();
    const [event]=ui.msgs.filter(m=>m.type==='draft_event');
    expect(event).toMatchObject({draft:{text:'请检查这段文字',mode:'replace',source:'sotto'},replay:false});
    expect(event.draft).not.toHaveProperty('agentId');
    expect(Check(schema,event)).toBe(true);
    ui.ws.close();
  });

  it('broadcasts to every open tab on the same backend (no unique active-tab targeting)',async()=>{
    const {call,voiceToken,openUi,wait}=await setup();
    const first=await openUi(),second=await openUi();
    first.send({type:'subscribe_drafts'});second.send({type:'subscribe_drafts'});await wait();
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'shared'})).json.data.delivered).toBe(2);
    await wait();
    expect(first.msgs.filter(m=>m.type==='draft_event').map(m=>m.draft.text)).toEqual(['shared']);
    expect(second.msgs.filter(m=>m.type==='draft_event').map(m=>m.draft.text)).toEqual(['shared']);
    first.ws.close();second.ws.close();
  });

  it('replays pending drafts until a page acknowledges them',async()=>{
    const {call,voiceToken,openUi,wait}=await setup();
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'暂存'})).json.data.delivered).toBe(0);
    const first=await openUi();first.send({type:'subscribe_drafts'});await wait();
    const [replay]=first.msgs.filter(m=>m.type==='draft_event');
    expect(replay).toMatchObject({replay:true,draft:{text:'暂存'}});
    first.send({type:'draft_ack',id:replay.draft.id});await wait();first.ws.close();
    const second=await openUi();second.send({type:'subscribe_drafts'});await wait();
    expect(second.msgs.filter(m=>m.type==='draft_event')).toEqual([]);
    second.ws.close();
  });

  it('rejects targeted drafts and keeps voice tokens out of Agent controls and WebSockets',async()=>{
    const {call,voiceToken,fullToken,base}=await setup();
    for(const payload of [{text:' '},{text:'x',mode:'invalid'},{text:'x',agentId:'some-agent'},{text:'x',target:'1'}])
      expect((await call(voiceToken,'POST','/api/v1/draft',payload)).status).toBe(400);
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'x'.repeat(20001)})).status).toBe(413);
    for(const [method,url] of [['GET','/api/v1/agents'],['GET','/api/v1/session-aliases'],['GET','/api/v1/attention'],
      ['POST','/api/v1/session-aliases/1/prompt'],['POST','/api/v1/agents/a1/draft'],['POST','/api/v1/agents/a1/prompt']])
      expect((await call(voiceToken,method,url,method==='POST'?{text:'x',message:'x'}:undefined)).status,`${method} ${url}`).toBe(403);
    expect((await call(fullToken,'POST','/api/v1/agents/a1/draft',{text:'x'})).status).toBe(404);
    expect((await call(voiceToken,'GET','/api/v1/system/status')).status).toBe(200);
    const ws=new WebSocket(base.replace('http','ws')+'/api/v1/ws',[`access-token.${voiceToken}`]);
    const rejected=await new Promise<number>((resolve,reject)=>{ws.once('unexpected-response',(_q,res)=>resolve(res.statusCode!));ws.once('error',reject)});
    expect(rejected).toBe(403);
  });

  it('rotation and revocation invalidate new REST requests',async()=>{
    const {call,voiceToken,fullToken}=await setup();
    const next=await server!.auth.rotateVoice();
    expect((await call(voiceToken,'POST','/api/v1/draft',{text:'old'})).status).toBe(401);
    expect((await call(next,'POST','/api/v1/draft',{text:'new'})).status).toBe(200);
    await server!.auth.revokeVoice();
    expect((await call(next,'POST','/api/v1/draft',{text:'old'})).status).toBe(401);
    expect((await call(fullToken,'POST','/api/v1/draft',{text:'full'})).status).toBe(200);
  });

  it('bounds the in-memory pending draft buffer',()=>{
    const hub=new DraftHub(),seen:string[]=[];
    for(let i=0;i<60;i++)hub.add({text:`t${i}`});
    expect(hub.list()).toHaveLength(50);
    expect(hub.list()[0].text).toBe('t10');
    const unsubscribe=hub.subscribe((d,replay)=>seen.push(`${replay?'r':'n'}:${d.text}`));
    expect(seen).toHaveLength(50);
    hub.add({text:'live'});expect(seen.at(-1)).toBe('n:live');
    unsubscribe();expect(hub.add({text:'x'}).delivered).toBe(0);
  });
});
