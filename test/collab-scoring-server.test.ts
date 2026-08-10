import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {RemotePiServer} from '../src/server.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});

const temp=(prefix:string)=>mkdtemp(path.join(tmpdir(),prefix));
const rid=()=>`req-${randomUUID()}`;

async function boot(policy?:Record<string,unknown>){
  const dataDir=await temp('remote-pi-scoring-'),root=await temp('scoring-workspace-');
  server=new RemotePiServer({port:0,dataDir});
  const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
  const call=async(method:string,url:string,body?:unknown,token=human)=>{
    const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload=await response.json().catch(()=>({}));
    return {status:response.status,data:payload.data,error:payload.error};
  };
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
  const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'scoring',title:'Panel scoring of the payment refactor',workspaceId:workspace.id,
    subject:{type:'commit_range',value:'HEAD~3..HEAD'},...(policy?{policy}:{})})).data.sessionId;
  const seat=async(role:string,displayName:string)=>(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role,displayName,binding:{type:'external'}})).data;
  return {call,sessionId,seat};
}

const nomination=(name:string,overrides:Record<string,unknown>={})=>({name,definition:`Whether the change is sound with respect to ${name} across the reviewed range.`,weightSuggestion:0.5,...overrides});
const evidence=[{path:'src/pay/callback.ts',startLine:42,excerpt:'handleCallback()'}];

