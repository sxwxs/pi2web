import {describe,it,expect} from 'vitest';
import {DEFAULT_POLICY,type CollabPolicy} from '../src/collab/types.js';
import type {FlowParticipant} from '../src/collab/review-flow.js';
import {analyse,contestedCriteria,finalizeScores,isScoringReadyToAdvance,lockRubric,nextScoringPhase,nominationsSealed,normalizeWeights,scoresSealed,scoringPanel,scoringProgress,scoringWaitingOn,tallyVotes,votesSealed,type FlowCriterion,type FlowScore,type FlowVote,type ScoringSnapshot} from '../src/collab/scoring-flow.js';

const reviewer=(id:string):FlowParticipant=>({participantId:id,role:'reviewer',state:'active'});
const policy=(patch:Partial<CollabPolicy['scoring']>={}):CollabPolicy=>({...DEFAULT_POLICY,scoring:{...DEFAULT_POLICY.scoring,...patch}});
const criterion=(id:string,state:FlowCriterion['state']='candidate',weight?:number):FlowCriterion=>({criterionId:id,state,name:`criterion ${id}`,round:1,weight});
const snapshot=(patch:Partial<ScoringSnapshot>={}):ScoringSnapshot=>({
  phase:'nominating',round:1,debateRound:0,policy:DEFAULT_POLICY,status:'active',
  participants:[reviewer('r1'),reviewer('r2'),reviewer('r3'),{participantId:'impl',role:'implementer',state:'active'}],
  criteria:[],votes:[],scores:[],debates:[],completions:[],pendingEscalations:0,...patch
});
const votes=(criterionId:string,stances:Record<string,FlowVote['stance']>,weight?:number,round=1):FlowVote[]=>
  Object.entries(stances).map(([participantId,stance])=>({criterionId,participantId,round,stance,weight}));
const scores=(criterionId:string,values:Record<string,number>,round=0):FlowScore[]=>
  Object.entries(values).map(([participantId,score])=>({criterionId,participantId,round,score}));

describe('scoring flow: panel and blocking',()=>{
  it('recuses the implementer from the panel',()=>{
    expect(scoringPanel(snapshot()).map(participant=>participant.participantId)).toEqual(['r1','r2','r3']);
  });

  it('waits for every reviewer to finish nominating',()=>{
    const state=snapshot({completions:[{phase:'nominating',round:1,participantId:'r1'}]});
    expect(scoringWaitingOn(state)).toEqual(['r2','r3']);
    expect(isScoringReadyToAdvance(state)).toBe(false);
  });

  it('waits until every reviewer voted on every candidate',()=>{
    const state=snapshot({phase:'voting',criteria:[criterion('c1'),criterion('c2')],
      votes:[...votes('c1',{r1:'approve',r2:'approve',r3:'reject'}),...votes('c2',{r1:'approve',r2:'approve'})]});
    expect(scoringWaitingOn(state)).toEqual(['r3']);
  });

  it('waits until every reviewer scored every approved criterion',()=>{
    const state=snapshot({phase:'scoring',criteria:[criterion('c1','approved'),criterion('c2','approved')],
      scores:[...scores('c1',{r1:6,r2:7,r3:6}),...scores('c2',{r1:8,r2:8})]});
    expect(scoringWaitingOn(state)).toEqual(['r3']);
  });

  it('requires everyone who scored a contested criterion to speak in its debate',()=>{
    const state=snapshot({phase:'debating',criteria:[criterion('c1','approved')],scores:scores('c1',{r1:2,r2:9,r3:5}),
      debates:[{debateId:'d1',criterionId:'c1',round:0,status:'open',arguments:[{participantId:'r1'}]}]});
    expect(scoringWaitingOn(state)).toEqual(['r2','r3']);
  });

  it('requires a fresh score from everyone after a debate',()=>{
    const state=snapshot({phase:'rescoring',debateRound:0,criteria:[criterion('c1','approved')],
      debates:[{debateId:'d1',criterionId:'c1',round:0,status:'closed',arguments:[]}],
      scores:[...scores('c1',{r1:2,r2:9,r3:5},0),...scores('c1',{r1:5,r2:6},1)]});
    expect(scoringWaitingOn(state)).toEqual(['r3']);
  });
});

