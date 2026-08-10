import {COLLAB_ERRORS,OPEN_ISSUE_STATUSES,can,type Capability,type CollabPolicy,type IssueStatus,type Participant,type ResponseType,type ReviewPhase,type Role,type SessionStatus,type VerdictType} from './types.js';

/**
 * Pure review state machine. It performs no IO, so every rule below is directly unit-testable.
 *
 * Two invariants drive the whole design:
 * 1. Only the reporter of an issue (or a human ruling) may close it. The responder never can.
 * 2. A phase advances only when every required actor has submitted, or when a human forces it.
 *    Timeouts never advance anything; they only surface a `stalled` marker.
 */

export type FlowParticipant=Pick<Participant,'participantId'|'role'|'state'>;
export type FlowIssue={issueId:string,reporterId:string,targetParticipantId:string,status:IssueStatus,round:number};
export type PhaseCompletion={phase:ReviewPhase,round:number,participantId:string};
export type ReviewSnapshot={
  phase:ReviewPhase,round:number,policy:CollabPolicy,status:SessionStatus,
  participants:FlowParticipant[],issues:FlowIssue[],completions:PhaseCompletion[],pendingEscalations:number
};
export type FlowError=Error&{code:string,httpStatus:number};

export const flowError=(code:string,message:string,httpStatus=409):FlowError=>Object.assign(new Error(message),{code,httpStatus});

const active=(snapshot:ReviewSnapshot)=>snapshot.participants.filter(participant=>participant.state!=='left');
const findParticipant=(snapshot:ReviewSnapshot,participantId:string)=>snapshot.participants.find(participant=>participant.participantId===participantId);
const unique=(values:string[])=>[...new Set(values)];

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
    case 'responding':return unique(snapshot.issues.filter(issue=>issue.status==='open').map(issue=>issue.targetParticipantId));
    case 'adjudicating':return unique(snapshot.issues.filter(issue=>issue.status==='answered').map(issue=>issue.reporterId));
    default:return [];
  }
}

/** Required actors that have not finished yet. An exhausted or departed participant still blocks: a human must intervene. */
export function waitingOn(snapshot:ReviewSnapshot):string[]{
  const required=requiredActors(snapshot);
  if(snapshot.phase==='collecting'||snapshot.phase==='implementing'){
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

export type AdvanceResult={phase:ReviewPhase,round:number,reason:string,escalateDeadlock?:boolean,skipped?:string[]};

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
  switch(snapshot.phase){
    case 'draft':return snapshot.policy.implementationFirst
      ? {phase:'implementing',round:snapshot.round,reason:'implementation_started',...skipped}
      : {phase:'collecting',round:snapshot.round,reason:'round_opened',...skipped};
    // The implementer declares itself done (or a managed agent goes idle); only then are the reviewers called.
    case 'implementing':return {phase:'collecting',round:snapshot.round,reason:'implementation_ready',...skipped};
    case 'collecting':return {phase:'consolidating',round:snapshot.round,reason:'findings_complete',...skipped};
    case 'consolidating':return {phase:'responding',round:snapshot.round,reason:'digest_ready',...skipped};
    case 'responding':return {phase:'adjudicating',round:snapshot.round,reason:'responses_complete',...skipped};
    case 'awaiting_human':return {phase:'adjudicating',round:snapshot.round,reason:'human_ruled',...skipped};
    case 'adjudicating':{
      if(snapshot.pendingEscalations>0)return {phase:'awaiting_human',round:snapshot.round,reason:'escalations_pending',...skipped};
      if(!snapshot.issues.some(isOpenIssue))return {phase:'finished',round:snapshot.round,reason:'all_issues_closed',...skipped};
      if(snapshot.round>=snapshot.policy.maxTotalRounds)return {phase:'awaiting_human',round:snapshot.round,reason:'max_total_rounds_reached',escalateDeadlock:true,...skipped};
      return {phase:'collecting',round:snapshot.round+1,reason:'next_round',...skipped};
    }
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

export type ResponseOutcome={status:IssueStatus,round:number,escalate:boolean,escalateReason?:string};

/** Applies a response from the participant an issue is addressed to. Responding never closes an issue. */
export function applyResponse(input:{issue:FlowIssue,actor:FlowParticipant,responseType:ResponseType,policy:CollabPolicy}):ResponseOutcome{
  const {issue,actor}=input;
  assertCapability(actor,'respond');
  if(issue.targetParticipantId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the participant an issue is addressed to may respond to it',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  if(issue.status!=='open')throw flowError(COLLAB_ERRORS.conflict,`Issue is ${issue.status}; only open issues accept a response`);
  // Every response type only answers the issue. Even `deferred` and `rejected` leave the decision to the reporter.
  return {status:'answered',round:issue.round,escalate:false};
}

export type VerdictOutcome={status:IssueStatus,round:number,escalate:boolean,escalateReason?:string};

/** Applies the reporter's verdict. Rejecting reopens the issue for another round until the round cap escalates it. */
export function applyVerdict(input:{issue:FlowIssue,actor:FlowParticipant,verdict:VerdictType,policy:CollabPolicy}):VerdictOutcome{
  const {issue,actor,verdict,policy}=input;
  assertCapability(actor,'verdict');
  if(issue.reporterId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the participant who reported an issue may rule on it',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  if(issue.status!=='answered')throw flowError(COLLAB_ERRORS.conflict,`Issue is ${issue.status}; only answered issues accept a verdict`);
  if(verdict==='accept')return {status:'resolved',round:issue.round,escalate:false};
  if(verdict==='escalate')return {status:'escalated',round:issue.round,escalate:true,escalateReason:'reporter_escalated'};
  const nextRound=issue.round+1;
  if(nextRound>policy.maxIssueRounds)return {status:'escalated',round:issue.round,escalate:true,escalateReason:'max_issue_rounds_reached'};
  return {status:'open',round:nextRound,escalate:false};
}

/** Either side may escalate directly instead of looping; the issue then waits for a human. */
export function applyEscalation(input:{issue:FlowIssue,actor:FlowParticipant}):VerdictOutcome{
  const {issue,actor}=input;
  assertCapability(actor,'escalate');
  if(issue.reporterId!==actor.participantId&&issue.targetParticipantId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the reporter or the addressed participant may escalate an issue',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  return {status:'escalated',round:issue.round,escalate:true,escalateReason:'participant_escalated'};
}

export function applyWithdraw(input:{issue:FlowIssue,actor:FlowParticipant}):VerdictOutcome{
  const {issue,actor}=input;
  assertCapability(actor,'withdraw');
  if(issue.reporterId!==actor.participantId)throw flowError(COLLAB_ERRORS.forbidden,'Only the reporter may withdraw an issue',403);
  if(FINAL_ISSUE_STATUSES.includes(issue.status))throw flowError(COLLAB_ERRORS.humanRulingFinal,`Issue is ${issue.status} and can no longer be changed`);
  return {status:'withdrawn',round:issue.round,escalate:false};
}

export type HumanDecision='resolved'|'wontfix'|'closed'|'reopen';
/** A human ruling is terminal except for an explicit reopen, which hands the issue back to the responder. */
export function applyHumanRuling(issue:FlowIssue,decision:HumanDecision):VerdictOutcome{
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
    readyToAdvance:isReadyToAdvance(snapshot)
  };
}
