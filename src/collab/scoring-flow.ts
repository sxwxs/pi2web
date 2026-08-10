import {COLLAB_ERRORS,can,type CollabPolicy,type ScoringPhase,type SessionStatus,type VoteStance} from './types.js';
import {flowError,type FlowParticipant} from './review-flow.js';

/**
 * Pure panel-scoring state machine: nominate criteria, consolidate, vote, lock the rubric,
 * score blind, debate the contested criteria, rescore, and either converge or hand the
 * remaining disagreement to a human. No IO, so every rule here is unit-testable.
 *
 * Two deliberate choices:
 * - Convergence is measured, never assumed. A criterion whose spread stays wide goes to a human
 *   instead of being averaged into a comfortable-looking number.
 * - Minority opinions survive into the final report. Hiding dissent hides risk.
 */

export type FlowCriterion={criterionId:string,state:'candidate'|'approved'|'rejected',name:string,round:number,weight?:number};
export type FlowVote={criterionId:string,participantId:string,round:number,stance:VoteStance,weight?:number};
export type FlowScore={criterionId:string,participantId:string,round:number,score:number};
export type FlowDebate={debateId:string,criterionId:string,round:number,status:'open'|'closed',arguments:{participantId:string}[]};
export type ScoringCompletion={phase:ScoringPhase,round:number,participantId:string};
export type ScoringSnapshot={
  phase:ScoringPhase,round:number,debateRound:number,policy:CollabPolicy,status:SessionStatus,
  participants:FlowParticipant[],criteria:FlowCriterion[],votes:FlowVote[],scores:FlowScore[],
  debates:FlowDebate[],completions:ScoringCompletion[],pendingEscalations:number
};

const mean=(values:number[])=>values.reduce((total,value)=>total+value,0)/values.length;
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2};
const stdev=(values:number[])=>{if(values.length<2)return 0;const average=mean(values);return Math.sqrt(values.reduce((total,value)=>total+(value-average)**2,0)/(values.length-1))};
const round2=(value:number)=>Math.round(value*100)/100;

/** Only reviewers score. The implementer is recused so the party under review cannot grade itself. */
export const scoringPanel=(snapshot:ScoringSnapshot)=>snapshot.participants.filter(participant=>participant.state!=='left'&&participant.role==='reviewer');