describe('scoring flow: rubric negotiation',()=>{
  it('needs both the approval ratio and a second supporter, so one reviewer cannot impose a criterion',()=>{
    const state=snapshot({phase:'voting',criteria:[criterion('c1'),criterion('c2')],
      votes:[...votes('c1',{r1:'approve',r2:'approve',r3:'reject'}),...votes('c2',{r1:'approve',r2:'abstain',r3:'abstain'})]});
    const tallies=tallyVotes(state);
    expect(tallies.find(tally=>tally.criterionId==='c1')).toMatchObject({approve:2,reject:1,ratio:0.67,approved:true});
    expect(tallies.find(tally=>tally.criterionId==='c2')).toMatchObject({approve:1,ratio:1,approved:false});
  });

  it('locks the rubric with median weights normalised to one',()=>{
    const configured=policy({minCriteria:2,maxCriteria:4});
    const state=snapshot({phase:'voting',policy:configured,criteria:[criterion('c1'),criterion('c2')],
      votes:[...votes('c1',{r1:'approve',r2:'approve',r3:'approve'},0.3),...votes('c2',{r1:'approve',r2:'approve',r3:'approve'},0.1)]});
    const rubric=lockRubric(state)!;
    expect(rubric.lockedBy).toBe('panel');
    expect(rubric.criteria).toEqual([{criterionId:'c1',weight:0.75},{criterionId:'c2',weight:0.25}]);
    expect(normalizeWeights([{criterionId:'a',weight:1},{criterionId:'b',weight:1}])).toEqual([{criterionId:'a',weight:0.5},{criterionId:'b',weight:0.5}]);
  });

  it('runs another nomination round when too few criteria pass',()=>{
    const configured=policy({minCriteria:3,maxVotingRounds:3});
    const state=snapshot({phase:'voting',policy:configured,criteria:[criterion('c1')],votes:votes('c1',{r1:'approve',r2:'approve',r3:'approve'})});
    expect(lockRubric(state)).toBeUndefined();
    expect(nextScoringPhase(state)).toMatchObject({phase:'nominating',round:2,reason:'not_enough_approved_criteria'});
  });

  it('runs another voting round when too many criteria pass',()=>{
    const configured=policy({minCriteria:1,maxCriteria:1,maxVotingRounds:3});
    const state=snapshot({phase:'voting',policy:configured,criteria:[criterion('c1'),criterion('c2')],
      votes:[...votes('c1',{r1:'approve',r2:'approve',r3:'approve'}),...votes('c2',{r1:'approve',r2:'approve',r3:'approve'})]});
    expect(nextScoringPhase(state)).toMatchObject({phase:'voting',round:2,reason:'too_many_approved_criteria'});
  });

  it('falls back to the highest approval on the last round and records that policy decided it',()=>{
    const configured=policy({minCriteria:3,maxCriteria:2,maxVotingRounds:1});
    const state=snapshot({phase:'voting',policy:configured,round:1,criteria:[criterion('c1'),criterion('c2'),criterion('c3')],
      votes:[...votes('c1',{r1:'approve',r2:'approve',r3:'approve'}),...votes('c2',{r1:'approve',r2:'approve',r3:'reject'}),...votes('c3',{r1:'reject',r2:'reject',r3:'reject'})]});
    const rubric=lockRubric(state)!;
    expect(rubric.lockedBy).toBe('policy');
    expect(rubric.criteria.map(entry=>entry.criterionId)).toEqual(['c1','c2']);
    expect(rubric.rejected).toContain('c3');
    expect(nextScoringPhase(state)).toMatchObject({phase:'rubric_locked',reason:'rubric_forced_by_policy'});
  });
});

