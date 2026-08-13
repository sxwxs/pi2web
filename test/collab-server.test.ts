import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {RemotePiServer} from '../src/server.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

const temp=(prefix:string)=>mkdtemp(path.join(tmpdir(),prefix));
const rid=()=>`req-${randomUUID()}`;

type Client={call:(method:string,url:string,body?:unknown,token?:string)=>Promise<{status:number,data:any,error:any}>};

async function boot(){
  const dataDir=await temp('remote-pi-collab-'),root=await temp('collab-workspace-');
  server=new RemotePiServer({port:0,dataDir});
  const auth=await server.auth.init(),address=await server.start();
  const base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
  const call:Client['call']=async(method,url,body,token=human)=>{
    const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload=await response.json().catch(()=>({}));
    return {status:response.status,data:payload.data,error:payload.error};
  };
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
  return {base,human,call,workspace,root};
}

const finding=(overrides:Record<string,unknown>={})=>({title:'Callback signature is never verified',severity:'critical',category:'security',
  location:{path:'src/pay/callback.ts',startLine:42},evidence:'handleCallback marks the order paid without verifying the HMAC.',
  suggestion:'Verify the merchant HMAC before trusting the payload.',...overrides});

describe('collaboration HTTP API',()=>{
  it('runs a full review loop over HTTP and closes the session',async()=>{
    const {call,workspace}=await boot();
    const created=await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Payment callback review',workspaceId:workspace.id,subject:{type:'commit_range',value:'HEAD~1..HEAD'}});
    expect(created.status).toBe(201);
    const sessionId=created.data.sessionId;

    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer-security',agentId:'agent-reviewer-security'})).data;
    const implementer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'implementer',agentId:'agent-implementer'})).data;
    expect(reviewer.participantToken).toMatch(/^cpt_/);
    expect(reviewer.briefing).toMatchObject({task:expect.any(String)});

    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    const digest=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data;
    expect(digest).toMatchObject({task:'file_findings',phase:'collecting',round:1});

    const submitted=await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:digest.baseline.baselineId,findings:[finding()],reviewComplete:true},reviewer.participantToken);
    expect(submitted.status).toBe(201);
    const issueId=submitted.data.accepted[0].issueId;

    const implDigest=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,implementer.participantToken)).data;
    expect(implDigest).toMatchObject({task:'respond_to_issues',phase:'responding'});
    const responded=await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),responses:[{issueId,responseType:'fixed',changes:[{path:'src/pay/callback.ts',summary:'verify the HMAC'}],codeRef:{dirtyHash:'sha256:new'}}]},implementer.participantToken);
    expect(responded.data.accepted).toEqual([{issueId,status:'answered'}]);

    const ruled=await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),verdicts:[{issueId,verdict:'accept'}]},reviewer.participantToken);
    expect(ruled.data.accepted).toEqual([{issueId,status:'resolved'}]);

    const report=(await call('GET',`/api/v1/collab/sessions/${sessionId}/report`)).data;
    expect(report.session).toMatchObject({phase:'finished',status:'finished'});
    expect(report.progress).toMatchObject({openIssues:0,totalIssues:1});
  });

  it('rejects a malformed submission with per-field codes an agent can act on',async()=>{
    const {call,workspace}=await boot();
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Review',workspaceId:workspace.id,subject:{type:'free',value:'everything'}})).data.sessionId;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    const baselineId=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data.baseline.baselineId;

    const invalid=await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId,
      findings:[{title:'no',serverity:'critical',category:'security',location:{path:'a.ts'}}]},reviewer.participantToken);
    expect(invalid.status).toBe(422);
    expect(invalid.error.code).toBe('VALIDATION_FAILED');
    expect(invalid.error.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'findings[0].title',code:'TOO_SHORT'}),
      expect.objectContaining({path:'findings[0].serverity',code:'UNKNOWN_FIELD'}),
      expect.objectContaining({path:'findings[0].severity',code:'REQUIRED'}),
      expect.objectContaining({path:'findings[0].evidence',code:'REQUIRED'})
    ]));

    const stale=await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:'b-old',findings:[finding()]},reviewer.participantToken);
    expect(stale.status).toBe(409);
    expect(stale.error).toMatchObject({code:'STALE_BASELINE',currentBaseline:{baselineId}});
  });

  it('keeps human-only endpoints closed to participant tokens and scopes tokens to their session',async()=>{
    const {call,workspace}=await boot();
    const first=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'First review',workspaceId:workspace.id,subject:{type:'free',value:'a'}})).data;
    const second=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Second review',workspaceId:workspace.id,subject:{type:'free',value:'b'}})).data;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${first.sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1'})).data;
    const token=reviewer.participantToken;

    expect((await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Agent made this',workspaceId:workspace.id,subject:{type:'free',value:'x'}},token)).status).toBe(403);
    expect((await call('POST',`/api/v1/collab/sessions/${first.sessionId}/participants`,{role:'reviewer',displayName:'r2',agentId:'agent-r2'},token)).status).toBe(403);
    expect((await call('POST',`/api/v1/collab/sessions/${first.sessionId}/advance`,{force:true,reason:'because I said so'},token)).status).toBe(403);
    expect((await call('GET','/api/v1/collab/escalations',undefined,token)).status).toBe(403);
    // The close-out report lists every issue and escalation, so it is a human view even inside the own session.
    expect((await call('GET',`/api/v1/collab/sessions/${first.sessionId}/report`,undefined,token)).status).toBe(403);

    const leak=await call('GET',`/api/v1/collab/sessions/${second.sessionId}`,undefined,token);
    expect(leak.status).toBe(404);
    expect(leak.error.code).toBe('COLLAB_SESSION_NOT_FOUND');
    expect((await call('GET','/api/v1/collab/sessions',undefined,token)).data.map((entry:any)=>entry.sessionId)).toEqual([first.sessionId]);
    expect((await call('GET','/api/v1/collab/sessions',undefined,'cpt_forged')).status).toBe(401);
  });

  it('routes a dispute to a human queue and applies the ruling',async()=>{
    const {call,workspace}=await boot();
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Disputed review',workspaceId:workspace.id,subject:{type:'free',value:'a'}})).data.sessionId;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1'})).data;
    const implementer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',agentId:'agent-impl'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    const baselineId=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId,findings:[finding()],reviewComplete:true},reviewer.participantToken)).data.accepted[0].issueId;

    const escalated=await call('POST',`/api/v1/collab/sessions/${sessionId}/escalations`,{clientRequestId:rid(),kind:'issue_dispute',refId:issueId,
      summary:'We disagree about whether this callback path is reachable in production at all.',question:'Is the path reachable?',options:['yes','no'],urgency:'high'},implementer.participantToken);
    expect(escalated.status).toBe(202);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('awaiting_human');

    const pending=(await call('GET','/api/v1/collab/escalations?status=pending')).data;
    expect(pending).toHaveLength(1);
    const resolved=await call('POST',`/api/v1/collab/escalations/${pending[0].escalationId}/resolve`,{decision:'fix in this round',rationale:'Internal retries bypass the proxy, so the handler must verify signatures.',issueDecision:'resolved'});
    expect(resolved.data.status).toBe('resolved');
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/issues/${issueId}`)).data.status).toBe('human_ruled');
    expect((await call('GET','/api/v1/collab/escalations?status=pending')).data).toHaveLength(0);
  });

  it('replays an idempotent submission and streams collaboration events over the WebSocket',async()=>{
    const {base,human,call,workspace}=await boot();
    const socket=new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/v1/ws`,[`access-token.${human}`]);
    const messages:any[]=[];
    await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject)});
    socket.on('message',raw=>messages.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({type:'subscribe_collab'}));
    await new Promise(resolve=>setTimeout(resolve,50));

    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Streamed review',workspaceId:workspace.id,subject:{type:'free',value:'a'}})).data.sessionId;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    const baselineId=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data.baseline.baselineId;

    const clientRequestId=rid(),payload={clientRequestId,baselineId,findings:[finding()],reviewComplete:false};
    const first=await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,payload,reviewer.participantToken);
    const replay=await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,payload,reviewer.participantToken);
    expect(replay.data).toEqual(first.data);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/issues`)).data).toHaveLength(1);

    await new Promise(resolve=>setTimeout(resolve,100));
    socket.close();
    expect(messages[0]).toMatchObject({type:'subscribed_collab'});
    const types=messages.filter(message=>message.type==='collab_event').map(message=>message.event.type);
    expect(types).toEqual(expect.arrayContaining(['session_created','participant_added','phase_changed','issue_opened']));
    const events=(await call('GET',`/api/v1/collab/sessions/${sessionId}/events?since=0`)).data;
    expect(events.map((event:any)=>event.sequence)).toEqual(events.map((_:unknown,index:number)=>index+1));
  });

  it('routes the participant sub-resources over HTTP instead of swallowing them into registration',async()=>{
    const {call,workspace}=await boot();
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Repair paths',workspaceId:workspace.id,subject:{type:'free',value:'a'}})).data.sessionId;
    const seat=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1',tokenBudget:1000})).data;
    const participantId=seat.participant.participantId;

    // These two are the documented repair paths for a stuck seat. They used to answer
    // "role REQUIRED, displayName REQUIRED, agentId REQUIRED" because the register branch matched first.
    const budget=await call('POST',`/api/v1/collab/sessions/${sessionId}/participants/${participantId}/budget`,{tokenBudget:900_000});
    expect(budget.status).toBe(200);
    expect(budget.data).toMatchObject({participantId,tokenBudget:900_000});
    const rebound=await call('POST',`/api/v1/collab/sessions/${sessionId}/participants/${participantId}/binding`,{agentId:'agent-r1-replacement',model:'anthropic/claude-sonnet-4'});
    expect(rebound.status).toBe(200);
    expect(rebound.data.participant).toMatchObject({agentId:'agent-r1-replacement',model:'anthropic/claude-sonnet-4'});
    expect(rebound.data.participantToken).toMatch(/^cpt_/);
    // A seat without an agent is not a thing any more: the hub has to know who to wake.
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/participants/${participantId}/binding`,{})).status).toBe(422);

    const seats=(await call('GET',`/api/v1/collab/sessions/${sessionId}/participants`)).data;
    expect(seats).toHaveLength(1);                                   // no stray participant was registered
    expect(seats[0]).toMatchObject({tokenBudget:900_000});
    // Registration itself still works, and an unknown sub-resource is a 404, not a registration.
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',agentId:'agent-impl'})).status).toBe(201);
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/participants/${participantId}/nonsense`,{})).status).toBe(404);
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/advance/nonsense`,{})).status).toBe(404);
    // A participant token must not be able to use the human repair paths (the rebind rotated it, so use the new one).
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/participants/${participantId}/budget`,{tokenBudget:950_000},rebound.data.participantToken)).status).toBe(403);
  });

  it('keeps collaboration state across a restart',async()=>{
    const dataDir=await temp('remote-pi-collab-restart-'),root=await temp('collab-workspace-');
    server=new RemotePiServer({port:0,dataDir});
    const auth=await server.auth.init();let address=await server.start();
    const headers={authorization:`Bearer ${auth.token}`,'content-type':'application/json'};
    const post=async(port:number,url:string,body:unknown)=>(await (await fetch(`http://127.0.0.1:${port}${url}`,{method:'POST',headers,body:JSON.stringify(body)})).json()).data;
    const workspace=await post(address!.port,'/api/v1/workspaces',{label:'w',rootPath:root});
    const session=await post(address!.port,'/api/v1/collab/sessions',{kind:'review',title:'Persisted review',workspaceId:workspace.id,subject:{type:'free',value:'a'}});
    await post(address!.port,`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'r1',agentId:'agent-r1'});

    await server.stop();
    server=new RemotePiServer({port:0,dataDir});address=await server.start();
    const restored=await (await fetch(`http://127.0.0.1:${address!.port}/api/v1/collab/sessions/${session.sessionId}`,{headers})).json();
    expect(restored.data).toMatchObject({title:'Persisted review',phase:'draft'});
    expect(restored.data.participants).toHaveLength(1);
  });
});
