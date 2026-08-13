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
  it('batches issue validation, unanimously votes on duplicate merges, debates rejects, and then responds',async()=>{
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
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.phase).toBe('responding');

    const open=(await call('GET',`/api/v1/collab/sessions/${sessionId}/issues`)).data.filter((issue:any)=>issue.status==='open');
    expect(open).toHaveLength(2);
    await call('POST',`/api/v1/collab/sessions/${sessionId}/responses`,{clientRequestId:rid(),responses:open.map((issue:any)=>({issueId:issue.issueId,responseType:'rejected',rationale:'The implementation owner records the panel decision without making a code change.'}))},implementer.participantToken);
    for(const [name,issueId] of [['A',one],['B',two]] as const)await call('POST',`/api/v1/collab/sessions/${sessionId}/verdicts`,{clientRequestId:rid(),verdicts:[{issueId,verdict:'accept'}]},tokens[name]);
    expect((await call('GET',`/api/v1/collab/sessions/${sessionId}`)).data.status).toBe('finished');
    const consensus=(await call('GET',`/api/v1/collab/sessions/${sessionId}/review-consensus`)).data;
    expect(consensus.discussions).toHaveLength(4);expect(consensus.mergeProposals[0].votes).toHaveLength(5);
  });

  it('escalates an issue vote that remains rejected after the configured discussion rounds',async()=>{
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
    for(let round=1;round<=3;round++){
      await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-discussions`,{clientRequestId:rid(),discussions:[{issueId,argument:`Discussion round ${round}: the expected behavior claim conflicts with the concrete branch condition and reproducible execution evidence.`}],complete:true},a.participantToken);
      expect((await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data.phase).toBe('issue_reconsidering');
      await call('POST',`/api/v1/collab/sessions/${session.sessionId}/issue-votes`,{clientRequestId:rid(),votes:[{issueId,stance:'reject',rationale:`After discussion round ${round}, the branch condition still does not demonstrate user-visible incorrectness.`}],complete:true},b.participantToken);
      const current=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data;
      if(round<3)expect(current).toMatchObject({phase:'issue_discussing',debateRound:round+1});
      else expect(current.phase).toBe('awaiting_human');
    }
    const stalled=(await call('GET',`/api/v1/collab/sessions/${session.sessionId}`)).data;
    expect(stalled.phase).toBe('awaiting_human');expect(stalled.participants).toBeDefined();
    const escalations=(await call('GET',`/api/v1/collab/escalations?sessionId=${session.sessionId}&status=pending`)).data;
    expect(escalations).toHaveLength(1);expect(escalations[0]).toMatchObject({kind:'issue_dispute',refId:issueId});expect(escalations[0].summary).toContain('after 3 discussion round(s)');expect(escalations[0].positions.some((position:any)=>position.stance==='discussion round 3')).toBe(true);
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
});
