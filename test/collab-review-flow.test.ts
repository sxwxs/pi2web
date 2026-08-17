import {describe,it,expect} from 'vitest';
import {DEFAULT_POLICY,type CollabPolicy,type IssueStatus} from '../src/collab/types.js';
import {applyEscalation,applyHumanRuling,applyWithdraw,assertCanFileFinding,canSeeOthersFindings,isReadyToAdvance,nextPhase,pendingCrossVoters,requiredActors,resolveContestedIssues,sessionProgress,stallCheck,staleContestedIssueIds,waitingOn,type FlowIssue,type FlowParticipant,type ReviewSnapshot} from '../src/collab/review-flow.js';

const reviewer=(id:string):FlowParticipant=>({participantId:id,role:'reviewer',state:'active'});
const implementer=(id='impl'):FlowParticipant=>({participantId:id,role:'implementer',state:'active'});
const issue=(patch:Partial<FlowIssue>={}):FlowIssue=>({issueId:'i-1',reporterId:'r1',targetParticipantId:'impl',status:'open',round:1,...patch});
const policy=(patch:Partial<CollabPolicy>):CollabPolicy=>({...DEFAULT_POLICY,...patch});
const snapshot=(patch:Partial<ReviewSnapshot>={}):ReviewSnapshot=>({
  phase:'collecting',round:1,policy:DEFAULT_POLICY,status:'active',participants:[reviewer('r1'),reviewer('r2'),implementer()],
  issues:[],completions:[],pendingEscalations:0,...patch
});

describe('review flow without a response phase',()=>{
  it('asks finished collectors to cross-vote without waiting for the last reviewer',()=>{
    const state=snapshot({policy:policy({consensusReview:true}),issues:[issue(),issue({issueId:'i-2',reporterId:'r2'})],
      completions:[{phase:'collecting',round:1,participantId:'r1'}]});
    expect(waitingOn(state)).toEqual(['r2']);
    expect(pendingCrossVoters(state)).toEqual(['r1']);
    expect(sessionProgress(state).pendingCrossVotes).toEqual(['r1']);
    const bothFiled={...state,completions:[{phase:'collecting' as const,round:1,participantId:'r1'},{phase:'collecting' as const,round:1,participantId:'r2'}]};
    expect(pendingCrossVoters(bothFiled).sort()).toEqual(['r1','r2']);
  });

  it('waits for reviewers, not implementers, during blind collection',()=>{
    const state=snapshot();
    expect(requiredActors(state)).toEqual(['r1','r2']);
    expect(waitingOn(state)).toEqual(['r1','r2']);
    const complete={...state,completions:[{phase:'collecting' as const,round:1,participantId:'r1'},{phase:'collecting' as const,round:1,participantId:'r2'}]};
    expect(isReadyToAdvance(complete)).toBe(true);
  });

  it('goes directly from consolidation to finished when consensus is disabled',()=>{
    expect(nextPhase(snapshot({phase:'draft'}),{forced:true})).toMatchObject({phase:'collecting',reason:'round_opened'});
    expect(nextPhase(snapshot({phase:'consolidating'}))).toMatchObject({phase:'finished',reason:'review_complete'});
  });

  it('finishes a consensus review after every reviewer validates this round findings',()=>{
    const state=snapshot({phase:'consolidating',policy:policy({consensusReview:true}),issues:[issue()],
      completions:[{phase:'validating',round:1,participantId:'r1'},{phase:'validating',round:1,participantId:'r2'}],
      issueVotes:[{voteId:'v',sessionId:'s',issueId:'i-1',participantId:'r2',round:1,consensusRound:0,stance:'approve',createdAt:'2026-01-01'}]});
    expect(nextPhase(state)).toMatchObject({phase:'finished',reason:'review_consensus_complete'});
  });

  it('validates only new findings from the current recheck round',()=>{
    const old=issue({issueId:'old',status:'confirmed',round:1}),fresh=issue({issueId:'fresh',round:2});
    const state=snapshot({phase:'validating',round:2,policy:policy({consensusReview:true}),issues:[old,fresh]});
    expect(requiredActors(state)).toEqual(['r1','r2']);
  });

  it('uses discussion and reconsideration only for a contested current finding',()=>{
    const state=snapshot({phase:'issue_reconsidering',policy:policy({consensusReview:true,maxConsensusRounds:2}),issues:[issue()],debateRound:1,
      issueVotes:[{voteId:'v',sessionId:'s',issueId:'i-1',participantId:'r2',round:1,consensusRound:1,stance:'reject',createdAt:'2026-01-01'}],
      completions:[{phase:'issue_reconsidering',round:1,participantId:'r2'}]});
    expect(nextPhase(state)).toMatchObject({phase:'issue_discussing',debateRound:2});
  });

  it('returns unresolved panel disagreement to a human',()=>{
    const state=snapshot({phase:'issue_reconsidering',policy:policy({consensusReview:true,maxConsensusRounds:1}),issues:[issue()],debateRound:1,
      issueVotes:[{voteId:'v',sessionId:'s',issueId:'i-1',participantId:'r2',round:1,consensusRound:1,stance:'reject',createdAt:'2026-01-01'}],
      completions:[{phase:'issue_reconsidering',round:1,participantId:'r2'}]});
    expect(nextPhase(state)).toMatchObject({phase:'awaiting_human',escalateConsensus:true});
  });

  it('resumes consensus consolidation after all human rulings',()=>{
    const waiting=snapshot({phase:'awaiting_human',pendingEscalations:1});
    expect(()=>nextPhase(waiting)).toThrow(/await a human ruling/);
    expect(nextPhase({...waiting,pendingEscalations:0})).toMatchObject({phase:'consolidating',reason:'consensus_human_ruled'});
  });

  it('recovers legacy persisted response phases by finishing instead of dispatching another response',()=>{
    expect(nextPhase(snapshot({phase:'responding'}))).toMatchObject({phase:'finished',reason:'legacy_response_loop_removed'});
    expect(nextPhase(snapshot({phase:'adjudicating'}))).toMatchObject({phase:'finished',reason:'legacy_response_loop_removed'});
  });
});

