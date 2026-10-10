import {describe,it,expect,afterEach} from 'vitest';
import WebSocket from 'ws';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';
import {AttentionFeed} from '../src/attention.js';
import {voiceAllowed} from '../src/voice-api.js';

/** The real SDK emits `agent_settled` once a turn is fully done; the mock does not, so add it. */
class SettlingBackend extends MockBackend {
  async prompt(message:string){await super.prompt(message);(this as any).emit({type:'agent_settled'})}
}

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

async function setup(){
  const dir=await mkdtemp(path.join(tmpdir(),'remote-pi-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-ws-'));
  const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new SettlingBackend(id,cwd));
  server=new RemotePiServer({port:0,dataDir:dir,workspaces,agents});
  const first=await server.auth.init(),address=await server.start();
  const base=`http://127.0.0.1:${address!.port}`;
  const full={authorization:`Bearer ${first.token}`,'content-type':'application/json'};
  const voiceToken=await server.auth.rotateVoice();
  const voice={authorization:`Bearer ${voiceToken}`,'content-type':'application/json'};
  const call=async(headers:Record<string,string>,method:string,url:string,body?:unknown)=>{
    const res=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json() as any};
  };
  const workspace=(await call(full,'POST','/api/v1/workspaces',{label:'ws',rootPath:root})).json.data;
  const newAgent=async()=>(await call(full,'POST','/api/v1/agents',{workspaceId:workspace.id})).json.data;
  return {base,full,voice,call,newAgent,address:address!,first,voiceToken};
}

describe('session slots + prompt by slot',()=>{
  it('stores slots server-side and sends prompts through a slot',async()=>{
    const {call,full,voice,newAgent}=await setup();
    const a1=await newAgent(),a2=await newAgent();
    expect((await call(full,'GET','/api/v1/session-aliases')).json.data).toEqual([]);
    const put=await call(full,'PUT','/api/v1/session-aliases',{bindings:[{slot:1,agentId:a1.agentId,color:'#ff0000',alias:'会话一'},{slot:2,agentId:a2.agentId}]});
    expect(put.status).toBe(200);
    expect(put.json.data.map((x:any)=>[x.slot,x.agentId])).toEqual([[1,a1.agentId],[2,a2.agentId]]);
    expect(put.json.data[0].agent.status).toBe('idle');

    // resolve by number or by alias name; the voice token may read but not rebind
    expect((await call(voice,'GET','/api/v1/session-aliases/1')).json.data.agentId).toBe(a1.agentId);
    expect((await call(voice,'GET',`/api/v1/session-aliases/${encodeURIComponent('会话一')}`)).json.data.slot).toBe(1);
    expect((await call(voice,'PUT','/api/v1/session-aliases',{bindings:[]})).status).toBe(403);
    expect((await call(voice,'DELETE','/api/v1/session-aliases/1')).status).toBe(403);

    const sent=await call(voice,'POST','/api/v1/session-aliases/1/prompt',{message:'帮我跑测试',idempotencyKey:'k1',source:'voice'});
    expect(sent.status).toBe(200);
    expect(sent.json.data).toMatchObject({accepted:true,slot:1,agentId:a1.agentId,mode:'prompt'});
    // a repeated recognition result with the same key must not run the prompt twice
    const dup=await call(voice,'POST','/api/v1/session-aliases/1/prompt',{message:'帮我跑测试',idempotencyKey:'k1'});
    expect(dup.json.data.duplicate).toBe(true);
    expect((await call(full,'GET',`/api/v1/agents/${a1.agentId}/messages`)).json.data.filter((m:any)=>m.role==='user')).toHaveLength(1);

    expect((await call(voice,'POST','/api/v1/session-aliases/3/prompt',{message:'x'})).json.error.code).toBe('ALIAS_NOT_FOUND');
    expect((await call(voice,'POST','/api/v1/session-aliases/1/prompt',{message:'  '})).status).toBe(400);
    expect((await call(voice,'POST','/api/v1/session-aliases/1/prompt',{message:'x',mode:'nope'})).status).toBe(400);
  });

  it('validates bindings and reports a missing target',async()=>{
    const {call,full,voice,newAgent}=await setup();
    const a1=await newAgent();
    expect((await call(full,'PUT','/api/v1/session-aliases',{bindings:[{slot:7,agentId:a1.agentId}]})).status).toBe(400);
    expect((await call(full,'PUT','/api/v1/session-aliases',{bindings:[{slot:1,agentId:a1.agentId},{slot:2,agentId:a1.agentId}]})).status).toBe(400);
    expect((await call(full,'PUT','/api/v1/session-aliases',{bindings:[{slot:1,agentId:a1.agentId},{slot:1,agentId:'other'}]})).status).toBe(400);
    await call(full,'PUT','/api/v1/session-aliases',{bindings:[{slot:4,agentId:'agent-gone'}]});
    const r=await call(voice,'POST','/api/v1/session-aliases/4/prompt',{message:'hi'});
    expect(r.status).toBe(404);expect(r.json.error.code).toBe('ALIAS_TARGET_MISSING');
    expect((await call(full,'DELETE','/api/v1/session-aliases/4')).json.data.deleted).toBe(true);
    expect((await call(full,'GET','/api/v1/session-aliases')).json.data).toEqual([]);
  });
});

