import {describe,it,expect} from 'vitest';
import {DEFAULT_POLICY,type CollabPolicy,type IssueStatus} from '../src/collab/types.js';
import {applyEscalation,applyHumanRuling,applyResponse,applyVerdict,applyWithdraw,assertCanFileFinding,canSeeOthersFindings,isReadyToAdvance,nextPhase,requiredActors,sessionProgress,stallCheck,waitingOn,type FlowIssue,type FlowParticipant,type ReviewSnapshot} from '../src/collab/review-flow.js';

const reviewer=(id:string):FlowParticipant=>({participantId:id,role:'reviewer',state:'active'});
const implementer=(id='impl'):FlowParticipant=>({participantId:id,role:'implementer',state:'active'});
const issue=(patch:Partial<FlowIssue>={}):FlowIssue=>({issueId:'i-1',reporterId:'r1',targetParticipantId:'impl',status:'open',round:1,...patch});
const snapshot=(patch:Partial<ReviewSnapshot>={}):ReviewSnapshot=>({
  phase:'collecting',round:1,policy:DEFAULT_POLICY,status:'active',
  participants:[reviewer('r1'),reviewer('r2'),implementer()],issues:[],completions:[],pendingEscalations:0,...patch
});
const policy=(patch:Partial<CollabPolicy>):CollabPolicy=>({...DEFAULT_POLICY,...patch});

describe('review flow: who blocks a phase',()=>{
  it('waits for reviewers only while findings are collected',()=>{
    const state=snapshot();
    expect(requiredActors(state)).toEqual(['r1','r2']);
    expect(waitingOn(state)).toEqual(['r1','r2']);
    expect(isReadyToAdvance(state)).toBe(false);
    const partial={...state,completions:[{phase:'collecting' as const,round:1,participantId:'r1'}]};
    expect(waitingOn(partial)).toEqual(['r2']);
    const complete={...state,completions:[{phase:'collecting' as const,round:1,participantId:'r1'},{phase:'collecting' as const,round:1,participantId:'r2'}]};
    expect(isReadyToAdvance(complete)).toBe(true);
  });

  it('ignores completions recorded for an earlier round',()=>{
    const state=snapshot({round:2,completions:[{phase:'collecting',round:1,participantId:'r1'},{phase:'collecting',round:1,participantId:'r2'}]});
    expect(waitingOn(state)).toEqual(['r1','r2']);
  });

  it('waits for the addressed participants while responses are due, including a reviewer under reverse review',()=>{
    const state=snapshot({phase:'responding',issues:[issue(),issue({issueId:'i-2',reporterId:'impl',targetParticipantId:'r2'}),issue({issueId:'i-3',status:'resolved'})]});
    expect(waitingOn(state)).toEqual(['impl','r2']);
  });

  it('waits for reporters while verdicts are due',()=>{
    const state=snapshot({phase:'adjudicating',issues:[issue({status:'answered'}),issue({issueId:'i-2',reporterId:'r2',status:'answered'}),issue({issueId:'i-3',reporterId:'r1',status:'open'})]});
    expect(waitingOn(state)).toEqual(['r1','r2']);
  });

  it('keeps blocking on a participant that left or ran out of budget, because only a human may skip it',()=>{
    const state=snapshot({phase:'responding',participants:[reviewer('r1'),{participantId:'impl',role:'implementer',state:'budget_exhausted'}],issues:[issue()]});
    expect(waitingOn(state)).toEqual(['impl']);
    expect(isReadyToAdvance(state)).toBe(false);
  });
});