describe('review flow guards and stalls',()=>{
  it('marks a collection stall without changing the phase',()=>{
    const state=snapshot({policy:policy({overdueWarningSec:1800})}),start=1_000_000;
    expect(stallCheck(state,start,start+2000*1000)).toMatchObject({stalled:true,waitingOn:['r1','r2']});
    expect(state.phase).toBe('collecting');
  });

  it('allows findings only during collection and preserves blind visibility',()=>{
    expect(assertCanFileFinding(snapshot(),'impl').role).toBe('implementer');
    expect(()=>assertCanFileFinding(snapshot({phase:'finished'}),'r1')).toThrow(/only accepted in phase collecting/);
    expect(canSeeOthersFindings(snapshot())).toBe(false);
    expect(canSeeOthersFindings(snapshot({phase:'consolidating'}))).toBe(true);
  });

  it('blocks exhausted participants from writing',()=>{
    const state=snapshot({participants:[{participantId:'r1',role:'reviewer',state:'budget_exhausted'}]});
    expect(()=>assertCanFileFinding(state,'r1')).toThrow(expect.objectContaining({code:'TOKEN_BUDGET_EXHAUSTED'}));
  });

  it('reports confirmed findings as non-blocking review output',()=>{
    const issues:FlowIssue[]=[issue({status:'confirmed'}),issue({issueId:'i-2',status:'resolved'})];
    const progress=sessionProgress(snapshot({phase:'finished',status:'finished',issues}));
    expect(progress).toMatchObject({totalIssues:2,openIssues:0,waitingOn:[],readyToAdvance:false});
    expect(progress.byStatus).toEqual({confirmed:1,resolved:1} satisfies Partial<Record<IssueStatus,number>>);
  });
});

