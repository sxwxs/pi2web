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
  const auth=await server.auth.init(),address=await server.start();
  const base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
  const call=async(method:string,url:string,body?:unknown,token=human)=>{
    const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload:any=await response.json().catch(()=>({}));
    return {status:response.status,data:payload.data,error:payload.error};
  };
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
  return {call,workspace,agents,root};
}

const finding=(overrides:Record<string,unknown>={})=>({title:'Retry loop can double-charge a payment',severity:'critical',category:'correctness',
  location:{path:'src/pay/charge.ts',startLine:88},evidence:'chargeOnce() retries on timeout without an idempotency key, so a slow gateway is charged twice.',
  suggestion:'Send the order id as the idempotency key.',...overrides});

describe('build-then-review loop',()=>{
  it('lets the implementer work first, calls the reviewers on ready, and negotiates until both sides agree',async()=>{
    const {call,workspace}=await boot();
    const created=await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Charge retry work',workspaceId:workspace.id,
      subject:{type:'free',value:'payment retry hardening'},policy:{implementationFirst:true}});
    const sessionId=created.data.sessionId;
    expect(created.data.policy).toMatchObject({implementationFirst:true,autoReviewOnAgentIdle:true});

    const dev=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:'agent-dev'})).data;
    const reviewerA=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer-a',agentId:'agent-reviewer-a'})).data;
    const reviewerB=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer-b',agentId:'agent-reviewer-b'})).data;

    // Opening the session starts the *implementation*, not the review.
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('implementing');
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,dev.participantToken)).data).toMatchObject({task:'implement',phase:'implementing'});
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewerA.participantToken)).data.task).toBe('wait');
    // Reviewers cannot jump the gun while the code is still being written.
    expect((await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:'b-none',findings:[finding()]},reviewerA.participantToken)).status).toBe(409);

    // The implementer declares itself done: the hub pins a baseline and calls every reviewer by itself.
    const ready=await call('POST',`/api/v1/collab/sessions/${sessionId}/ready`,{clientRequestId:rid(),
      summary:'Added an idempotency key to the retry path and covered it with a test.',
      changes:[{path:'src/pay/charge.ts',summary:'pass the order id as idempotency key'}],codeRef:{dirtyHash:'sha256:dev-1'}},dev.participantToken);
    expect(ready.data).toMatchObject({accepted:true,phase:'collecting'});
    const digestA=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewerA.participantToken)).data;
    expect(digestA).toMatchObject({task:'file_findings',phase:'collecting',round:1});
    expect(digestA.baseline.baselineId).toBeTruthy();
    // Every reviewer is called by the hub, not just the one that happened to ask.
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewerB.participantToken)).data).toMatchObject({task:'file_findings'});

    // Reviewer A files an issue, reviewer B approves by finishing with nothing to report.
    const issueId=(await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:digestA.baseline.baselineId,
      findings:[finding()],reviewComplete:true},reviewerA.participantToken)).data.accepted[0].issueId;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:digestA.baseline.baselineId,findings:[],reviewComplete:true},reviewerB.participantToken);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('responding');

    // The developer disagrees and says so, with a rationale. That does not close the issue.
    const rejected=await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),
      responses:[{issueId,responseType:'rejected',rationale:'The gateway already deduplicates by order id, so a second charge cannot land.'}]},dev.participantToken);
    expect(rejected.data.accepted).toEqual([{issueId,status:'answered'}]);

    // The reporter is unconvinced: rejecting the answer sends the issue into another round.
    const verdict=await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),
      verdicts:[{issueId,verdict:'reject',rationale:'Gateway deduplication is documented as best effort, so it does not cover the timeout path.'}]},reviewerA.participantToken);
    expect(verdict.data.accepted).toEqual([{issueId,status:'open'}]);
    const round2=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(round2).toMatchObject({phase:'collecting',round:2});

    // Round 2 re-verifies against a fresh baseline; then the developer fixes it and the reporter accepts.
    const baseline2=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewerA.participantToken)).data.baseline.baselineId;
    for (const reviewer of [reviewerA,reviewerB])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline2,findings:[],reviewComplete:true},reviewer.participantToken);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),
      responses:[{issueId,responseType:'fixed',changes:[{path:'src/pay/charge.ts',summary:'add the idempotency key'}],codeRef:{dirtyHash:'sha256:dev-2'}}]},dev.participantToken);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),verdicts:[{issueId,verdict:'accept'}]},reviewerA.participantToken);

    const report=(await call('GET',`/api/v1/collab/sessions/${sessionId}/report`)).data;
    expect(report.session).toMatchObject({phase:'finished',status:'finished'});
    expect(report.session.outcome).toMatchObject({verdict:'approved',approval:{unanimous:true}});
    expect(report.session.outcome.approval.reviewers).toEqual(expect.arrayContaining([
      expect.objectContaining({participantId:reviewerA.participant.participantId,approved:true,filed:1}),
      expect.objectContaining({participantId:reviewerB.participant.participantId,approved:true,filed:0})
    ]));
  });

  it('escalates to a human when the two sides never converge',async()=>{
    const {call,workspace}=await boot();
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Deadlock',workspaceId:workspace.id,
      subject:{type:'free',value:'x'},policy:{implementationFirst:true,maxIssueRounds:1}})).data.sessionId;
    const dev=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:'agent-dev'})).data;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    await call('POST',`/api/v1/collab/sessions/${sessionId}/ready`,{clientRequestId:rid(),summary:'First implementation is complete.'},dev.participantToken);

    const baselineId=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId,findings:[finding()],reviewComplete:true},reviewer.participantToken)).data.accepted[0].issueId;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),
      responses:[{issueId,responseType:'rejected',rationale:'Not a defect: the retry path is unreachable in production.'}]},dev.participantToken);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),
      verdicts:[{issueId,verdict:'reject',rationale:'The retry path is reachable whenever the gateway times out under load.'}]},reviewer.participantToken);

    // maxIssueRounds is spent, so the hub parks the session on a human instead of looping forever.
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('awaiting_human');
    const pending=(await call('GET',`/api/v1/collab/escalations?status=pending`)).data;
    expect(pending[0]).toMatchObject({kind:'issue_dispute',refId:issueId});
    expect(pending[0].positions.length).toBeGreaterThan(0);

    const resolved=await call('POST',`/api/v1/collab/escalations/${pending[0].escalationId}/resolve`,
      {decision:'fix in this round',rationale:'The timeout path is reachable; add the idempotency key.',issueDecision:'resolved'});
    expect(resolved.status).toBe(200);
    const report=(await call('GET',`/api/v1/collab/sessions/${sessionId}/report`)).data;
    expect(report.session).toMatchObject({phase:'finished',status:'finished'});
    expect(report.session.outcome).toMatchObject({verdict:'closed_after_human_ruling'});
  });

  it('starts the review by itself when a managed implementer agent goes idle',async()=>{
    // The real SDK backend emits `agent_settled` once a turn is truly finished; the mock has to do the same here.
    class SettlingBackend extends MockBackend {
      async prompt(message:string){await super.prompt(message);(this as any).emit({type:'agent_settled'})}
    }
    const {call,workspace,agents}=await boot((id,cwd)=>new SettlingBackend(id,cwd));
    const agent=(await call('POST','/api/v1/agents',{workspaceId:workspace.id})).data;
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Auto hand-off',workspaceId:workspace.id,
      subject:{type:'free',value:'x'},policy:{implementationFirst:true}})).data.sessionId;
    const dev=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:agent.agentId})).data;
    const reviewer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('implementing');

    // The work order is a plain task, not the whole protocol: nothing in it invites the agent to poll or sleep.
    const prompts=async()=>((await agents.messages(agent.agentId)) as any[]).map(entry=>String((entry as any).content??''));
    await waitUntil(async()=>(await prompts()).some(text=>text.includes('task now due: implement')));
    const workOrder=(await prompts()).find(text=>text.includes('task now due: implement'))!;
    expect(workOrder).toContain('Do NOT sleep, poll, retry in a loop');
    expect(workOrder).not.toContain('/findings');

    await agents.command(agent.agentId,'prompt','implementation finished');
    await waitUntil(async()=>(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase==='collecting');

    const digest=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,reviewer.participantToken)).data;
    expect(digest).toMatchObject({task:'file_findings',phase:'collecting'});
    const events=(await call('GET',`/api/v1/collab/sessions/${sessionId}/events`)).data;
    expect(events.find((event:any)=>event.type==='implementation_ready')?.payload).toMatchObject({trigger:'agent_idle'});

    // When the reviewer is done the hub carries the findings back to the developer; the developer never asks.
    const issueId=(await call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:digest.baseline.baselineId,
      findings:[finding()],reviewComplete:true},reviewer.participantToken)).data.accepted[0].issueId;
    await waitUntil(async()=>(await prompts()).some(text=>text.includes('task now due: respond_to_issues')));

    // And when it is all over the developer is told so, instead of being left waiting for a verdict.
    await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),
      responses:[{issueId,responseType:'fixed',changes:[{path:'src/pay/charge.ts',summary:'add the idempotency key'}],codeRef:{dirtyHash:'sha256:dev-2'}}]},dev.participantToken);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),verdicts:[{issueId,verdict:'accept'}]},reviewer.participantToken);
    await waitUntil(async()=>(await prompts()).some(text=>text.includes('Collaboration session "Auto hand-off" is finished')));
  });
});

async function waitUntil(probe:()=>Promise<boolean>,timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(!(await probe())){
    if(Date.now()>deadline)throw Error('Timed out waiting for the collaboration session to advance');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