export function assertScoringCapability(participant:FlowParticipant,capability:'nominate'|'vote'|'score'|'debate'|'clarify'){
  if(participant.state==='budget_exhausted')throw flowError(COLLAB_ERRORS.budgetExhausted,'Token budget is exhausted for this participant',429);
  if(participant.state==='left')throw flowError(COLLAB_ERRORS.forbidden,'This participant has left the session',403);
  if(!can(participant.role,capability))throw flowError(COLLAB_ERRORS.forbidden,`Role ${participant.role} may not ${capability} in a scoring session`,403);
}
export function assertScoringPhase(snapshot:ScoringSnapshot,phases:ScoringPhase[],action:string){
  if(snapshot.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${snapshot.status}; ${action} is no longer accepted`);
  if(!phases.includes(snapshot.phase))throw flowError(COLLAB_ERRORS.wrongPhase,`${action} is only accepted in phase ${phases.join(' or ')}, but the session is in ${snapshot.phase}`);
}

export const approvedCriteria=(snapshot:ScoringSnapshot)=>snapshot.criteria.filter(criterion=>criterion.state==='approved');
export const candidateCriteria=(snapshot:ScoringSnapshot)=>snapshot.criteria.filter(criterion=>criterion.state==='candidate');
export const contestedCriteria=(snapshot:ScoringSnapshot)=>analyse(snapshot).filter(entry=>entry.contested);

/** Everyone on the panel must submit before a phase closes; nothing is inferred from silence. */
export function scoringWaitingOn(snapshot:ScoringSnapshot):string[]{
  const panel=scoringPanel(snapshot).map(participant=>participant.participantId);
  const done=(phase:ScoringPhase,round=snapshot.round)=>new Set(snapshot.completions.filter(entry=>entry.phase===phase&&entry.round===round).map(entry=>entry.participantId));
  switch(snapshot.phase){
    case 'nominating':{const finished=done('nominating');return panel.filter(id=>!finished.has(id))}
    case 'voting':{
      const candidates=candidateCriteria(snapshot);
      if(!candidates.length)return [];
      return panel.filter(id=>candidates.some(criterion=>!snapshot.votes.some(vote=>vote.criterionId===criterion.criterionId&&vote.participantId===id&&vote.round===snapshot.round)));
    }
    case 'scoring':{
      const criteria=approvedCriteria(snapshot);
      return panel.filter(id=>criteria.some(criterion=>!snapshot.scores.some(score=>score.criterionId===criterion.criterionId&&score.participantId===id&&score.round===snapshot.debateRound)));
    }
    case 'debating':{
      const open=snapshot.debates.filter(debate=>debate.status==='open'&&debate.round===snapshot.debateRound);
      // Whoever scored a contested criterion must defend, revise, or explicitly hold their position.
      return panel.filter(id=>open.some(debate=>snapshot.scores.some(score=>score.criterionId===debate.criterionId&&score.participantId===id)&&!debate.arguments.some(entry=>entry.participantId===id)));
    }
    case 'rescoring':{
      const contested=snapshot.debates.filter(debate=>debate.round===snapshot.debateRound).map(debate=>debate.criterionId);
      return panel.filter(id=>contested.some(criterionId=>!snapshot.scores.some(score=>score.criterionId===criterionId&&score.participantId===id&&score.round===snapshot.debateRound+1)));
    }
    default:return [];
  }
}

/**
 * Ready means "the panel has finished this step", which presupposes a panel: with no reviewer every
 * "everyone submitted" check is vacuously true, so /advance could walk nomination->voting->rubric with
 * nobody in the room. A pending escalation parks the flow too - a human question that finalization
 * overtakes is a question nobody ever answers. Both gates are bypassed only by an explicit forced advance.
 */
export function isScoringReadyToAdvance(snapshot:ScoringSnapshot):boolean{
  if(snapshot.status!=='active')return false;
  if(snapshot.phase==='finalized')return false;
  if(!scoringPanel(snapshot).length)return false;
  if(snapshot.pendingEscalations>0)return false;
  if(['consolidating','rubric_locked','analysis','awaiting_human'].includes(snapshot.phase))return true;
  if(snapshot.phase==='nominating'&&!candidateCriteria(snapshot).length&&!scoringWaitingOn(snapshot).length)return true;
  return scoringWaitingOn(snapshot).length===0;
}

export type VoteTally={criterionId:string,approve:number,reject:number,abstain:number,ratio:number,approved:boolean,weight:number};
/**
 * A criterion passes when the approval ratio clears the threshold and at least two panelists
 * approve, so a single reviewer can never impose a criterion. Weight is the median suggestion.
 */
export function tallyVotes(snapshot:ScoringSnapshot,round=snapshot.round):VoteTally[]{
  return candidateCriteria(snapshot).map(criterion=>{
    const votes=snapshot.votes.filter(vote=>vote.criterionId===criterion.criterionId&&vote.round===round);
    const approve=votes.filter(vote=>vote.stance==='approve'),reject=votes.filter(vote=>vote.stance==='reject');
    const decided=approve.length+reject.length,ratio=decided?approve.length/decided:0;
    const weights=approve.map(vote=>vote.weight).filter((value):value is number=>typeof value==='number'&&value>0);
    return {criterionId:criterion.criterionId,approve:approve.length,reject:reject.length,abstain:votes.filter(vote=>vote.stance==='abstain').length,
      ratio:round2(ratio),approved:ratio>=snapshot.policy.scoring.approvalThreshold&&approve.length>=2,weight:weights.length?median(weights):1};
  });
}

export type RubricResult={criteria:{criterionId:string,weight:number}[],lockedBy:'panel'|'policy',reason:string,rejected:string[]};
/**
 * Turns a vote round into a rubric. If the panel cannot land inside the configured size range,
 * the last round falls back to the highest-approval criteria and records that policy, not the
 * panel, made the call, so the report never pretends there was consensus.
 */
export function lockRubric(snapshot:ScoringSnapshot):RubricResult|undefined{
  const tallies=tallyVotes(snapshot),{minCriteria,maxCriteria,maxVotingRounds}=snapshot.policy.scoring;
  const passed=tallies.filter(tally=>tally.approved).sort((a,b)=>b.ratio-a.ratio||b.approve-a.approve);
  const lastRound=snapshot.round>=maxVotingRounds;
  const withinRange=passed.length>=minCriteria&&passed.length<=maxCriteria;
  if(withinRange)return {criteria:normalizeWeights(passed),lockedBy:'panel',reason:'approved_by_panel',rejected:tallies.filter(tally=>!tally.approved).map(tally=>tally.criterionId)};
  if(!lastRound)return undefined;
  const fallback=(passed.length?passed:[...tallies].sort((a,b)=>b.ratio-a.ratio||b.approve-a.approve)).slice(0,maxCriteria);
  if(!fallback.length)return undefined;
  return {criteria:normalizeWeights(fallback),lockedBy:'policy',
    reason:passed.length>maxCriteria?'too_many_approved_criteria':'panel_never_reached_the_minimum',
    rejected:tallies.filter(tally=>!fallback.some(entry=>entry.criterionId===tally.criterionId)).map(tally=>tally.criterionId)};
}
export function normalizeWeights(tallies:{criterionId:string,weight:number}[]){
  const total=tallies.reduce((sum,tally)=>sum+(tally.weight||0),0)||tallies.length;
  return tallies.map(tally=>({criterionId:tally.criterionId,weight:round2((tally.weight||1)/total)}));
}

export type CriterionAnalysis={criterionId:string,scores:{participantId:string,score:number}[],min:number,max:number,mean:number,median:number,stdev:number,range:number,contested:boolean};
/**
 * The scores that count for a criterion at `round`: each participant's latest submission at or before it.
 * A rescore only covers the *contested* criteria, so an exact-round filter would drop every untouched
 * criterion and finalize it at 0. Carrying the last score forward is what keeps the rubric intact.
 */
export function effectiveScores(snapshot:ScoringSnapshot,criterionId:string,round:number):FlowScore[]{
  const latest=new Map<string,FlowScore>();
  for(const score of snapshot.scores){
    if(score.criterionId!==criterionId||score.round>round)continue;
    const current=latest.get(score.participantId);
    if(!current||score.round>=current.round)latest.set(score.participantId,score);
  }
  return [...latest.values()];
}
/** Measures disagreement per criterion for the current scoring round. */
export function analyse(snapshot:ScoringSnapshot,round=snapshot.debateRound):CriterionAnalysis[]{
  return approvedCriteria(snapshot).map(criterion=>{
    const entries=effectiveScores(snapshot,criterion.criterionId,round);
    const values=entries.map(entry=>entry.score);
    if(!values.length)return {criterionId:criterion.criterionId,scores:[],min:0,max:0,mean:0,median:0,stdev:0,range:0,contested:false};
    const min=Math.min(...values),max=Math.max(...values);
    return {criterionId:criterion.criterionId,scores:entries.map(entry=>({participantId:entry.participantId,score:entry.score})),
      min,max,mean:round2(mean(values)),median:round2(median(values)),stdev:round2(stdev(values)),range:round2(max-min),
      contested:values.length>1&&max-min>snapshot.policy.scoring.convergenceRange};
  });
}

export type ScoringAdvance={phase:ScoringPhase,round:number,debateRound:number,reason:string,rubric?:RubricResult,contested?:string[],skipped?:string[]};
export function nextScoringPhase(snapshot:ScoringSnapshot,options:{forced?:boolean}={}):ScoringAdvance{
  if(snapshot.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${snapshot.status}`);
  const pending=scoringWaitingOn(snapshot);
  if(!isScoringReadyToAdvance(snapshot)&&!options.forced){
    if(!scoringPanel(snapshot).length)throw flowError(COLLAB_ERRORS.wrongPhase,'This scoring session has no reviewer on the panel yet; register one before advancing');
    if(snapshot.pendingEscalations>0)throw flowError(COLLAB_ERRORS.wrongPhase,`${snapshot.pendingEscalations} escalation(s) still await a human ruling`);
    throw flowError(COLLAB_ERRORS.wrongPhase,`Still waiting on ${pending.length} participant(s): ${pending.join(', ')}`);
  }
  const base={round:snapshot.round,debateRound:snapshot.debateRound,...(options.forced&&pending.length?{skipped:pending}:{})};
  switch(snapshot.phase){
    case 'nominating':return {...base,phase:'consolidating',reason:'nominations_complete'};
    case 'consolidating':return {...base,phase:'voting',reason:'candidates_ready'};
    case 'voting':{
      const rubric=lockRubric(snapshot);
      if(rubric)return {...base,phase:'rubric_locked',reason:rubric.lockedBy==='panel'?'rubric_approved':'rubric_forced_by_policy',rubric};
      const approved=tallyVotes(snapshot).filter(tally=>tally.approved).length;
      // Too few criteria means the panel needs more proposals; too many means it needs to narrow down.
      return approved<snapshot.policy.scoring.minCriteria
        ?{...base,phase:'nominating',round:snapshot.round+1,reason:'not_enough_approved_criteria'}
        :{...base,phase:'voting',round:snapshot.round+1,reason:'too_many_approved_criteria'};
    }
    case 'rubric_locked':return {...base,phase:'scoring',reason:'rubric_locked'};
    case 'scoring':return {...base,phase:'analysis',reason:'scores_submitted'};
    case 'analysis':{
      const contested=contestedCriteria(snapshot).map(entry=>entry.criterionId);
      if(!contested.length)return {...base,phase:'finalized',reason:'scores_converged'};
      if(snapshot.debateRound>=snapshot.policy.scoring.maxDebateRounds)return {...base,phase:'awaiting_human',reason:'scores_still_contested',contested};
      return {...base,phase:'debating',reason:'contested_criteria',contested};
    }
    case 'debating':return {...base,phase:'rescoring',reason:'debate_complete'};
    case 'rescoring':return {...base,phase:'analysis',debateRound:snapshot.debateRound+1,reason:'rescored'};
    case 'awaiting_human':return {...base,phase:'finalized',reason:'human_ruled'};
    default:throw flowError(COLLAB_ERRORS.wrongPhase,`Phase ${snapshot.phase} cannot advance`);
  }
}

