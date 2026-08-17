import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {RemotePiServer} from '../src/server.js';

let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined});
const rid=()=>`req-${randomUUID()}`;

async function boot(){
  const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-consensus-')),root=await mkdtemp(path.join(tmpdir(),'consensus-workspace-'));
  server=new RemotePiServer({port:0,dataDir});const auth=await server.auth.init(),address=await server.start();
  const base=`http://127.0.0.1:${address!.port}`,headers={authorization:`Bearer ${auth.token}`,'content-type':'application/json'};
  const call=async(method:string,url:string,body?:unknown,token?:string)=>{const response=await fetch(base+url,{method,headers:{...headers,...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const payload=await response.json();return {status:response.status,data:payload.data,error:payload.error}};
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;return {call,workspace};
}
const finding=(title:string,line:number)=>({title,severity:'major',category:'correctness',location:{path:'src/example.ts',startLine:line},evidence:`The implementation at line ${line} demonstrably violates the required behavior.`,suggestion:'Correct the implementation and add a regression test.'});

describe('review consensus over HTTP',()=>{
  it('batches issue validation, unanimously votes on duplicate merges, debates rejects, and then finishes',async()=>{
    const {call,workspace}=await boot();
    const created=await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Consensus review',workspaceId:workspace.id,subject:{type:'free',value:'current branch'},policy:{consensusReview:true,maxConsensusRounds:2}});
    const sessionId=created.data.sessionId,tokens:Record<string,string>={},participantIds:Record<string,string>={};
    for(const name of ['A','B','C','D','E']){const seat=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:name,agentId:`agent-${name}`})).data;tokens[name]=seat.participantToken;participantIds[name]=seat.participant.participantId}
    const implementer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'developer',agentId:'agent-dev'})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${sessionId}/digest`,undefined,tokens.A)).data.baseline.baselineId;
    const submitFinding=async(name:string,findings:any[])=>call('POST',`/api/v1/collab/sessions/${sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings,reviewComplete:true},tokens[name]);
    const one=(await submitFinding('A',[finding('First duplicated correctness problem',10)])).data.accepted[0].issueId;
    const two=(await submitFinding('B',[finding('Independent concurrency correctness problem',20)])).data.accepted[0].issueId;
    await submitFinding('C',[]);
    const three=(await submitFinding('D',[finding('Same correctness problem described differently',30)])).data.accepted[0].issueId;
    await submitFinding('E',[]);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('validating');
    const retried=await call('POST',`/api/v1/collab/sessions/${sessionId}/retry-waiting`,{});
    expect(retried.data.retried).toHaveLength(5);

    const reporters:Record<string,string>={[one]:'A',[two]:'B',[three]:'D'};
    const initialVote=async(name:string,mergeProposals:any[]=[])=>call('POST',`/api/v1/collab/sessions/${sessionId}/issue-votes`,{clientRequestId:rid(),votes:[one,two,three].filter(id=>reporters[id]!==name).map(issueId=>({issueId,stance:name==='C'&&issueId===two?'reject':'approve',...(name==='C'&&issueId===two?{rationale:'The reported behavior is intentional and the evidence does not prove an actual defect.'}:{})})),mergeProposals,complete:true},tokens[name]);
    await initialVote('A',[{issueIds:[one,three],rationale:'These findings identify the same root cause and should have one implementation thread.'}]);
    await initialVote('B');await initialVote('C');
    await initialVote('D',[{issueIds:[three,one],rationale:'Both findings describe the same root cause despite using different locations.'}]);
    await initialVote('E');
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('merge_voting');
    const proposal=(await call('GET',`/api/v1/collab/sessions/${sessionId}/review-consensus`)).data.mergeProposals[0];
    expect(proposal.votes.filter((vote:any)=>vote.proposer).map((vote:any)=>vote.participantId).sort()).toEqual([participantIds.A,participantIds.D].sort());
    for(const name of ['B','C','E'])await call('POST',`/api/v1/collab/sessions/${sessionId}/merge-votes`,{clientRequestId:rid(),votes:[{proposalId:proposal.proposalId,stance:'approve'}],complete:true},tokens[name]);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('issue_discussing');
    const mergedIssues=(await call('GET',`/api/v1/collab/sessions/${sessionId}/issues`)).data;
    expect(mergedIssues.map((issue:any)=>issue.number)).toEqual([1,2,3]);
    expect(mergedIssues.filter((issue:any)=>issue.status==='duplicate')).toHaveLength(1);

    for(const name of ['A','B','D','E'])await call('POST',`/api/v1/collab/sessions/${sessionId}/issue-discussions`,{clientRequestId:rid(),discussions:[{issueId:two,argument:`${name} reviewed the rejection, and concrete execution evidence still shows this is a real correctness defect.`}],complete:true},tokens[name]);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('issue_reconsidering');
    await call('POST',`/api/v1/collab/sessions/${sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:two,stance:'approve'}],complete:true},tokens.C);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data).toMatchObject({phase:'finished',status:'finished'});

    const confirmed=(await call('GET',`/api/v1/collab/sessions/${sessionId}/issues`)).data.filter((issue:any)=>issue.status==='confirmed');
    expect(confirmed).toHaveLength(2);
    const consensus=(await call('GET',`/api/v1/collab/sessions/${sessionId}/review-consensus`)).data;
    expect(consensus.discussions).toHaveLength(4);expect(consensus.mergeProposals[0].votes).toHaveLength(5);
    expect(consensus.issueConsensus).toHaveLength(3);
    expect(consensus.issueConsensus.find((entry:any)=>entry.issueId===two).positions.every((position:any)=>position.stance==='approve')).toBe(true);
    expect(consensus.summary).toMatchObject({verdict:'follow_up_required',actionItemCount:2});
    expect(consensus.summary.actionItems.map((item:any)=>item.issueId)).toEqual(expect.arrayContaining([one,two]));
  });

  it('stops debating an unmoved vote early and escalates the split panel to a human',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Consensus deadlock',workspaceId:workspace.id,subject:{type:'free',value:'current branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const a=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'A',agentId:'agent-A'})).data;
    const b=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'B',agentId:'agent-B'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:'agent-dev'});
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('A disputed but concrete correctness issue',40)],reviewComplete:true},a.participantToken)).data.accepted[0].issueId;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},b.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},a.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:'The evidence describes expected behavior rather than a correctness defect in this execution path.'}],complete:true},b.participantToken);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data).toMatchObject({phase:'issue_discussing',debateRound:1});
    // Two identical ballots in a row settle it in fact: the third round of "I keep the rejection" is never asked for.
    for(const round of [1,2]){
      await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),discussions:[{issueId,argument:`Discussion round ${round}: the expected behavior claim conflicts with the concrete branch condition and reproducible execution evidence.`}],complete:true},a.participantToken);
      expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('issue_reconsidering');
      await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:`After discussion round ${round}, the branch condition still does not demonstrate user-visible incorrectness.`}],complete:true},b.participantToken);
      const current=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data;
      expect(current).toMatchObject(round===1?{phase:'issue_discussing',debateRound:2}:{phase:'awaiting_human'});
    }
    const stalled=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data;
    expect(stalled.phase).toBe('awaiting_human');expect(stalled.participants).toBeDefined();
    const escalations=(await call('GET',`/api/v1/collab/escalations?sessionId=${session.sessionId}&status=pending`)).data;
    expect(escalations).toHaveLength(1);expect(escalations[0]).toMatchObject({kind:'issue_dispute',refId:issueId});
    expect(escalations[0].summary).toContain('did not converge in 2 discussion round(s)');
    expect(escalations[0].positions.some((position:any)=>position.stance==='discussion round 2')).toBe(true);
  });

  it('drops a finding every other reviewer rejected instead of handing the dispute to a human',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Panel rejection',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:2}})).data;
    const seats:Record<string,any>={};
    for(const name of ['A','B','C'])seats[name]=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:name,agentId:`agent-${name}`})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.A.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('A finding the rest of the panel rejects',12)],reviewComplete:true},seats.A.participantToken)).data.accepted[0].issueId;
    for(const name of ['B','C'])await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},seats[name].participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},seats.A.participantToken);
    for(const name of ['B','C'])await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:'The cited behaviour is intentional and documented, so this is not a defect in the reviewed change.'}],complete:true},seats[name].participantToken);
    for(const round of [1,2]){
      await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),discussions:[{issueId,argument:`Round ${round}: I still read the branch as reachable with a non-empty payload, so the defect stands.`}],complete:true},seats.A.participantToken);
      for(const name of ['B','C'])await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:`Round ${round}: the documented behaviour argument is unchanged and the evidence still does not show a defect.`}],complete:true},seats[name].participantToken);
      if((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase!=='issue_discussing')break;
    }
    const closed=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data;
    expect(closed).toMatchObject({phase:'finished',status:'finished'});
    expect((await call('GET',`/api/v1/collab/escalations?sessionId=${session.sessionId}&status=pending`)).data).toHaveLength(0);
    const issue=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/issues`)).data.find((entry:any)=>entry.issueId===issueId);
    expect(issue.status).toBe('wontfix');
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}/events?limit=500`)).data.some((event:any)=>event.type==='issue_panel_ruled'&&event.payload.disposition==='panel_rejected')).toBe(true);
  });

  it('lets the reporter withdraw a finding inside the same call that defends the rest',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Withdrawal',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const a=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'A',agentId:'agent-A'})).data;
    const b=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'B',agentId:'agent-B'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data.baseline.baselineId;
    const filed=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,
      findings:[finding('A finding the reporter later drops',18),finding('A finding the reporter keeps defending',24)],reviewComplete:true},a.participantToken)).data.accepted;
    const [dropped,kept]=filed.map((entry:any)=>entry.issueId);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},b.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},a.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[dropped,kept].map(issueId=>({issueId,stance:'reject',rationale:'Neither finding demonstrates a defect against the code as it stands on this baseline.'})),complete:true},b.participantToken);
    const defending=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data;
    expect(defending.task).toBe('defend_approved_issues');
    expect(defending.consensus.find((entry:any)=>entry.issueId===dropped).panelRejected).toBe(true);
    const submitted=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),
      withdrawals:[{issueId:dropped,rationale:'The reviewer is right: the guard above already rejects that input, so my evidence was wrong.'}],
      discussions:[{issueId:kept,argument:'The second finding still reproduces on this baseline, and the guard does not cover this path.'}],complete:true},a.participantToken);
    expect(submitted.status).toBe(200);
    expect(submitted.data).toMatchObject({withdrawn:[dropped],accepted:[kept]});
    const issues=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/issues`)).data;
    expect(issues.find((entry:any)=>entry.issueId===dropped).status).toBe('withdrawn');
    // The withdrawal must not be a private note: it is the reason the panel stops arguing about that finding.
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}/issues/${dropped}`)).data.history.some((message:any)=>message.payload.withdrawn)).toBe(true);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('issue_reconsidering');
  });

  it('treats a finding the reporter already withdrew standalone as a no-op inside the batch',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Repeated withdrawal',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const a=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'A',agentId:'agent-A'})).data;
    const b=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'B',agentId:'agent-B'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data.baseline.baselineId;
    const filed=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,
      findings:[finding('A finding withdrawn twice by its reporter',42),finding('A finding the reporter keeps defending',48)],reviewComplete:true},a.participantToken)).data.accepted;
    const [dropped,kept]=filed.map((entry:any)=>entry.issueId);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},b.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},a.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[dropped,kept].map(issueId=>({issueId,stance:'reject',rationale:'Neither finding demonstrates a defect against the code as it stands on this baseline.'})),complete:true},b.participantToken);
    // collab_withdraw_issue does not end the turn, so the model withdraws standalone and then repeats the id in
    // the submission that closes the turn. That must not throw away the argument for the finding it still keeps.
    const standalone=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issues/${dropped}/withdraw`,{},a.participantToken);
    expect(standalone.status).toBe(200);
    const submitted=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),
      withdrawals:[{issueId:dropped,rationale:'Already withdrawn a moment ago: the guard above rejects that input, so my evidence was wrong.'}],
      discussions:[{issueId:kept,argument:'The second finding still reproduces on this baseline, and the guard does not cover this path.'}],complete:true},a.participantToken);
    expect(submitted.status).toBe(200);
    expect(submitted.data).toMatchObject({accepted:[kept],withdrawn:[],alreadyWithdrawn:[dropped]});
    const issues=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/issues`)).data;
    expect(issues.find((entry:any)=>entry.issueId===dropped).status).toBe('withdrawn');
  });

  it('drops a finding that went stale between the wake-up and the ballot instead of failing the batch',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Stale ballot',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const seats:Record<string,any>={};
    for(const name of ['A','B','C'])seats[name]=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:name,agentId:`agent-${name}`})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.A.participantToken)).data.baseline.baselineId;
    const filed=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,
      findings:[finding('A finding the panel freezes on',61),finding('A finding still being argued',67)],reviewComplete:true},seats.A.participantToken)).data.accepted;
    const [frozen,moving]=filed.map((entry:any)=>entry.issueId);
    for(const name of ['B','C'])await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},seats[name].participantToken);
    const reject=async(name:string,issueIds:string[],round:number)=>call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),
      votes:issueIds.map(issueId=>({issueId,stance:'reject',rationale:`Round ${round}: the documented behaviour argument is unchanged and the evidence still shows no defect.`})),complete:true},seats[name].participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},seats.A.participantToken);
    for(const name of ['B','C'])await reject(name,[frozen,moving],0);
    const argue=async(round:number)=>call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),
      discussions:[frozen,moving].map(issueId=>({issueId,argument:`Round ${round}: the branch is still reachable with a non-empty payload, so the defect stands.`})),complete:true},seats.A.participantToken);
    await argue(1);
    for(const name of ['B','C'])await reject(name,[frozen,moving],1);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('issue_discussing');
    await argue(2);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('issue_reconsidering');
    // C is woken with both findings owed. B votes on the frozen one first, which freezes its ballot for a third
    // identical round: it leaves the votable set underneath C, whose call is already on the way with both ids.
    const owed=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.C.participantToken)).data.yourRequiredIssueIds;
    expect([...owed].sort()).toEqual([frozen,moving].sort());
    await reject('B',[frozen],2);
    const late=await reject('C',[frozen,moving],2);
    expect(late.status).toBe(200);
    expect(late.data).toMatchObject({accepted:[moving],dropped:[frozen]});
  });

  it('rejects a withdrawal of somebody else\'s finding',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Withdrawal guard',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const a=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'A',agentId:'agent-A'})).data;
    const b=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'B',agentId:'agent-B'})).data;
    const c=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'C',agentId:'agent-C'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('A finding only its reporter may withdraw',33)],reviewComplete:true},a.participantToken)).data.accepted[0].issueId;
    for(const seat of [b,c])await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},seat.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},a.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'approve'}],complete:true},b.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:'The described behaviour is the documented contract of this helper, so it is not a defect.'}],complete:true},c.participantToken);
    const stolen=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),
      withdrawals:[{issueId,rationale:'I am not the reporter of this finding but I would like it gone.'}],complete:true},b.participantToken);
    expect(stolen.status).toBe(422);
    expect(JSON.stringify(stolen.error)).toContain('Only the reporter');
  });

  it('accepts the ballot a reviewer was shown and calls it back for findings that arrived later',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Late findings',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true}})).data;
    const seats:Record<string,any>={};
    for(const name of ['A','B','C'])seats[name]=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:name,agentId:`agent-${name}`})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.A.participantToken)).data.baseline.baselineId;
    const file=async(name:string,findings:any[])=>(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings,reviewComplete:true},seats[name].participantToken)).data.accepted.map((entry:any)=>entry.issueId);
    await file('A',[]);
    const [early]=await file('B',[finding('The finding A was shown while C was still reading',10)]);
    // A collects a task listing exactly one finding; C then files two more before A gets to submit.
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.A.participantToken)).data.yourRequiredIssueIds).toEqual([early]);
    const late=await file('C',[finding('A finding that landed after A had read the code',20),finding('Another finding that landed late',30)]);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('validating');
    const partial=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:early,stance:'approve'}],complete:true},seats.A.participantToken);
    expect(partial.status).toBe(200);
    expect(partial.data).toMatchObject({accepted:[early],complete:false});
    expect(partial.data.stillOwed.sort()).toEqual([...late].sort());
    const again=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,seats.A.participantToken)).data;
    expect(again.task).toBe('validate_issues');expect(again.yourRequiredIssueIds.sort()).toEqual([...late].sort());
    const rest=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:late.map((issueId:string)=>({issueId,stance:'approve'})),complete:true},seats.A.participantToken);
    expect(rest.data).toMatchObject({complete:true,stillOwed:[]});
  });

  it('lets any reviewer request human judgment during consensus instead of waiting three rounds',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Early human review',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true,maxConsensusRounds:3}})).data;
    const reporter=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'reporter',agentId:'agent-reporter'})).data;
    const dissenter=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'dissenter',agentId:'agent-dissenter'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'implementer',displayName:'dev',agentId:'agent-dev'});await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,reporter.participantToken)).data.baseline.baselineId;
    const issueId=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('Issue needing early human expertise',55)],reviewComplete:true},reporter.participantToken)).data.accepted[0].issueId;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},dissenter.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},reporter.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:'This requires domain expertise that neither reviewer can establish from the repository evidence.'}],complete:true},dissenter.participantToken);
    const raised=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/escalations`,{clientRequestId:rid(),kind:'issue_dispute',refId:issueId,summary:'A reviewer requests domain expert judgment before spending three unproductive debate rounds.',question:'Does this behavior violate the external protocol contract?',options:['yes','no','investigate'],urgency:'normal'},dissenter.participantToken);
    expect(raised.status).toBe(202);expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('awaiting_human');
  });

  it('lets finished collectors cross-vote while a slower reviewer is still filing',async()=>{
    const {call,workspace}=await boot();
    const session=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Overlap votes',workspaceId:workspace.id,subject:{type:'free',value:'branch'},policy:{consensusReview:true}})).data;
    const a=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'A',agentId:'agent-A'})).data;
    const b=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'B',agentId:'agent-B'})).data;
    const c=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/participants`,{role:'reviewer',displayName:'C',agentId:'agent-C'})).data;
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/advance`,{});
    const baseline=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data.baseline.baselineId;
    const one=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('First collector correctness issue',10)],reviewComplete:true},a.participantToken)).data.accepted[0].issueId;
    const two=(await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[finding('Second collector correctness issue',20)],reviewComplete:true},b.participantToken)).data.accepted[0].issueId;
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data).toMatchObject({phase:'collecting',progress:{waitingOn:[c.participant.participantId],pendingCrossVotes:expect.arrayContaining([a.participant.participantId,b.participant.participantId])}});
    const tooEarly=await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:one,stance:'approve'}],complete:true},c.participantToken);
    expect(tooEarly.status).toBe(409);
    const aDigest=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/digest`,undefined,a.participantToken)).data;
    expect(aDigest.task).toBe('validate_issues');expect(aDigest.yourRequiredIssueIds).toEqual([two]);
    expect((await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:two,stance:'approve'}],complete:true},a.participantToken)).status).toBe(200);
    expect((await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:one,stance:'approve'}],complete:true},b.participantToken)).status).toBe(200);
    const consensus=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}/review-consensus`)).data;
    expect(consensus.issueConsensus.find((entry:any)=>entry.issueId===one).positions.filter((position:any)=>position.stance==='approve')).toHaveLength(2);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('collecting');
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/findings`,{clientRequestId:rid(),baselineId:baseline,findings:[],reviewComplete:true},c.participantToken);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('validating');
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId:one,stance:'approve'},{issueId:two,stance:'approve'}],complete:true},c.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},a.participantToken);
    await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[],complete:true},b.participantToken);
    expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data).toMatchObject({phase:'finished',status:'finished'});
  });
});
