import {COLLAB_ERRORS,OPEN_ISSUE_STATUSES,can,type Capability,type CollabPolicy,type IssueStatus,type Participant,type ReviewPhase,type Role,type SessionStatus,type Severity,type IssueVote,type MergeProposal} from './types.js';

/**
 * Pure review state machine. It performs no IO, so every rule below is directly unit-testable.
 *
 * Two invariants drive the whole design:
 * 1. Only the reporter of an issue (or a human ruling) may close it. The responder never can.
 * 2. A phase advances only when every required actor has submitted, or when a human forces it.
 *    Timeouts never advance anything; they only surface a `stalled` marker.
 */

export type FlowParticipant=Pick<Participant,'participantId'|'role'|'state'>;
export type FlowIssue={issueId:string,reporterId:string,targetParticipantId:string,status:IssueStatus,round:number,severity?:Severity};
export type PhaseCompletion={phase:ReviewPhase,round:number,participantId:string};
export type ReviewSnapshot={
  phase:ReviewPhase,round:number,policy:CollabPolicy,status:SessionStatus,
  participants:FlowParticipant[],issues:FlowIssue[],completions:PhaseCompletion[],pendingEscalations:number,
  debateRound?:number,issueVotes?:IssueVote[],mergeProposals?:MergeProposal[]
};
export type FlowError=Error&{code:string,httpStatus:number};

export const flowError=(code:string,message:string,httpStatus=409):FlowError=>Object.assign(new Error(message),{code,httpStatus});

const active=(snapshot:ReviewSnapshot)=>snapshot.participants.filter(participant=>participant.state!=='left');
const findParticipant=(snapshot:ReviewSnapshot,participantId:string)=>snapshot.participants.find(participant=>participant.participantId===participantId);
const unique=(values:string[])=>[...new Set(values)];
const reviewers=(snapshot:ReviewSnapshot)=>active(snapshot).filter(participant=>participant.role==='reviewer');
/** Only findings created in this review round need panel validation; older confirmed findings are rechecked separately. */
const consensusIssues=(snapshot:ReviewSnapshot)=>snapshot.issues.filter(issue=>issue.status==='open'&&issue.round===snapshot.round);
export function currentIssueVotes(snapshot:ReviewSnapshot){
  const latest=new Map<string,IssueVote>();
  for(const vote of snapshot.issueVotes??[]){
    if(vote.round!==snapshot.round)continue;
    const key=`${vote.issueId}:${vote.participantId}`,previous=latest.get(key);
    if(!previous||vote.consensusRound>previous.consensusRound||(vote.consensusRound===previous.consensusRound&&vote.createdAt>previous.createdAt))latest.set(key,vote);
  }
  return [...latest.values()];
}
export function issueConsensus(snapshot:ReviewSnapshot,options:{includeFinal?:boolean}={}){
  const panel=reviewers(snapshot);
  return (options.includeFinal?snapshot.issues:consensusIssues(snapshot)).map(issue=>{
    // The audit view includes findings from earlier review rounds, so read each issue's own latest ballot rather
    // than accidentally showing the current round's (usually absent) votes against every historical issue.
    const issueVotes=(snapshot.issueVotes??[]).filter(vote=>vote.issueId===issue.issueId&&vote.round===issue.round);
    const latest=new Map<string,IssueVote>();
    for(const vote of issueVotes){const previous=latest.get(vote.participantId);if(!previous||vote.consensusRound>previous.consensusRound||(vote.consensusRound===previous.consensusRound&&vote.createdAt>previous.createdAt))latest.set(vote.participantId,vote)}
    const positions=panel.map(reviewer=>reviewer.participantId===issue.reporterId
      ?{participantId:reviewer.participantId,stance:'approve' as const,implicit:true}
      :{participantId:reviewer.participantId,stance:latest.get(reviewer.participantId)?.stance,rationale:latest.get(reviewer.participantId)?.rationale,implicit:false});
    return {issueId:issue.issueId,positions,missing:positions.filter(position=>!position.stance).map(position=>position.participantId),rejecters:positions.filter(position=>position.stance==='reject').map(position=>position.participantId),supporters:positions.filter(position=>position.stance==='approve').map(position=>position.participantId),unanimous:positions.length>0&&positions.every(position=>position.stance==='approve')};
  });
}
export const contestedIssueIds=(snapshot:ReviewSnapshot)=>issueConsensus(snapshot).filter(entry=>entry.rejecters.length>0).map(entry=>entry.issueId);