describe('panel scoring over HTTP',()=>{
  it('negotiates a rubric, scores blind, debates the outlier, and converges',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:2,maxCriteria:3,convergenceRange:2,maxDebateRounds:2}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b'),impl=await seat('implementer','implementer');

    // Nominating stays blind: each panelist only sees its own proposals.
    await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security'),nomination('tests')],nominationsComplete:true},a.participantToken);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`,undefined,b.participantToken)).data).toHaveLength(0);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},b.participantToken);

    const voting=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(voting.phase).toBe('voting');
    const candidates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`,undefined,a.participantToken)).data;
    expect(candidates).toHaveLength(3);

    const vote=(token:string,stances:Record<string,string>)=>call('POST',`/api/v1/collab/sessions/${sessionId}/votes`,{clientRequestId:rid(),
      votes:candidates.map((criterion:any,index:number)=>({criterionId:criterion.criterionId,stance:stances[String(index)],weight:0.5,
        ...(stances[String(index)]==='reject'?{rationale:'Duplicate of another criterion.'}:{})}))},token);
    await vote(a.participantToken,{0:'approve',1:'approve',2:'reject'});
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/votes`,undefined,b.participantToken)).data).toHaveLength(0);
    await vote(b.participantToken,{0:'approve',1:'approve',2:'reject'});

    const locked=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(locked.phase).toBe('scoring');
    const rubric=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data.filter((criterion:any)=>criterion.state==='approved');
    expect(rubric).toHaveLength(2);
    expect(rubric.reduce((sum:number,criterion:any)=>sum+criterion.weight,0)).toBeCloseTo(1,5);

    const score=(token:string,values:number[],extra:Record<string,unknown>={})=>call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:rubric.map((criterion:any,index:number)=>({criterionId:criterion.criterionId,score:values[index],rationale:'Anchored on the callback handler and its tests.',evidence,...extra}))},token);
    await score(a.participantToken,[3,8]);
    const sealed=await call('GET',`/api/v1/collab/sessions/${sessionId}/analysis`,undefined,b.participantToken);
    expect(sealed.status).toBe(403);
    expect(sealed.error.code).toBe('SCORES_SEALED');
    await score(b.participantToken,[9,8]);

    const debating=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(debating.phase).toBe('debating');
    const debates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/debates`)).data;
    expect(debates).toHaveLength(1);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}/analysis`,undefined,a.participantToken)).data.contested).toHaveLength(1);

    const argue=(token:string,stance:string)=>call('POST',`/api/v1/collab/sessions/${sessionId}/debates/${debates[0].debateId}/arguments`,
      {clientRequestId:rid(),stance,argument:'The unauthenticated retry path is reachable, which is why I scored this low.',evidence},token);
    const recused=await argue(impl.participantToken,'raise');
    expect(recused.status).toBe(403);
    expect((await argue(impl.participantToken,'clarify')).status).toBe(201);
    await argue(a.participantToken,'hold');
    await argue(b.participantToken,'lower');
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('rescoring');

    const missingReason=await score(a.participantToken,[4,8]);
    expect(missingReason.status).toBe(422);
    expect(missingReason.error.fieldErrors[0]).toMatchObject({code:'REQUIRED',path:'scores[0].changeReason'});
    await score(a.participantToken,[4,8],{changeReason:'The retry path is guarded in staging, so the risk is lower than I first assumed.'});
    await score(b.participantToken,[5,8],{changeReason:'I accept that the retry path is reachable at all, so I lowered my score.'});

    const finished=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(finished).toMatchObject({phase:'finalized',status:'finished'});
    expect(finished.outcome.criteria).toHaveLength(2);
    expect(finished.outcome.criteria.find((criterion:any)=>criterion.spread===1)).toMatchObject({finalScore:4.5,method:'debated'});
    expect(finished.outcome.totalScore).toBeGreaterThan(0);
  });

  it('refuses a score without evidence, off the scale, or from the recused implementer',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:1,maxCriteria:2}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b'),impl=await seat('implementer','implementer');
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},token);
    const candidates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data;
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/votes`,{clientRequestId:rid(),votes:candidates.map((criterion:any)=>({criterionId:criterion.criterionId,stance:'approve',weight:0.5}))},token);
    const criterionId=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data.find((criterion:any)=>criterion.state==='approved').criterionId;

    const noEvidence=await call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:[{criterionId,score:6,rationale:'It looks broadly reasonable to me overall.',evidence:[]}]},a.participantToken);
    expect(noEvidence.status).toBe(422);
    expect(noEvidence.error.fieldErrors[0]).toMatchObject({path:'scores[0].evidence',code:'TOO_FEW_ITEMS'});

    const offScale=await call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:[{criterionId,score:6.3,rationale:'It looks broadly reasonable to me overall.',evidence}]},a.participantToken);
    expect(offScale.error.fieldErrors[0]).toMatchObject({path:'scores[0].score',code:'NOT_A_MULTIPLE'});

    const recused=await call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:[{criterionId,score:9,rationale:'My own work is obviously excellent in every way.',evidence}]},impl.participantToken);
    expect(recused.status).toBe(403);
    expect(recused.error.code).toBe('COLLAB_FORBIDDEN');
  });

  it('hands scores that never converge to a human and applies the ruling',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:1,maxCriteria:2,convergenceRange:1,maxDebateRounds:0}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b');
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},token);
    const candidates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data;
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/votes`,{clientRequestId:rid(),votes:candidates.map((criterion:any)=>({criterionId:criterion.criterionId,stance:'approve',weight:0.5}))},token);
    const rubric=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data.filter((criterion:any)=>criterion.state==='approved');
    const criterionId=rubric[0].criterionId;
    const score=(token:string,value:number)=>call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:rubric.map((criterion:any)=>({criterionId:criterion.criterionId,score:value,rationale:'Anchored on the callback handler and its tests.',evidence}))},token);
    await score(a.participantToken,2);
    await score(b.participantToken,9);

    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('awaiting_human');
    const pending=(await call('GET','/api/v1/collab/escalations?status=pending')).data;
    expect(pending[0]).toMatchObject({kind:'score_dispute'});
    expect(pending[0].positions).toHaveLength(4); // two panelists x two contested criteria

    // A score dispute is only settled through /finalize, which needs one on-scale ruling per contested criterion.
    const viaEscalation=await call('POST',`/api/v1/collab/escalations/${pending[0].escalationId}/resolve`,{decision:'take the median',rationale:'Splitting the difference between the two panelists.'});
    expect(viaEscalation.status).toBe(409);
    const incomplete=await call('POST',`/api/v1/collab/sessions/${sessionId}/finalize`,{rulings:[{criterionId,score:5,rationale:'The risk is real but mitigated in production.'}]});
    expect(incomplete.status).toBe(422);
    expect(incomplete.error.fieldErrors[0]).toMatchObject({path:'rulings',code:'REQUIRED'});
    const offScale=await call('POST',`/api/v1/collab/sessions/${sessionId}/finalize`,{rulings:rubric.map((criterion:any)=>({criterionId:criterion.criterionId,score:99,rationale:'Out of the configured scale on purpose.'}))});
    expect(offScale.error.fieldErrors[0]).toMatchObject({path:'rulings[0].score',code:'OUT_OF_RANGE'});

    const report=(await call('POST',`/api/v1/collab/sessions/${sessionId}/finalize`,{rulings:rubric.map((criterion:any)=>({criterionId:criterion.criterionId,score:5,rationale:'The risk is real but mitigated in production.'}))})).data;
    expect(report.criteria.find((criterion:any)=>criterion.criterionId===criterionId)).toMatchObject({finalScore:5,method:'human_ruled'});
    expect(report.dissents.length).toBeGreaterThan(0);
    // The ruling and the dispute are one act: nothing may stay pending on the human's board afterwards.
    expect((await call('GET','/api/v1/collab/escalations?status=pending')).data).toHaveLength(0);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data).toMatchObject({phase:'finalized',status:'finished'});
  });

  it('carries an untouched criterion forward through a rescore instead of finalizing it at zero',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:2,maxCriteria:2,convergenceRange:1,maxDebateRounds:1}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b');
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},token);
    const candidates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data;
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/votes`,{clientRequestId:rid(),votes:candidates.map((criterion:any)=>({criterionId:criterion.criterionId,stance:'approve',weight:0.5}))},token);
    const rubric=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data.filter((criterion:any)=>criterion.state==='approved');
    expect(rubric).toHaveLength(2);
    const score=(token:string,values:number[],extra:Record<string,unknown>={})=>call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:rubric.map((criterion:any,index:number)=>({criterionId:criterion.criterionId,score:values[index],rationale:'Anchored on the callback handler and its tests.',evidence,...extra}))},token);
    // Only the first criterion is contested; the second one is agreed at 8 and is never rescored.
    await score(a.participantToken,[3,8]);
    await score(b.participantToken,[9,8]);
    const debates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/debates`)).data;
    expect(debates).toHaveLength(1);
    const argue=(token:string,stance:string)=>call('POST',`/api/v1/collab/sessions/${sessionId}/debates/${debates[0].debateId}/arguments`,
      {clientRequestId:rid(),stance,argument:'The unauthenticated retry path is reachable, which is why I scored this low.',evidence},token);
    await argue(a.participantToken,'hold');
    await argue(b.participantToken,'lower');
    const rescore=(token:string,value:number)=>call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:[{criterionId:rubric[0].criterionId,score:value,rationale:'Anchored on the callback handler and its tests.',evidence,
        changeReason:'The debate moved me: the retry path is guarded in staging.'}]},token);
    await rescore(a.participantToken,5);
    await rescore(b.participantToken,5);

    const finished=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(finished).toMatchObject({phase:'finalized',status:'finished'});
    const untouched=finished.outcome.criteria.find((criterion:any)=>criterion.criterionId===rubric[1].criterionId);
    expect(untouched).toMatchObject({finalScore:8,spread:0});
  });

  it('closes the score dispute when a human forces the session past awaiting_human',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:1,maxCriteria:2,convergenceRange:1,maxDebateRounds:0}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b');
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},token);
    const candidates=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data;
    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/votes`,{clientRequestId:rid(),votes:candidates.map((criterion:any)=>({criterionId:criterion.criterionId,stance:'approve',weight:0.5}))},token);
    const rubric=(await call('GET',`/api/v1/collab/sessions/${sessionId}/criteria`)).data.filter((criterion:any)=>criterion.state==='approved');
    const score=(token:string,value:number)=>call('POST',`/api/v1/collab/sessions/${sessionId}/scores`,{clientRequestId:rid(),
      scores:rubric.map((criterion:any)=>({criterionId:criterion.criterionId,score:value,rationale:'Anchored on the callback handler and its tests.',evidence}))},token);
    await score(a.participantToken,2);
    await score(b.participantToken,9);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('awaiting_human');

    // The board's force button must not strand the dispute: /finalize refuses a finished session, so the
    // escalation used to stay pending with no endpoint able to close it.
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{force:true,reason:'The panel is out of time and the release is blocked.'});
    const finished=(await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data;
    expect(finished).toMatchObject({phase:'finalized',status:'finished'});
    expect((await call('GET','/api/v1/collab/escalations?status=pending')).data).toHaveLength(0);
    // A score nobody agreed on is reported as forced, never as "converged".
    expect(finished.outcome.criteria.every((criterion:any)=>criterion.method==='forced')).toBe(true);
  });

  it('accepts an escalation from a panelist, parks the panel, and resumes on the ruling',async()=>{
    const {call,sessionId,seat}=await boot({scoring:{minCriteria:1,maxCriteria:2}});
    const a=await seat('reviewer','reviewer-a'),b=await seat('reviewer','reviewer-b');
    // This used to persist the escalation and then fail with "Phase nominating cannot advance", because the
    // review state machine was run on a scoring session.
    const raised=await call('POST',`/api/v1/collab/sessions/${sessionId}/escalations`,{clientRequestId:rid(),kind:'other',
      summary:'The subject range contains generated files that nobody on the panel can judge.',
      question:'Should the generated bundle be excluded from the scored range?'},a.participantToken);
    expect(raised.status).toBe(202);

    for(const token of [a.participantToken,b.participantToken])
      await call('POST',`/api/v1/collab/sessions/${sessionId}/nominations`,{clientRequestId:rid(),nominations:[nomination('security')],nominationsComplete:true},token);
    // A pending question to a human parks the panel instead of being overtaken by the next phase.
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('nominating');
    const blocked=await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    expect(blocked.status).toBe(409);
    expect(blocked.error.message).toMatch(/await a human ruling/);

    await call('POST',`/api/v1/collab/escalations/${raised.data.escalationId}/resolve`,{decision:'exclude the bundle',rationale:'The generated bundle is not part of the reviewed work.'});
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('voting');
  });

  it('refuses a human seat and a scale that no score could satisfy',async()=>{
    const {call,sessionId}=await boot();
    // A `human` seat would hold a participant token with nominate/vote/score rights the panel never waits for.
    const seatAsHuman=await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'human',displayName:'operator',binding:{type:'external'}});
    expect(seatAsHuman.status).toBe(422);
    expect(seatAsHuman.error.fieldErrors[0]).toMatchObject({path:'role',code:'NOT_ALLOWED'});

    const inverted=await call('POST',`/api/v1/collab/sessions/${sessionId}/policy`,{scoring:{scale:{min:10,max:1,step:1}}});
    expect(inverted.status).toBe(422);
    expect(inverted.error.fieldErrors[0]).toMatchObject({path:'scoring.scale.max',code:'OUT_OF_ORDER'});
    const unusableStep=await call('POST',`/api/v1/collab/sessions/${sessionId}/policy`,{scoring:{scale:{min:0,max:5,step:9}}});
    expect(unusableStep.error.fieldErrors[0]).toMatchObject({path:'scoring.scale.step',code:'TOO_LARGE'});
    const invertedCriteria=await call('POST',`/api/v1/collab/sessions/${sessionId}/policy`,{scoring:{minCriteria:5,maxCriteria:2}});
    expect(invertedCriteria.error.fieldErrors[0]).toMatchObject({path:'scoring.maxCriteria',code:'OUT_OF_ORDER'});
  });
});