describe('review flow: phase transitions',()=>{
  const ready=(patch:Partial<ReviewSnapshot>={})=>snapshot({completions:[{phase:'collecting',round:1,participantId:'r1'},{phase:'collecting',round:1,participantId:'r2'}],...patch});

  it('walks draft to adjudication in order',()=>{
    expect(nextPhase(snapshot({phase:'draft'}),{forced:true})).toMatchObject({phase:'collecting',round:1,reason:'round_opened'});
    expect(nextPhase(ready())).toMatchObject({phase:'consolidating',reason:'findings_complete'});
    expect(nextPhase(snapshot({phase:'consolidating'}))).toMatchObject({phase:'responding',reason:'digest_ready'});
    expect(nextPhase(snapshot({phase:'responding'}))).toMatchObject({phase:'adjudicating',reason:'responses_complete'});
  });

  it('finishes only when nothing is left open',()=>{
    expect(nextPhase(snapshot({phase:'adjudicating',issues:[issue({status:'resolved'}),issue({issueId:'i-2',status:'withdrawn'})]}))).toMatchObject({phase:'finished',reason:'all_issues_closed'});
  });

  it('opens the next round when issues were reopened',()=>{
    expect(nextPhase(snapshot({phase:'adjudicating',issues:[issue({status:'open',round:2})]}))).toMatchObject({phase:'collecting',round:2,reason:'next_round'});
  });

  it('hands a session that hit the total round cap to a human instead of forcing a conclusion',()=>{
    const state=snapshot({phase:'adjudicating',round:6,issues:[issue({status:'open',round:2})],policy:policy({maxTotalRounds:6})});
    expect(nextPhase(state)).toMatchObject({phase:'awaiting_human',reason:'max_total_rounds_reached',escalateDeadlock:true});
  });

  it('parks on pending escalations and resumes adjudication after the ruling',()=>{
    const parked=snapshot({phase:'adjudicating',issues:[issue({status:'escalated'})],pendingEscalations:1});
    expect(nextPhase(parked)).toMatchObject({phase:'awaiting_human',reason:'escalations_pending'});
    const waiting=snapshot({phase:'awaiting_human',pendingEscalations:1});
    expect(()=>nextPhase(waiting)).toThrow(/await a human ruling/);
    expect(nextPhase({...waiting,pendingEscalations:0})).toMatchObject({phase:'adjudicating',reason:'human_ruled'});
  });

  it('never advances on its own while anyone still owes work',()=>{
    const stalledState=snapshot({phase:'responding',issues:[issue()]});
    expect(()=>nextPhase(stalledState)).toThrow(/Still waiting on 1 participant/);
    expect(isReadyToAdvance(stalledState)).toBe(false);
  });

  it('lets a human force the phase and reports exactly who was skipped',()=>{
    const stalledState=snapshot({phase:'responding',issues:[issue(),issue({issueId:'i-2',targetParticipantId:'r2'})]});
    expect(nextPhase(stalledState,{forced:true})).toMatchObject({phase:'adjudicating',skipped:['impl','r2']});
  });

  it('refuses to advance a session that is no longer active',()=>{
    expect(()=>nextPhase(snapshot({status:'finished'}))).toThrow(/Session is finished/);
    expect(isReadyToAdvance(snapshot({status:'aborted'}))).toBe(false);
  });
});

describe('review flow: stall reporting',()=>{
  it('marks a stall without touching the phase',()=>{
    const state=snapshot({phase:'responding',issues:[issue()],policy:policy({overdueWarningSec:1800})});
    const start=1_000_000;
    expect(stallCheck(state,start,start+1000*1000)).toMatchObject({stalled:false,waitingOn:['impl']});
    const overdue=stallCheck(state,start,start+2000*1000);
    expect(overdue).toMatchObject({stalled:true,waitingOn:['impl']});
    expect(overdue.overdueBySec).toBe(2000);
    expect(state.phase).toBe('responding');
  });

  it('never reports a stall when nobody owes anything',()=>{
    const state=snapshot({phase:'responding',issues:[issue({status:'resolved'})]});
    expect(stallCheck(state,0,Date.now())).toMatchObject({stalled:false,waitingOn:[]});
  });
});