export type FinalReport={
  criteria:{criterionId:string,name:string,weight:number,finalScore:number,method:'converged'|'debated'|'human_ruled'|'forced',spread:number,perReviewer:Record<string,number>}[],
  totalScore:number,scale:{min:number,max:number},agreement:number,
  dissents:{participantId:string,criterionId:string,score:number,distanceFromFinal:number}[]
};
/**
 * Produces the final rubric-weighted score. Rulings win over measurement; otherwise the median is
 * used because it resists a single outlier. Dissenting scores are reported, never averaged away.
 * A criterion that is still contested and got no ruling is reported as `forced`: calling that "converged"
 * would let a forced advance close a session with a number the panel never agreed on.
 */
export function finalizeScores(snapshot:ScoringSnapshot,rulings:Record<string,number>={}):FinalReport{
  const analyses=analyse(snapshot),scale=snapshot.policy.scoring.scale,span=Math.max(1,scale.max-scale.min);
  const criteria=approvedCriteria(snapshot).map(criterion=>{
    const analysis=analyses.find(entry=>entry.criterionId===criterion.criterionId);
    const ruled=rulings[criterion.criterionId];
    const finalScore=ruled!==undefined?ruled:analysis?.scores.length?analysis.median:0;
    return {criterionId:criterion.criterionId,name:criterion.name,weight:criterion.weight??round2(1/Math.max(1,approvedCriteria(snapshot).length)),
      finalScore:round2(finalScore),
      method:(ruled!==undefined?'human_ruled':analysis?.contested?'forced':snapshot.debateRound>0?'debated':'converged') as 'converged'|'debated'|'human_ruled'|'forced',
      spread:analysis?.range??0,perReviewer:Object.fromEntries((analysis?.scores??[]).map(entry=>[entry.participantId,entry.score]))};
  });
  const weightTotal=criteria.reduce((sum,criterion)=>sum+criterion.weight,0)||1;
  const totalScore=round2(criteria.reduce((sum,criterion)=>sum+criterion.finalScore*criterion.weight,0)/weightTotal);
  const spreads=analyses.filter(entry=>entry.scores.length>1).map(entry=>entry.range/span);
  const dissents=criteria.flatMap(criterion=>Object.entries(criterion.perReviewer)
    .map(([participantId,score])=>({participantId,criterionId:criterion.criterionId,score,distanceFromFinal:round2(Math.abs(score-criterion.finalScore))}))
    .filter(entry=>entry.distanceFromFinal>snapshot.policy.scoring.convergenceRange/2));
  return {criteria,totalScore,scale:{min:scale.min,max:scale.max},agreement:round2(spreads.length?1-mean(spreads):1),dissents};
}

export function scoringProgress(snapshot:ScoringSnapshot){
  return {phase:snapshot.phase,round:snapshot.round,debateRound:snapshot.debateRound,
    criteria:{candidates:candidateCriteria(snapshot).length,approved:approvedCriteria(snapshot).length},
    contested:contestedCriteria(snapshot).map(entry=>entry.criterionId),
    waitingOn:scoringWaitingOn(snapshot),readyToAdvance:isScoringReadyToAdvance(snapshot)};
}

/** Blind scoring: nobody sees the distribution until every panelist has committed to a number. */
export function scoresSealed(snapshot:ScoringSnapshot):boolean{
  if(!snapshot.policy.scoring.blindScoring)return false;
  return ['scoring','rescoring'].includes(snapshot.phase)&&scoringWaitingOn(snapshot).length>0;
}
export function nominationsSealed(snapshot:ScoringSnapshot):boolean{
  return snapshot.phase==='nominating'&&scoringWaitingOn(snapshot).length>0;
}
export function votesSealed(snapshot:ScoringSnapshot):boolean{
  return snapshot.phase==='voting'&&scoringWaitingOn(snapshot).length>0;
}