/** Latest ballot per reviewer for one issue as it stood at the end of consensus round `consensusRound`. */
function stancesAt(snapshot:ReviewSnapshot,issueId:string,consensusRound:number){
  const latest=new Map<string,IssueVote>();
  for(const vote of snapshot.issueVotes??[]){
    if(vote.issueId!==issueId||vote.round!==snapshot.round||vote.consensusRound>consensusRound)continue;
    const previous=latest.get(vote.participantId);
    if(!previous||vote.consensusRound>previous.consensusRound||(vote.consensusRound===previous.consensusRound&&vote.createdAt>previous.createdAt))latest.set(vote.participantId,vote);
  }
  return [...latest.entries()].map(([participantId,vote])=>`${participantId}:${vote.stance}`).sort().join('|');
}
const lastVotedRound=(snapshot:ReviewSnapshot,issueId:string)=>Math.max(-1,...(snapshot.issueVotes??[]).filter(vote=>vote.issueId===issueId&&vote.round===snapshot.round).map(vote=>vote.consensusRound));
/**
 * Discussion rounds are only worth their tokens while they still move somebody. An issue whose ballot has been
 * identical for two consecutive reconsiderations is settled in fact, so the panel stops re-arguing it instead of
 * burning every remaining round (observed: three rounds of "I keep the rejection" on findings nobody flipped).
 * Two rounds of silence, not one: a rejecter that needs a second round of evidence is a real convergence path.
 * Measured against the last round that actually voted, so a round in progress is never judged before its ballots.
 */
export function staleContestedIssueIds(snapshot:ReviewSnapshot):string[]{
  return contestedIssueIds(snapshot).filter(issueId=>{
    const voted=lastVotedRound(snapshot,issueId);
    if(voted<2)return false;
    const current=stancesAt(snapshot,issueId,voted);
    return current===stancesAt(snapshot,issueId,voted-1)&&current===stancesAt(snapshot,issueId,voted-2);
  });
}
/** Contested findings the panel is still allowed to spend a round on. */
export function activeContestedIssueIds(snapshot:ReviewSnapshot):string[]{
  const stale=new Set(staleContestedIssueIds(snapshot));
  return contestedIssueIds(snapshot).filter(issueId=>!stale.has(issueId));
}

export type ContestedDisposition='panel_rejected'|'majority_rejected'|'majority_confirmed'|'escalate';
export type ContestedResolution={issueId:string,disposition:ContestedDisposition,reason:string,severity:Severity,supporters:string[],rejecters:string[]};
/** Findings a human is actually worth interrupting for; everything below this the panel settles itself. */
const HUMAN_REVIEW_SEVERITIES:Severity[]=['blocker','critical'];
const MAJOR_SEVERITIES:Severity[]=['blocker','critical','major'];
/**
 * Closes out the consensus stage. Escalating every disagreement makes a panel of N a queue of N disputes for the
 * human (observed: 6 of 18 findings, including two the reporter itself had conceded), so only two situations
 * genuinely need a ruling: a split panel on a serious finding, and a serious finding the whole panel rejected
 * over its reporter's objection. Everything else is decided by the panel and recorded.
 */