describe('review flow: issue lifecycle',()=>{
  it('answers an open issue without closing it, whatever the response type says',()=>{
    for(const responseType of ['fixed','partially_fixed','rejected','needs_info','deferred'] as const){
      expect(applyResponse({issue:issue(),actor:implementer(),responseType,policy:DEFAULT_POLICY})).toMatchObject({status:'answered'});
    }
  });

  it('refuses a response from anyone but the addressed participant',()=>{
    expect(()=>applyResponse({issue:issue(),actor:reviewer('r2'),responseType:'fixed',policy:DEFAULT_POLICY})).toThrow(/Only the participant an issue is addressed to/);
  });

  it('accepts a reverse-review response from a reviewer',()=>{
    const reverse=issue({issueId:'i-9',reporterId:'impl',targetParticipantId:'r2'});
    expect(applyResponse({issue:reverse,actor:reviewer('r2'),responseType:'rejected',policy:DEFAULT_POLICY})).toMatchObject({status:'answered'});
  });

  it('lets only the reporter rule, and closes on accept',()=>{
    expect(applyVerdict({issue:issue({status:'answered'}),actor:reviewer('r1'),verdict:'accept',policy:DEFAULT_POLICY})).toMatchObject({status:'resolved'});
    expect(()=>applyVerdict({issue:issue({status:'answered'}),actor:implementer(),verdict:'accept',policy:DEFAULT_POLICY})).toThrow(/Only the participant who reported an issue/);
  });

  it('reopens on reject until the per-issue round cap escalates it',()=>{
    const capped=policy({maxIssueRounds:2});
    expect(applyVerdict({issue:issue({status:'answered',round:1}),actor:reviewer('r1'),verdict:'reject',policy:capped})).toMatchObject({status:'open',round:2,escalate:false});
    expect(applyVerdict({issue:issue({status:'answered',round:2}),actor:reviewer('r1'),verdict:'reject',policy:capped}))
      .toMatchObject({status:'escalated',escalate:true,escalateReason:'max_issue_rounds_reached'});
  });

  it('treats needs_info like a reopen so the loop stays bounded',()=>{
    expect(applyVerdict({issue:issue({status:'answered',round:1}),actor:reviewer('r1'),verdict:'needs_info',policy:DEFAULT_POLICY})).toMatchObject({status:'open',round:2});
  });

  it('escalates on request from either side',()=>{
    expect(applyVerdict({issue:issue({status:'answered'}),actor:reviewer('r1'),verdict:'escalate',policy:DEFAULT_POLICY})).toMatchObject({status:'escalated',escalateReason:'reporter_escalated'});
    expect(applyEscalation({issue:issue(),actor:implementer()})).toMatchObject({status:'escalated',escalateReason:'participant_escalated'});
    expect(()=>applyEscalation({issue:issue(),actor:reviewer('r2')})).toThrow(/Only the reporter or the addressed participant/);
  });

  it('rejects a verdict on an issue that was never answered',()=>{
    expect(()=>applyVerdict({issue:issue({status:'open'}),actor:reviewer('r1'),verdict:'accept',policy:DEFAULT_POLICY})).toThrow(/only answered issues accept a verdict/);
    expect(()=>applyResponse({issue:issue({status:'answered'}),actor:implementer(),responseType:'fixed',policy:DEFAULT_POLICY})).toThrow(/only open issues accept a response/);
  });

  it('treats a human ruling as final for everyone',()=>{
    const ruled=issue({status:'human_ruled'});
    expect(()=>applyResponse({issue:ruled,actor:implementer(),responseType:'fixed',policy:DEFAULT_POLICY})).toThrow(/can no longer be changed/);
    expect(()=>applyVerdict({issue:ruled,actor:reviewer('r1'),verdict:'reject',policy:DEFAULT_POLICY})).toThrow(/can no longer be changed/);
    expect(()=>applyEscalation({issue:ruled,actor:implementer()})).toThrow(/can no longer be changed/);
    expect(()=>applyWithdraw({issue:ruled,actor:reviewer('r1')})).toThrow(/can no longer be changed/);
  });

  it('lets a human resolve, decline, or reopen an escalated issue',()=>{
    expect(applyHumanRuling(issue({status:'escalated'}),'resolved')).toMatchObject({status:'human_ruled'});
    expect(applyHumanRuling(issue({status:'escalated'}),'wontfix')).toMatchObject({status:'wontfix'});
    expect(applyHumanRuling(issue({status:'escalated',round:2}),'reopen')).toMatchObject({status:'open',round:3});
  });

  it('lets only the reporter withdraw',()=>{
    expect(applyWithdraw({issue:issue(),actor:reviewer('r1')})).toMatchObject({status:'withdrawn'});
    expect(()=>applyWithdraw({issue:issue(),actor:implementer()})).toThrow(/Only the reporter may withdraw/);
  });
});

describe('review flow: guards',()=>{
  it('allows any role to file findings but only during collection',()=>{
    expect(assertCanFileFinding(snapshot(),'impl').role).toBe('implementer');
    expect(()=>assertCanFileFinding(snapshot({phase:'responding'}),'r1')).toThrow(/only accepted in phase collecting/);
    expect(()=>assertCanFileFinding(snapshot(),'ghost')).toThrow(/not part of this session/);
  });

  it('blocks writes once the budget is exhausted, with a retryable code',()=>{
    const exhausted=snapshot({participants:[{participantId:'r1',role:'reviewer',state:'budget_exhausted'}]});
    expect(()=>assertCanFileFinding(exhausted,'r1')).toThrow(expect.objectContaining({code:'TOKEN_BUDGET_EXHAUSTED',httpStatus:429}));
  });

  it('hides other participants findings until collection closes',()=>{
    expect(canSeeOthersFindings(snapshot())).toBe(false);
    expect(canSeeOthersFindings(snapshot({phase:'consolidating'}))).toBe(true);
    expect(canSeeOthersFindings(snapshot({policy:policy({blindFindings:false})}))).toBe(true);
  });
});

describe('review flow: progress summary',()=>{
  it('summarises the board for humans and dashboards',()=>{
    const issues:FlowIssue[]=[issue({status:'open'}),issue({issueId:'i-2',status:'answered',reporterId:'r2'}),issue({issueId:'i-3',status:'resolved'}),issue({issueId:'i-4',status:'escalated'})];
    const progress=sessionProgress(snapshot({phase:'adjudicating',issues}));
    expect(progress).toMatchObject({phase:'adjudicating',totalIssues:4,openIssues:3,waitingOn:['r2'],readyToAdvance:false});
    expect(progress.byStatus).toEqual({open:1,answered:1,resolved:1,escalated:1} satisfies Partial<Record<IssueStatus,number>>);
  });
});