describe('issue consensus mutation helpers',()=>{
  it('keeps human rulings final and withdrawals reporter-owned',()=>{
    const ruled=issue({status:'human_ruled'});
    expect(()=>applyEscalation({issue:ruled,actor:implementer()})).toThrow(/can no longer be changed/);
    expect(applyHumanRuling(issue({status:'escalated'}),'resolved')).toMatchObject({status:'human_ruled'});
    expect(applyWithdraw({issue:issue(),actor:reviewer('r1')})).toMatchObject({status:'withdrawn'});
    expect(()=>applyWithdraw({issue:issue(),actor:implementer()})).toThrow(/Only the reporter/);
  });
});

describe('contested issue resolution',()=>{
  const panel=[reviewer('r1'),reviewer('r2'),reviewer('r3')];
  const vote=(participantId:string,stance:'approve'|'reject',consensusRound:number)=>
    ({voteId:`v-${participantId}-${consensusRound}`,sessionId:'s',issueId:'i-1',participantId,round:1,consensusRound,stance,createdAt:`2026-01-0${consensusRound+1}`});
  const contested=(patch:Partial<ReviewSnapshot>={},severity:FlowIssue['severity']='major')=>snapshot({
    phase:'issue_reconsidering',policy:policy({consensusReview:true,maxConsensusRounds:4}),participants:panel,
    issues:[issue({severity})],debateRound:1,...patch});

  it('drops a finding the rest of the panel rejected instead of escalating it',()=>{
    const state=contested({issueVotes:[vote('r2','reject',0),vote('r3','reject',0)]});
    expect(resolveContestedIssues(state)).toMatchObject([{disposition:'panel_rejected',reason:'panel_unanimously_rejected'}]);
  });

  it('still asks a human about a blocker the panel talked itself out of',()=>{
    const state=contested({issueVotes:[vote('r2','reject',0),vote('r3','reject',0)]},'blocker');
    expect(resolveContestedIssues(state)).toMatchObject([{disposition:'escalate'}]);
  });

  it('treats a two-seat panel as a tie rather than a verdict',()=>{
    const state=contested({participants:[reviewer('r1'),reviewer('r2')],issueVotes:[vote('r2','reject',0)]});
    expect(resolveContestedIssues(state)).toMatchObject([{disposition:'escalate',reason:'split_panel_on_a_major_finding'}]);
  });

  it('settles a split panel on a small finding by majority instead of by escalation',()=>{
    const split=[vote('r2','reject',0),vote('r3','approve',0)];
    expect(resolveContestedIssues(contested({issueVotes:split},'minor'))).toMatchObject([{disposition:'majority_confirmed'}]);
    expect(resolveContestedIssues(contested({issueVotes:[vote('r2','reject',0),vote('r3','reject',0)]},'nit'))).toMatchObject([{disposition:'panel_rejected'}]);
  });

  it('stops debating a ballot that has not moved for two rounds',()=>{
    const unmoved=[vote('r2','reject',0),vote('r3','approve',0),vote('r2','reject',1),vote('r2','reject',2)];
    const state=contested({debateRound:2,issueVotes:unmoved,completions:[{phase:'issue_reconsidering',round:1,participantId:'r2'}]});
    expect(staleContestedIssueIds(state)).toEqual(['i-1']);
    // maxConsensusRounds is 4, but rounds 3 and 4 would only re-ask a question nobody is answering.
    expect(nextPhase(state)).toMatchObject({phase:'awaiting_human',reason:'issue_consensus_settled_with_disputes'});
  });

  it('keeps debating while somebody is still changing their mind',()=>{
    const moving=[vote('r2','reject',0),vote('r3','approve',0),vote('r2','reject',1),vote('r2','approve',2)];
    const state=contested({debateRound:2,issueVotes:moving,completions:[{phase:'issue_reconsidering',round:1,participantId:'r2'}]});
    expect(staleContestedIssueIds(state)).toEqual([]);
    expect(nextPhase(state)).toMatchObject({phase:'finished',reason:'review_consensus_complete'});
  });
});