describe('scoring flow: convergence and debate',()=>{
  const rubric=[criterion('c1','approved',0.5),criterion('c2','approved',0.5)];

  it('measures the spread and only flags a criterion once it exceeds the configured range',()=>{
    const state=snapshot({phase:'analysis',criteria:rubric,policy:policy({convergenceRange:2}),
      scores:[...scores('c1',{r1:6,r2:7,r3:6.5}),...scores('c2',{r1:2,r2:9,r3:5})]});
    const analysis=analyse(state);
    expect(analysis.find(entry=>entry.criterionId==='c1')).toMatchObject({min:6,max:7,median:6.5,range:1,contested:false});
    expect(analysis.find(entry=>entry.criterionId==='c2')).toMatchObject({range:7,contested:true});
    expect(contestedCriteria(state).map(entry=>entry.criterionId)).toEqual(['c2']);
  });

  it('opens a debate for contested criteria and converges after rescoring',()=>{
    const panel=[reviewer('r1'),reviewer('r2')];
    const contested=snapshot({phase:'analysis',participants:panel,criteria:rubric,scores:[...scores('c1',{r1:6,r2:6}),...scores('c2',{r1:2,r2:9})]});
    expect(nextScoringPhase(contested)).toMatchObject({phase:'debating',reason:'contested_criteria',contested:['c2']});
    const debated=snapshot({phase:'debating',participants:panel,criteria:rubric,scores:contested.scores,
      debates:[{debateId:'d1',criterionId:'c2',round:0,status:'open',arguments:[{participantId:'r1'},{participantId:'r2'}]}]});
    expect(nextScoringPhase(debated)).toMatchObject({phase:'rescoring'});
    const rescored=snapshot({phase:'rescoring',participants:panel,criteria:rubric,debateRound:0,
      debates:[{debateId:'d1',criterionId:'c2',round:0,status:'closed',arguments:[]}],
      scores:[...contested.scores,...scores('c2',{r1:5,r2:6},1),...scores('c1',{r1:6,r2:6},1)]});
    expect(nextScoringPhase(rescored)).toMatchObject({phase:'analysis',debateRound:1,reason:'rescored'});
    const converged={...rescored,phase:'analysis' as const,debateRound:1};
    expect(nextScoringPhase(converged)).toMatchObject({phase:'finalized',reason:'scores_converged'});
  });

  it('hands persistent disagreement to a human instead of averaging it away',()=>{
    const state=snapshot({phase:'analysis',participants:[reviewer('r1'),reviewer('r2')],criteria:rubric,debateRound:2,policy:policy({maxDebateRounds:2}),
      scores:[...scores('c1',{r1:6,r2:6},2),...scores('c2',{r1:1,r2:10},2)]});
    expect(nextScoringPhase(state)).toMatchObject({phase:'awaiting_human',reason:'scores_still_contested',contested:['c2']});
    const waiting=snapshot({phase:'awaiting_human',pendingEscalations:1});
    expect(()=>nextScoringPhase(waiting)).toThrow(/await a human ruling/);
    expect(nextScoringPhase({...waiting,pendingEscalations:0})).toMatchObject({phase:'finalized',reason:'human_ruled'});
  });

  it('never advances on its own while a panelist owes a score, but a human can force it',()=>{
    const state=snapshot({phase:'scoring',criteria:rubric,scores:scores('c1',{r1:6})});
    expect(()=>nextScoringPhase(state)).toThrow(/Still waiting on/);
    expect(nextScoringPhase(state,{forced:true})).toMatchObject({phase:'analysis',skipped:['r1','r2','r3']});
  });

  it('refuses to walk a panel-less session through the rounds',()=>{
    // With nobody to wait for, every "everyone submitted" check is vacuously true; that used to let /advance
    // cycle nomination -> voting -> rubric with an empty panel.
    const empty=snapshot({participants:[{participantId:'impl',role:'implementer',state:'active'}]});
    expect(isScoringReadyToAdvance(empty)).toBe(false);
    expect(()=>nextScoringPhase(empty)).toThrow(/no reviewer on the panel/);
    expect(nextScoringPhase(empty,{forced:true})).toMatchObject({phase:'consolidating'});
  });

  it('parks the panel while any escalation still awaits a human, not only in awaiting_human',()=>{
    // A budget escalation raised by the last score submission must not be overtaken by finalization.
    const state=snapshot({phase:'analysis',criteria:rubric,scores:[...scores('c1',{r1:6,r2:6,r3:6}),...scores('c2',{r1:6,r2:6,r3:6})],pendingEscalations:1});
    expect(isScoringReadyToAdvance(state)).toBe(false);
    expect(()=>nextScoringPhase(state)).toThrow(/await a human ruling/);
    expect(isScoringReadyToAdvance({...state,pendingEscalations:0})).toBe(true);
  });
});