describe('restricted voice token',()=>{
  it('is limited to the voice allow-list over REST',async()=>{
    const {call,full,voice,newAgent,voiceToken,first}=await setup();
    const agent=await newAgent();
    for(const [m,u] of [['GET','/api/v1/system/status'],['GET','/api/v1/agents'],['GET',`/api/v1/agents/${agent.agentId}/state`],['GET','/api/v1/attention']])
      expect((await call(voice,m,u)).status,`${m} ${u}`).toBe(200);
    for(const [m,u] of [['GET','/api/v1/workspaces'],['GET','/api/v1/terminals'],['POST','/api/v1/terminals'],['POST','/api/v1/workspaces'],
      ['POST',`/api/v1/agents/${agent.agentId}/bash`],['GET',`/api/v1/agents/${agent.agentId}/messages`],['POST','/api/v1/agents'],['GET','/api/v1/mail-notifications']])
      expect((await call(voice,m,u,m==='POST'?{}:undefined)).status,`${m} ${u}`).toBe(403);
    // the collab hub does its own authentication: the voice token is neither a human pairing code nor a participant token
    expect([401,403]).toContain((await call(voice,'GET','/api/v1/collab/sessions')).status);
    expect((await call(voice,'POST',`/api/v1/agents/${agent.agentId}/prompt`,{message:'hello'})).status).toBe(200);
    // the voice token is not a pairing code
    const login=await fetch(`http://127.0.0.1:${server!.address()!.port}/api/v1/auth/login`,{method:'POST',headers:full,body:JSON.stringify({token:voiceToken})});
    expect(login.status).toBe(401);
    expect(await server!.auth.verify(voiceToken)).toBe(false);
    expect(await server!.auth.role(first.token!)).toBe('full');
    // rotating the voice token invalidates the old one immediately; revoking removes it
    const next=await server!.auth.rotateVoice();
    expect((await call({authorization:`Bearer ${voiceToken}`},'GET','/api/v1/agents')).status).toBe(401);
    expect((await call({authorization:`Bearer ${next}`},'GET','/api/v1/agents')).status).toBe(200);
    await server!.auth.revokeVoice();
    expect((await call({authorization:`Bearer ${next}`},'GET','/api/v1/agents')).status).toBe(401);
    expect((await call(full,'GET','/api/v1/agents')).status).toBe(200);
  });

  it('is confined over WebSocket and cannot open terminals',async()=>{
    const {address,voiceToken}=await setup();
    const url=`ws://127.0.0.1:${address.port}/api/v1/ws`;
    const open=(u:string)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(u,[`access-token.${voiceToken}`]);ws.once('open',()=>resolve(ws));ws.once('error',reject);ws.once('unexpected-response',(_q,res)=>reject(new Error(`status ${res.statusCode}`)))});
    const ws=await open(url);
    const next=()=>new Promise<any>(resolve=>ws.once('message',raw=>resolve(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({type:'subscribe_collab',requestId:'c1'}));
    expect(await next()).toMatchObject({type:'command_result',requestId:'c1',success:false,error:{code:'FORBIDDEN'}});
    ws.send(JSON.stringify({type:'subscribe_all'}));
    expect((await next()).type).toBe('subscribed_all');
    ws.close();
    await expect(open(`ws://127.0.0.1:${address.port}/api/v1/terminals/nope/ws`)).rejects.toThrow(/403/);
  });

  it('voiceAllowed is a closed allow-list',()=>{
    expect(voiceAllowed('GET','/api/v1/agents/a1/last-result')).toBe(true);
    expect(voiceAllowed('POST','/api/v1/agents/a1/extension-response')).toBe(true);
    expect(voiceAllowed('POST','/api/v1/agents/a1/bash')).toBe(false);
    expect(voiceAllowed('POST','/api/v1/agents/a1/archive')).toBe(false);
    expect(voiceAllowed('PUT','/api/v1/session-aliases')).toBe(false);
    expect(voiceAllowed('GET','/api/v1/workspaces/w/file')).toBe(false);
    expect(voiceAllowed('DELETE','/api/v1/agents/a1')).toBe(false);
  });
});

