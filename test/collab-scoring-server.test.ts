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

    const report=(await call('POST',`/api/v1/collab/sessions/${sessionId}/finalize`,{rulings:[{criterionId,score:5,rationale:'The risk is real but mitigated in production.'}]})).data;
    expect(report.criteria.find((criterion:any)=>criterion.criterionId===criterionId)).toMatchObject({finalScore:5,method:'human_ruled'});
    expect(report.dissents.length).toBeGreaterThan(0);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data).toMatchObject({phase:'finalized',status:'finished'});
  });
});