describe('scoring flow: final report',()=>{
  const rubric=[criterion('c1','approved',0.7),criterion('c2','approved',0.3)];

  it('weights the median score per criterion and keeps dissent visible',()=>{
    const state=snapshot({phase:'analysis',criteria:rubric,scores:[...scores('c1',{r1:8,r2:8,r3:9}),...scores('c2',{r1:3,r2:6,r3:5})]});
    const report=finalizeScores(state);
    expect(report.criteria.find(entry=>entry.criterionId==='c1')).toMatchObject({finalScore:8,weight:0.7,method:'converged'});
    expect(report.totalScore).toBe(round2(8*0.7+5*0.3));
    expect(report.agreement).toBe(0.8);
    expect(report.dissents.some(entry=>entry.participantId==='r1'&&entry.criterionId==='c2')).toBe(true);
  });

  it('lets a human ruling override the measurement and marks it as such',()=>{
    const state=snapshot({phase:'awaiting_human',participants:[reviewer('r1'),reviewer('r2')],criteria:rubric,debateRound:1,scores:[...scores('c1',{r1:2,r2:9},1),...scores('c2',{r1:5,r2:5},1)]});
    const report=finalizeScores(state,{c1:4});
    expect(report.criteria.find(entry=>entry.criterionId==='c1')).toMatchObject({finalScore:4,method:'human_ruled',spread:7});
    expect(report.criteria.find(entry=>entry.criterionId==='c2')).toMatchObject({method:'debated'});
  });
});

describe('scoring flow: anti-anchoring',()=>{
  it('seals nominations, votes, and scores until the panel has committed',()=>{
    const nominating=snapshot({completions:[{phase:'nominating',round:1,participantId:'r1'}]});
    expect(nominationsSealed(nominating)).toBe(true);
    expect(nominationsSealed({...nominating,completions:[{phase:'nominating',round:1,participantId:'r1'},{phase:'nominating',round:1,participantId:'r2'},{phase:'nominating',round:1,participantId:'r3'}]})).toBe(false);

    const voting=snapshot({phase:'voting',criteria:[criterion('c1')],votes:votes('c1',{r1:'approve'})});
    expect(votesSealed(voting)).toBe(true);

    const scoring=snapshot({phase:'scoring',criteria:[criterion('c1','approved')],scores:scores('c1',{r1:6})});
    expect(scoresSealed(scoring)).toBe(true);
    const complete=snapshot({phase:'scoring',criteria:[criterion('c1','approved')],scores:scores('c1',{r1:6,r2:7,r3:8})});
    expect(scoresSealed(complete)).toBe(false);
    expect(scoresSealed({...scoring,policy:policy({blindScoring:false})})).toBe(false);
  });

  it('summarises progress for the board',()=>{
    const state=snapshot({phase:'analysis',criteria:[criterion('c1','approved'),criterion('c2')],scores:scores('c1',{r1:1,r2:9})});
    expect(scoringProgress(state)).toMatchObject({phase:'analysis',criteria:{candidates:1,approved:1},contested:['c1'],readyToAdvance:true});
  });
});

const round2=(value:number)=>Math.round(value*100)/100;