export function resolveContestedIssues(snapshot:ReviewSnapshot):ContestedResolution[]{
  const panel=reviewers(snapshot);
  return issueConsensus(snapshot).filter(entry=>entry.rejecters.length>0).map(entry=>{
    const issue=snapshot.issues.find(candidate=>candidate.issueId===entry.issueId);
    const severity=issue?.severity??'major';
    const voters=panel.filter(reviewer=>reviewer.participantId!==issue?.reporterId).map(reviewer=>reviewer.participantId);
    const base={issueId:entry.issueId,severity,supporters:entry.supporters,rejecters:entry.rejecters};
    // The reporter is the only supporter left: the panel says this is not a defect, and it had every discussion
    // round to withdraw it or convince somebody. Only a claimed blocker still buys a human's attention. Two
    // dissenters minimum: on a two-seat panel "everyone else" is one reviewer, which is a tie, not a verdict.
    if(voters.length>1&&voters.every(participantId=>entry.rejecters.includes(participantId)))
      return {...base,disposition:HUMAN_REVIEW_SEVERITIES.includes(severity)?'escalate' as const:'panel_rejected' as const,reason:'panel_unanimously_rejected'};
    if(MAJOR_SEVERITIES.includes(severity))return {...base,disposition:'escalate' as const,reason:'split_panel_on_a_major_finding'};
    if(entry.rejecters.length>entry.supporters.length)return {...base,disposition:'majority_rejected' as const,reason:'panel_majority_rejected'};
    // A tie keeps the finding: reporting it costs a line in the report, dropping a real defect costs a release.
    return {...base,disposition:'majority_confirmed' as const,reason:entry.supporters.length===entry.rejecters.length?'tie_kept_as_a_recorded_dispute':'panel_majority_confirmed'};
  });
}
const currentMergeProposals=(snapshot:ReviewSnapshot)=>(snapshot.mergeProposals??[]).filter(proposal=>proposal.round===snapshot.round);
const collectedThisRound=(snapshot:ReviewSnapshot)=>new Set(snapshot.completions.filter(entry=>entry.phase==='collecting'&&entry.round===snapshot.round).map(entry=>entry.participantId));
/** Reviewers who already closed their own blind review but still owe votes on other reviewers' already-filed issues. */
export function pendingCrossVoters(snapshot:ReviewSnapshot):string[]{
  if(snapshot.phase!=='collecting'||!snapshot.policy.consensusReview)return [];
  const collected=collectedThisRound(snapshot);
  return unique(issueConsensus(snapshot).flatMap(entry=>entry.missing)).filter(participantId=>collected.has(participantId));
}
export const owedIssueVoteIds=(snapshot:ReviewSnapshot,participantId:string)=>issueConsensus(snapshot).filter(entry=>entry.missing.includes(participantId)).map(entry=>entry.issueId);

/** Statuses nobody may move again without a human: rulings are final. */
export const FINAL_ISSUE_STATUSES:IssueStatus[]=['human_ruled','wontfix','closed','duplicate','withdrawn'];
export const isOpenIssue=(issue:FlowIssue)=>OPEN_ISSUE_STATUSES.includes(issue.status);

export function assertCapability(participant:FlowParticipant,capability:Capability){
  if(participant.state==='budget_exhausted')throw flowError(COLLAB_ERRORS.budgetExhausted,'Token budget is exhausted for this participant. A human must raise the budget or replace the agent.',429);
  if(participant.state==='left')throw flowError(COLLAB_ERRORS.forbidden,'This participant has left the session',403);
  if(!can(participant.role as Role,capability))throw flowError(COLLAB_ERRORS.forbidden,`Role ${participant.role} may not perform ${capability}`,403);
}

