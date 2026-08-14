import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});
const temp=(prefix:string)=>mkdtemp(path.join(tmpdir(),prefix));
const rid=()=>`req-${randomUUID()}`;

async function boot(factory:(id:string,cwd:string)=>MockBackend=(id,cwd)=>new MockBackend(id,cwd)){
  const dataDir=await temp('remote-pi-impl-'),root=await temp('impl-workspace-');
  const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,factory);
  server=new RemotePiServer({port:0,dataDir,workspaces,agents});
  const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
  const call=async(method:string,url:string,body?:unknown,token=human)=>{const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const payload:any=await response.json().catch(()=>({}));return {status:response.status,data:payload.data,error:payload.error}};
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
  return {call,workspace,agents};
}
const finding=()=>({title:'Retry loop can double-charge a payment',severity:'critical',category:'correctness',location:{path:'src/pay/charge.ts',startLine:88},evidence:'chargeOnce retries on timeout without an idempotency key, so a slow gateway can be charged twice.',suggestion:'Send the order id as the idempotency key.'});

describe('build, review, and explicit remediation',()=>{
  it('ends review immediately after findings and only starts fixing when a human asks',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Charge retry work',workspaceId:workspace.id,subject:{type:'free',value:'payment retry hardening'},policy:{implementationFirst:true}})).data;
    const dev=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:'agent-dev'})).data;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/ready`,{clientRequestId:rid(),summary:'Initial implementation is ready for independent review.'},dev.participantToken);
    const digest=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,reviewer.participantToken)).data;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:digest.baseline.baselineId,findings:[finding()],reviewComplete:true},reviewer.participantToken)).data.accepted[0].issueId;
    const report=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/report`)).data;
    expect(report.session).toMatchObject({phase:'finished',status:'finished',outcome:{verdict:'changes_required'}});
    expect(report.issues[0]).toMatchObject({issueId,status:'confirmed'});
    expect((await call('POST',`/api/v1/collab/sessions/${session.sessionId}/responses`,{clientRequestId:rid(),responses:[{issueId,responseType:'rejected'}]},dev.participantToken)).status).toBe(404);
  });

  it('adds a new developer to a finished review, fixes, and sends the result back to the original reviewer',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Explicit remediation',workspaceId:workspace.id,subject:{type:'free',value:'payment callback'}})).data;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const first=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,reviewer.participantToken)).data;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:first.baseline.baselineId,findings:[finding()],reviewComplete:true},reviewer.participantToken)).data.accepted[0].issueId;

    const added=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'implementer',displayName:'new developer',agentId:'agent-new-dev'})).data;
    expect(added.participant.role).toBe('implementer');
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/recheck`,{mode:'fix_then_review',implementerParticipantIds:[added.participant.participantId]});
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data).toMatchObject({phase:'implementing',round:2,status:'active'});

    const devToken=server!.collab.store.getDispatchToken(added.participant.participantId)!;
    const devDigest=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,devToken)).data;
    expect(devDigest).toMatchObject({task:'implement',issues:[expect.objectContaining({issueId,status:'confirmed'})]});
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/ready`,{clientRequestId:rid(),summary:'Added an idempotency key and a regression test.',changes:[{path:'src/pay/charge.ts',summary:'pass the order id as idempotency key'}],codeRef:{dirtyHash:'sha256:fixed'}},devToken);

    const reviewerToken=server!.collab.store.getDispatchToken(reviewer.participant.participantId)!;
    const recheck=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,reviewerToken)).data;
    expect(recheck).toMatchObject({task:'file_findings',round:2,issuesToRecheck:[expect.objectContaining({issueId})]});
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:recheck.baseline.baselineId,findings:[],rechecks:[{issueId,outcome:'resolved',rationale:'The retry path now supplies a stable order idempotency key.'}],reviewComplete:true},reviewerToken);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data).toMatchObject({phase:'finished',round:2,status:'finished',outcome:{verdict:'approved'}});
  });

  it('still hands initial implementation to reviewers automatically when a managed developer settles',async()=>{
    class SettlingBackend extends MockBackend {async prompt(message:string){await super.prompt(message);(this as any).emit({type:'agent_settled'})}}
    const {call,workspace,agents}=await boot((id,cwd)=>new SettlingBackend(id,cwd));
    const agent=(await call('POST','/api/v1/agents',{workspaceId:workspace.id})).data;
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Auto hand-off',workspaceId:workspace.id,subject:{type:'free',value:'x'},policy:{implementationFirst:true}})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:agent.agentId});
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    await waitUntil(async()=>((await agents.messages(agent.agentId)) as any[]).some(entry=>String(entry.content??'').includes('task now due: implement')));
    await agents.command(agent.agentId,'prompt','implementation finished');
    await waitUntil(async()=>(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase==='collecting');
    const token=server!.collab.store.getDispatchToken(reviewer.participant.participantId)!;
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,token)).data.task).toBe('file_findings');
  });
});

async function waitUntil(probe:()=>Promise<boolean>,timeoutMs=5000){const deadline=Date.now()+timeoutMs;while(!(await probe())){if(Date.now()>deadline)throw Error('Timed out waiting for collaboration progress');await new Promise(resolve=>setTimeout(resolve,25))}}