describe('attention feed',()=>{
  it('records finished tasks, exposes last-result and supports ack',async()=>{
    const {call,full,voice,newAgent}=await setup();
    const agent=await newAgent();
    expect((await call(voice,'GET',`/api/v1/agents/${agent.agentId}/last-result`)).json.error.code).toBe('NO_RESULT');
    await call(full,'POST',`/api/v1/agents/${agent.agentId}/prompt`,{message:'你好'});
    await new Promise(r=>setTimeout(r,50));
    const result=(await call(voice,'GET',`/api/v1/agents/${agent.agentId}/last-result`)).json.data;
    expect(result.text).toBe('Mock response: 你好');expect(result.userPrompt).toBe('你好');
    const feed=(await call(voice,'GET','/api/v1/attention?pending=true')).json.data;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({kind:'agent_settled',priority:'normal',requiresResponse:false,agentId:agent.agentId});
    const id=feed.items[0].id;
    expect((await call(voice,'POST',`/api/v1/attention/${id}/ack`,{by:'sotto'})).json.data.ackedBy).toBe('sotto');
    expect((await call(voice,'POST',`/api/v1/attention/${id}/ack`,{by:'other'})).json.data.ackedBy).toBe('sotto'); // first ack wins
    expect((await call(voice,'GET','/api/v1/attention?pending=true')).json.data.items).toHaveLength(0);
    expect((await call(voice,'GET','/api/v1/attention?since=0')).json.data.items).toHaveLength(1);
    expect((await call(voice,'POST','/api/v1/attention/att-999/ack',{})).status).toBe(404);
  });

  it('streams attention events over WebSocket with replay',async()=>{
    const {call,full,newAgent,address,voiceToken}=await setup();
    const agent=await newAgent();
    await call(full,'POST',`/api/v1/agents/${agent.agentId}/prompt`,{message:'一'});
    await new Promise(r=>setTimeout(r,50));
    const ws=new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws`,[`access-token.${voiceToken}`]);
    const msgs:any[]=[];ws.on('message',raw=>msgs.push(JSON.parse(raw.toString())));
    await new Promise<void>(r=>ws.once('open',()=>r()));
    ws.send(JSON.stringify({type:'subscribe_attention',sinceSeq:0}));
    await new Promise(r=>setTimeout(r,50));
    expect(msgs.map(m=>m.type)).toEqual(['subscribed_attention','attention_event']);
    expect(msgs[1]).toMatchObject({change:'new',replay:true,item:{kind:'agent_settled'}});
    await call(full,'POST',`/api/v1/agents/${agent.agentId}/prompt`,{message:'二'});
    await new Promise(r=>setTimeout(r,80));
    expect(msgs.at(-1)).toMatchObject({type:'attention_event',change:'new',item:{kind:'agent_settled'}});
    expect(msgs.at(-1).item.data.text).toBe('Mock response: 二');
    ws.close();
  });

  it('turns extension dialogs into needs_input items that resolve themselves',()=>{
    const feed=new AttentionFeed(),changes:string[]=[];
    feed.subscribe((change,item)=>changes.push(`${change}:${item.kind}:${item.resolvedAt?'resolved':'open'}`));
    feed.ingestAgentEvent('a1',{type:'extension_ui_request',requestId:'r1',kind:'confirm',title:'删除文件？'},{sessionName:'清理'});
    feed.ingestAgentEvent('a1',{type:'extension_ui_request',requestId:'r1',kind:'confirm',title:'删除文件？'}); // replayed event → deduped
    expect(feed.list({pendingOnly:true})).toHaveLength(1);
    expect(feed.list()[0]).toMatchObject({kind:'needs_input',priority:'high',requiresResponse:true,sessionName:'清理',data:{requestId:'r1'}});
    feed.ingestAgentEvent('a1',{type:'extension_ui_response',requestId:'r1'});
    expect(feed.list({pendingOnly:true})).toHaveLength(0);
    expect(changes).toEqual(['new:needs_input:open','updated:needs_input:resolved']);
  });

  it('is bounded and ignores settles without output',()=>{
    const feed=new AttentionFeed();
    feed.ingestAgentEvent('a1',{type:'agent_settled'});
    expect(feed.list()).toHaveLength(0);
    for(let i=0;i<250;i++)feed.add({kind:'agent_settled',priority:'low',requiresResponse:false,data:{i}});
    expect(feed.list()).toHaveLength(200);
    expect(feed.lastSeq()).toBe(250);
  });
});