export function assertPhase(snapshot:ReviewSnapshot,phases:ReviewPhase[],action:string){
  if(snapshot.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${snapshot.status}; ${action} is no longer accepted`);
  if(!phases.includes(snapshot.phase))throw flowError(COLLAB_ERRORS.wrongPhase,`${action} is only accepted in phase ${phases.join(' or ')}, but the session is in ${snapshot.phase}`);
}

/**
 * Participants that must act before the current phase can advance.
 * Filing findings is required of reviewers only: an implementer's reverse findings are optional,
 * otherwise every session would deadlock waiting for an implementer with nothing to report.
 */
export function requiredActors(snapshot:ReviewSnapshot):string[]{
  const participants=active(snapshot);
  switch(snapshot.phase){
    case 'implementing':return participants.filter(participant=>participant.role==='implementer').map(participant=>participant.participantId);
    case 'collecting':return participants.filter(participant=>participant.role==='reviewer').map(participant=>participant.participantId);
    case 'validating':return reviewers(snapshot).map(participant=>participant.participantId);
    case 'merge_voting':return reviewers(snapshot).filter(participant=>currentMergeProposals(snapshot).some(proposal=>!proposal.votes.some(vote=>vote.participantId===participant.participantId))).map(participant=>participant.participantId);
    case 'issue_discussing':{
      const contested=new Set(activeContestedIssueIds(snapshot));
      return unique(issueConsensus(snapshot).filter(entry=>contested.has(entry.issueId)).flatMap(entry=>entry.supporters));
    }
    case 'issue_reconsidering':{
      const contested=new Set(activeContestedIssueIds(snapshot));
      return unique(issueConsensus(snapshot).filter(entry=>contested.has(entry.issueId)).flatMap(entry=>entry.rejecters));
    }
    // responding/adjudicating are legacy persisted phases. New reviews finish after panel consensus.
    default:return [];
  }
}

/** Required actors that have not finished yet. An exhausted or departed participant still blocks: a human must intervene. */
export function waitingOn(snapshot:ReviewSnapshot):string[]{
  const required=requiredActors(snapshot);
  if(['collecting','implementing','validating','merge_voting','issue_discussing','issue_reconsidering'].includes(snapshot.phase)){
    const done=new Set(snapshot.completions.filter(entry=>entry.phase===snapshot.phase&&entry.round===snapshot.round).map(entry=>entry.participantId));
    return required.filter(participantId=>!done.has(participantId));
  }
  return required;
}

export function isReadyToAdvance(snapshot:ReviewSnapshot):boolean{
  if(snapshot.status!=='active')return false;
  if(snapshot.phase==='consolidating')return true;
  if(snapshot.phase==='awaiting_human')return snapshot.pendingEscalations===0;
  if(['draft','finished'].includes(snapshot.phase))return false;
  return waitingOn(snapshot).length===0;
}

export type AdvanceResult={phase:ReviewPhase,round:number,reason:string,debateRound?:number,escalateDeadlock?:boolean,escalateConsensus?:boolean,resolutions?:ContestedResolution[],skipped?:string[]};

/**
 * Computes the next phase. `forced` is the human override used to break a stall; it is the only way
 * to move past participants that never submitted, and the skipped participants are reported for the log.
 */
export function nextPhase(snapshot:ReviewSnapshot,options:{forced?:boolean}={}):AdvanceResult{
  if(snapshot.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${snapshot.status}`);
  const pending=waitingOn(snapshot);
  if(!isReadyToAdvance(snapshot)&&!options.forced){
    if(snapshot.phase==='draft')throw flowError(COLLAB_ERRORS.wrongPhase,'Open the first round before advancing');
    if(snapshot.phase==='awaiting_human')throw flowError(COLLAB_ERRORS.wrongPhase,`${snapshot.pendingEscalations} escalation(s) still await a human ruling`);
    throw flowError(COLLAB_ERRORS.wrongPhase,`Still waiting on ${pending.length} participant(s): ${pending.join(', ')}`);
  }
  const skipped=options.forced&&pending.length?{skipped:pending}:{};
  // A participant may explicitly ask for a human during any consensus step. Finish the current batched step,
  // then stop before another debate round instead of silently debating past an open escalation.
  if(snapshot.pendingEscalations>0&&snapshot.phase!=='awaiting_human')return {phase:'awaiting_human',round:snapshot.round,debateRound:snapshot.debateRound,reason:'participant_escalated',...skipped};
  switch(snapshot.phase){
    case 'draft':return snapshot.policy.implementationFirst
      ? {phase:'implementing',round:snapshot.round,reason:'implementation_started',...skipped}
      : {phase:'collecting',round:snapshot.round,reason:'round_opened',...skipped};
    // The implementer declares itself done (or a managed agent goes idle); only then are the reviewers called.
    case 'implementing':return {phase:'collecting',round:snapshot.round,reason:'implementation_ready',...skipped};
    case 'collecting':return {phase:'consolidating',round:snapshot.round,reason:'findings_complete',...skipped};
    case 'consolidating':{
      if(!snapshot.policy.consensusReview)return {phase:'finished',round:snapshot.round,reason:'review_complete',...skipped};
      const panel=reviewers(snapshot),completed=(phase:ReviewPhase)=>new Set(snapshot.completions.filter(entry=>entry.phase===phase&&entry.round===snapshot.round).map(entry=>entry.participantId));
      if(!panel.every(entry=>completed('validating').has(entry.participantId)))return {phase:'validating',round:snapshot.round,reason:'issue_validation_started',...skipped};
      const proposals=currentMergeProposals(snapshot);
      if(proposals.length&&!completed('merge_voting').has('system'))return {phase:'merge_voting',round:snapshot.round,reason:'merge_voting_started',...skipped};
      return contestedIssueIds(snapshot).length
        ?{phase:'issue_discussing',round:snapshot.round,debateRound:Math.max(1,snapshot.debateRound??0),reason:'issue_votes_contested',...skipped}
        :{phase:'finished',round:snapshot.round,reason:'review_consensus_complete',...skipped};
    }
    case 'validating':return {phase:'consolidating',round:snapshot.round,reason:'issue_validation_complete',...skipped};
    case 'merge_voting':return {phase:'consolidating',round:snapshot.round,reason:'merge_voting_complete',...skipped};
    case 'issue_discussing':return {phase:'issue_reconsidering',round:snapshot.round,debateRound:snapshot.debateRound??1,reason:'supporter_arguments_complete',...skipped};
    case 'issue_reconsidering':{
      const contested=contestedIssueIds(snapshot);
      if(!contested.length)return {phase:'finished',round:snapshot.round,debateRound:snapshot.debateRound??1,reason:'review_consensus_complete',...skipped};
      const exhausted=(snapshot.debateRound??1)>=snapshot.policy.maxConsensusRounds;
      if(!exhausted&&activeContestedIssueIds(snapshot).length)return {phase:'issue_discussing',round:snapshot.round,debateRound:(snapshot.debateRound??1)+1,reason:'issue_consensus_next_round',...skipped};
      // The panel is done arguing, either out of rounds or out of movement. Dispose of every contested finding
      // here so only the ones a human must actually rule on reach the escalation queue.
      const resolutions=resolveContestedIssues(snapshot),escalated=resolutions.filter(entry=>entry.disposition==='escalate');
      return {phase:escalated.length?'awaiting_human':'finished',round:snapshot.round,debateRound:snapshot.debateRound??1,
        reason:escalated.length?(exhausted?'issue_consensus_exhausted':'issue_consensus_settled_with_disputes'):'issue_consensus_resolved_by_panel',
        resolutions,escalateConsensus:escalated.length>0,...skipped};
    }
    case 'awaiting_human':return {phase:'consolidating',round:snapshot.round,reason:'consensus_human_ruled',...skipped};
    // Compatibility recovery for sessions persisted by the old mandatory response loop: do not ask Agents for
    // another response; close the review and let a human start an explicit fix/recheck cycle if desired.
    case 'responding':
    case 'adjudicating':return {phase:'finished',round:snapshot.round,reason:'legacy_response_loop_removed',...skipped};
    default:throw flowError(COLLAB_ERRORS.wrongPhase,`Phase ${snapshot.phase} cannot advance`);
  }
}

/** A stall is informational only: it never changes the phase (see COLLAB_PLAN.md decision 3). */
export function stallCheck(snapshot:ReviewSnapshot,lastProgressAt:number,nowMs:number):{stalled:boolean,waitingOn:string[],overdueBySec:number}{
  const pending=waitingOn(snapshot),overdueBySec=Math.floor((nowMs-lastProgressAt)/1000);
  return {stalled:pending.length>0&&overdueBySec>=snapshot.policy.overdueWarningSec,waitingOn:pending,overdueBySec};
}

export function assertCanFileFinding(snapshot:ReviewSnapshot,participantId:string){
  const participant=findParticipant(snapshot,participantId);
  if(!participant)throw flowError(COLLAB_ERRORS.participantNotFound,'Participant is not part of this session',404);
  assertCapability(participant,'file_finding');
  assertPhase(snapshot,['collecting'],'Filing findings');
  return participant;
}

/** Blind review: until the collecting phase closes, a participant may only see their own findings. */
export function canSeeOthersFindings(snapshot:ReviewSnapshot):boolean{
  return !snapshot.policy.blindFindings||snapshot.phase!=='collecting';
}

export type IssueMutationOutcome={status:IssueStatus,round:number,escalate:boolean,escalateReason?:string};

/** Either side may escalate a panel dispute directly instead of spending more consensus rounds. */
export function applyEscalation(input:{issue:FlowIssue,actor:FlowParticipant}):IssueMutationOutcome{
  const {issue,actor}=input;
  assertCapability(actor,'escalate');
  if(issue.reporterId!==actor.participantId&&issue.targetParticipantId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the reporter or the addressed participant may escalate an issue',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  return {status:'escalated',round:issue.round,escalate:true,escalateReason:'participant_escalated'};
}

export function applyWithdraw(input:{issue:FlowIssue,actor:FlowParticipant}):IssueMutationOutcome{
  const {issue,actor}=input;
  assertCapability(actor,'withdraw');
  if(issue.reporterId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the reporter may withdraw an issue',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  return {status:'withdrawn',round:issue.round,escalate:false};
}

export type HumanDecision='resolved'|'wontfix'|'closed'|'reopen';
/** A human ruling is terminal except for an explicit reopen, which hands the issue back to the responder. */
export function applyHumanRuling(issue:FlowIssue,decision:HumanDecision):IssueMutationOutcome{
  if(decision==='reopen')return {status:'open',round:issue.round+1,escalate:false};
  return {status:decision==='resolved'?'human_ruled':decision,round:issue.round,escalate:false};
}

/** Everyone the reviewers have to agree with before a session may finish clean. */
export function approvalSummary(snapshot:ReviewSnapshot){
  const reviewers=active(snapshot).filter(participant=>participant.role==='reviewer');
  const approvals=reviewers.map(reviewer=>{
    const filed=snapshot.issues.filter(issue=>issue.reporterId===reviewer.participantId);
    const unresolved=filed.filter(isOpenIssue);
    return {participantId:reviewer.participantId,filed:filed.length,unresolved:unresolved.length,approved:unresolved.length===0};
  });
  return {
    reviewers:approvals,
    // "Approved" means every reviewer's own findings are settled and nothing needed a human ruling.
    unanimous:approvals.length>0&&approvals.every(entry=>entry.approved),
    humanRuledCount:snapshot.issues.filter(issue=>issue.status==='human_ruled'||issue.status==='wontfix'||issue.status==='closed').length
  };
}

export function sessionProgress(snapshot:ReviewSnapshot){
  const counts=new Map<IssueStatus,number>();
  for(const issue of snapshot.issues)counts.set(issue.status,(counts.get(issue.status)??0)+1);
  return {
    phase:snapshot.phase,round:snapshot.round,
    totalIssues:snapshot.issues.length,
    openIssues:snapshot.issues.filter(isOpenIssue).length,
    byStatus:Object.fromEntries(counts) as Partial<Record<IssueStatus,number>>,
    waitingOn:waitingOn(snapshot),
    pendingCrossVotes:pendingCrossVoters(snapshot),
    readyToAdvance:isReadyToAdvance(snapshot)
  };
}
