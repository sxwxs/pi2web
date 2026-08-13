import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {COLLAB_ERRORS,type CollabEvent,type CollabSession,type CollabSubject,type Escalation,type Issue,type Participant,type ReviewPhase,type ScoringPhase} from './types.js';
import {CollabStore,type CreateSessionInput} from './store.js';
import {ValidationError,parse,type FieldError} from './validate.js';
import {advanceRequest,createParticipantRequest,createSessionRequest,debateArgumentRequest,escalationRequest,findingsRequest,finalizeRequest,nominationsRequest,participantBudgetRequest,policyPatch,readyRequest,rebindParticipantRequest,resolveEscalationRequest,responsesRequest,scoresRequest,verdictsRequest,votesRequest,issueVotesRequest,mergeVotesRequest,issueDiscussionsRequest,retryWaitingRequest} from './schemas.js';
import {analyse,assertScoringCapability,assertScoringPhase,approvedCriteria,contestedCriteria,finalizeScores,isScoringReadyToAdvance,lockRubric,nextScoringPhase,nominationsSealed,scoresSealed,scoringPanel,scoringProgress,scoringWaitingOn,tallyVotes,votesSealed,type ScoringSnapshot} from './scoring-flow.js';
import {applyEscalation,applyHumanRuling,applyResponse,applyVerdict,applyWithdraw,approvalSummary,assertCanFileFinding,assertCapability,canSeeOthersFindings,flowError,isOpenIssue,isReadyToAdvance,nextPhase,sessionProgress,stallCheck,waitingOn,currentIssueVotes,issueConsensus,contestedIssueIds,type FlowIssue,type FlowParticipant,type ReviewSnapshot} from './review-flow.js';

const run=promisify(execFile);

/** How long a queued task may sit undelivered before the human is told that the wake-up is not landing. */
const UNDELIVERED_TASK_WARNING_MS=120_000;

export type BaselineSnapshot={vcs:string,commit?:string,range?:string,dirtyHash?:string,paths:string[]};
export type BaselineResolver=(input:{cwd:string,subject:CollabSubject,round:number})=>Promise<BaselineSnapshot>;
export type HubOptions={resolveBaseline?:BaselineResolver,now?:()=>number,agentTokenUsage?:(agentId:string)=>Promise<number|undefined>,agentStatus?:(agentId:string)=>string|undefined};

/** Anchors every round to an immutable code state so round N+1 verdicts are not made against round N's memory. */
export const gitBaseline:BaselineResolver=async({cwd,subject})=>{
  const git=async(args:string[])=>(await run('git',args,{cwd,maxBuffer:8*1024*1024})).stdout;
  try{
    const commit=(await git(['rev-parse','HEAD'])).trim();
    let dirtyHash:string|undefined;
    const status=(await git(['status','--porcelain'])).trim();
    if(status){const diff=await git(['diff','HEAD']).catch(()=>'');dirtyHash=`sha256:${createHash('sha256').update(status).update(diff).digest('hex')}`}
    return {vcs:'git',commit,range:subject.type==='commit_range'?subject.value:undefined,dirtyHash,paths:subject.type==='paths'?subject.value.split(/[\n,]/).map(value=>value.trim()).filter(Boolean):[]};
  }catch{
    // Not a git checkout (or git is missing). The hub still works; it just cannot prove code identity.
    return {vcs:'none',paths:[]};
  }
};

const fieldError=(path:string,code:string,message:string):FieldError=>({path,code,message});


/**
 * Orchestration layer: authentication, validation, persistence, event emission, and phase advancement.
 * All decision logic lives in review-flow.ts; this class only wires it to storage and to the outside world.
 */
export class CollabHub {
  private listeners=new Set<(event:CollabEvent)=>void>();
  private closed=false;
  private readonly resolveBaseline:BaselineResolver;
  private readonly now:()=>number;
  constructor(readonly store:CollabStore,private readonly options:HubOptions={}){
    this.resolveBaseline=options.resolveBaseline??gitBaseline;
    this.now=options.now??(()=>Date.now());
  }
  init(){this.store.init()}
  shutdown(){this.closed=true}
  subscribe(listener:(event:CollabEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  private emit(event:CollabEvent){for(const listener of this.listeners)try{listener(event)}catch{/* A broken subscriber must not roll back committed state. */}}
  private record(sessionId:string,type:string,payload:Record<string,unknown>={},actorId?:string){const event=this.store.appendEvent(sessionId,type,payload,actorId);this.emit(event);return event}
  /** Queues a wake-up. The dispatcher turns it into a prompt and acks it; nothing else reads this queue. */
  private push(sessionId:string,participantId:string,type:string,payload:Record<string,unknown>){
    return this.store.pushInbox(sessionId,participantId,type,payload);
  }
  /** A finished session no longer needs to wake anyone, so the stored credentials are dropped. */
  retireDispatchTokens(sessionId:string){
    for(const participant of this.store.listParticipants(sessionId))this.store.clearDispatchToken(participant.participantId);
  }
  /**
   * Retires one seat's credential. Each delivery must retire its own: dropping the whole session's tokens after
   * the first closing note would leave every later `session_result` delivery without a credential.
   */
  retireDispatchToken(participantId:string){this.store.clearDispatchToken(participantId)}
  /**
   * Marks the queued items of a task as handled once the agent has been told about them. Nobody acks for
   * itself any more, so without this an item would look pending forever and be re-sent on every restart.
   */
  completeDelivery(participantId:string,task:string){
    const items=this.store.listInbox(participantId).filter(item=>item.type===task);
    if(items.length)this.store.ackInbox(participantId,items.map(item=>item.itemId));
    return items.length;
  }
  /** Public so the dispatcher can log a wake-up attempt on the session timeline without reaching into internals. */
  logDispatch(sessionId:string,type:'agent_dispatched'|'dispatch_failed',payload:Record<string,unknown>){
    try{this.record(sessionId,type,payload)}catch{/* the session may have been removed while a wake-up was in flight */}
  }

  // ---------------------------------------------------------------- human operations
  /** Only humans create sessions: agents must never be able to spawn collaboration loops on their own. */
  async createSession(body:unknown,resolveCwd:(workspaceId:string,relativeCwd:string)=>Promise<string>):Promise<CollabSession>{
    const input=parse(createSessionRequest,body);
    const cwd=await resolveCwd(input.workspaceId,input.relativeCwd);
    const session=this.store.createSession({kind:input.kind,title:input.title,workspaceId:input.workspaceId,cwd,subject:input.subject,policy:input.policy} as CreateSessionInput);
    this.record(session.sessionId,'session_created',{kind:session.kind,title:session.title,cwd,subject:session.subject});
    return session;
  }
  listSessions(filter:{status?:string,kind?:string,limit?:number,offset?:number}={}){return this.store.listSessions(filter)}
  getSession(sessionId:string){return this.store.getSession(sessionId)}
  updatePolicy(sessionId:string,body:unknown){
    const patch=parse(policyPatch,body),session=this.store.getSession(sessionId);
    const updated=this.store.updateSession(sessionId,{policy:{...session.policy,...patch,scoring:{...session.policy.scoring,...patch.scoring,scale:{...session.policy.scoring.scale,...patch.scoring?.scale}}} as any});
    this.record(sessionId,'policy_updated',{policy:updated.policy});
    return updated;
  }
  /** Phases in which a new seat can still be given a well-defined task; anywhere else it would only deadlock. */
  private registrationPhases(session:CollabSession){return session.kind==='scoring'?['nominating']:['draft','implementing','collecting']}
  addParticipant(sessionId:string,body:unknown){
    const input=parse(createParticipantRequest,body),session=this.store.getSession(sessionId);
    // A reviewer registered mid-flight is counted by requiredActors() immediately but has no assignment, which
    // freezes the phase. Registration is therefore limited to the phases where the current task can be handed over.
    if(session.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${session.status}; no new participant can be registered`);
    if(!this.registrationPhases(session).includes(session.phase))
      throw flowError(COLLAB_ERRORS.wrongPhase,session.kind==='scoring'
        // A scoring panel never returns to `nominating` once the rubric is locked, so "wait for the next round"
        // would be advice an operator cannot act on. Repairing the existing seat is the real path.
        ?`A scoring panel is fixed once the rubric is locked (the session is in ${session.phase}). Repair the existing seat instead: POST /participants/{participantId}/binding to hand it to another agent, and POST /participants/{participantId}/budget if it ran out of tokens.`
        :`A participant can only be registered in phase ${this.registrationPhases(session).join('/')}, but the session is in ${session.phase}. Wait for the next round, or rebind an existing seat.`);
    // One agent may not hold two seats: a single model must not be able to vote twice.
    if(this.store.listParticipants(sessionId).some(existing=>existing.agentId===input.agentId))
      throw flowError(COLLAB_ERRORS.conflict,'That agent is already registered in this session');
    const {participant,token}=this.store.createParticipant({sessionId,role:input.role,displayName:input.displayName,model:input.model,agentId:input.agentId,tokenBudget:input.tokenBudget});
    // The hub wakes this agent itself, so it keeps the credential it will hand over.
    this.store.setDispatchToken(participant.participantId,token);
    this.record(sessionId,'participant_added',{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,agentId:participant.agentId,model:participant.model});
    this.assignCurrentTask(session,participant);
    return {participant,token,session};
  }
  /** Hands a late arrival the task the session is currently waiting for, so it never joins without an assignment. */
  private assignCurrentTask(session:CollabSession,participant:Participant){
    const task=session.kind==='scoring'
      ? (session.phase==='nominating'&&participant.role==='reviewer'?'nominate_criteria':undefined)
      : session.phase==='implementing'&&participant.role==='implementer'?'implement'
      : session.phase==='collecting'&&participant.role!=='moderator'&&!(session.policy.implementationFirst&&participant.role==='implementer')
        ?(participant.role==='reviewer'?'file_findings':'file_findings_optional')
      : undefined;
    if(!task)return;
    this.push(session.sessionId,participant.participantId,task,{phase:session.phase,round:session.round});
    this.record(session.sessionId,'task_assigned',{participantId:participant.participantId,task,phase:session.phase,round:session.round});
  }
  /**
   * Hands a seat to another local agent: the bound one crashed, was deleted, or was picked by mistake. Without it
   * the only way out of "that agent will never answer" is to throw the session away. The token is rotated, and any
   * task still queued is re-announced so the dispatcher picks the new agent up immediately.
   */
  rebindParticipant(sessionId:string,participantId:string,body:unknown){
    const input=parse(rebindParticipantRequest,body),session=this.store.getSession(sessionId);
    const current=this.store.getParticipant(participantId);
    if(current.sessionId!==sessionId)throw flowError(COLLAB_ERRORS.participantNotFound,'Participant not found in this session',404);
    if(session.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,'A finished session cannot be rebound');
    const agentId=input.agentId.trim();
    if(this.store.listParticipants(sessionId).some(other=>other.participantId!==participantId&&other.agentId===agentId))
      throw flowError(COLLAB_ERRORS.conflict,'That agent is already registered in this session');
    const {participant,token}=this.store.rebindParticipant(participantId,agentId,input.model);
    this.record(sessionId,'participant_rebound',{participantId,agentId:participant.agentId,previousAgentId:current.agentId,model:participant.model});
    // Whatever this seat owes has to reach the *new* agent, even when the old one was already prompted: a rebind
    // exists precisely because that first delivery led nowhere. An entry that was never delivered is simply
    // re-announced; one that was already acked is queued again for the replacement.
    const undelivered=this.store.listInbox(participantId),history=this.store.listInbox(participantId,true,50);
    const last=undelivered[undelivered.length-1]??history[history.length-1];
    if(last&&session.status==='active'){
      if(!undelivered.length)this.push(sessionId,participantId,last.type,last.payload);
      this.record(sessionId,'task_assigned',{participantId,task:last.type,phase:session.phase,round:session.round,reason:'rebound'});
    }
    return {participant,token};
  }
  /**
   * Raises a participant's token budget and un-blocks a seat that ran out. Available on its own endpoint because
   * an escalation ruling is one-shot: once it is resolved, the exhausted seat would otherwise have no way back.
   */
  raiseParticipantBudget(sessionId:string,participantId:string,body:unknown){
    const input=parse(participantBudgetRequest,body),participant=this.store.getParticipant(participantId);
    if(participant.sessionId!==sessionId)throw flowError(COLLAB_ERRORS.participantNotFound,'Participant not found in this session',404);
    if(input.tokenBudget<=participant.tokensUsed)
      throw new ValidationError([fieldError('tokenBudget','OUT_OF_RANGE',`The new budget must exceed the ${participant.tokensUsed} tokens already spent`)]);
    return this.raiseBudget(participantId,input.tokenBudget);
  }
  private raiseBudget(participantId:string,tokenBudget:number,actor='human'){
    const participant=this.store.getParticipant(participantId);
    const updated=this.store.updateParticipant(participantId,{tokenBudget:Math.round(tokenBudget),state:participant.state==='budget_exhausted'?'active':participant.state});
    this.record(updated.sessionId,'budget_raised',{participantId:updated.participantId,tokenBudget:updated.tokenBudget,tokensUsed:updated.tokensUsed,previousState:participant.state},actor);
    // The seat may be the one the phase is waiting for, and it now has a task it can actually submit.
    for(const item of this.store.listInbox(participantId))
      this.record(updated.sessionId,'task_assigned',{participantId,task:item.type,phase:this.store.getSession(updated.sessionId).phase,round:this.store.getSession(updated.sessionId).round,reason:'budget_raised'});
    return updated;
  }
  /** Moves a review session out of draft. Build-then-review sessions start in `implementing`; the rest go straight to `collecting`. */
  async openRound(sessionId:string){
    const session=this.store.getSession(sessionId);
    if(session.phase!=='draft')throw flowError(COLLAB_ERRORS.wrongPhase,`Round already open: session is in phase ${session.phase}`);
    const participants=this.store.listParticipants(sessionId);
    if(!participants.some(participant=>participant.role==='reviewer'))throw flowError(COLLAB_ERRORS.wrongPhase,'Register at least one reviewer before opening the round');
    const buildFirst=session.policy.implementationFirst;
    if(buildFirst&&!participants.some(participant=>participant.role==='implementer'))throw flowError(COLLAB_ERRORS.wrongPhase,'An implementationFirst session needs an implementer before it can open');
    // Same ordering rule as applyPhase: the baseline exists before anyone can see phase `collecting`.
    if(!buildFirst)await this.captureBaseline({...session,phase:'collecting'});
    const updated=this.store.updateSession(sessionId,{phase:buildFirst?'implementing':'collecting'});
    this.record(sessionId,'phase_changed',{from:'draft',to:updated.phase,round:updated.round,reason:buildFirst?'implementation_started':'round_opened'});
    this.dispatch(sessionId);
    return this.store.getSession(sessionId);
  }
  /**
   * The implementer declares the work ready for review. This is the hand-off that makes the loop automatic:
   * once every implementer has signalled, the hub pins a fresh baseline and calls the reviewers itself.
   */
  async markImplementationReady(participant:Participant,body:unknown){
    const input=parse(readyRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId);
    assertCapability(this.toFlowParticipant(participant),'respond');
    if(participant.role!=='implementer')throw flowError(COLLAB_ERRORS.forbidden,'Only an implementer may declare the implementation ready',403);
    if(session.phase!=='implementing')throw flowError(COLLAB_ERRORS.wrongPhase,`Ready is only accepted in phase implementing, but the session is in ${session.phase}`);
    this.store.markPhaseComplete(session.sessionId,session.round,'implementing',participant.participantId);
    this.record(session.sessionId,'implementation_ready',{participantId:participant.participantId,summary:input.summary,codeRef:input.codeRef,changedFiles:input.changes.length,trigger:'self_reported'},participant.participantId);
    await this.settle(session.sessionId);
    const current=this.store.getSession(session.sessionId);
    const response={accepted:true,phase:current.phase,round:current.round,waitingOn:waitingOn(this.snapshot(session.sessionId))};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    return response;
  }
  /**
   * Called when a pi2web agent settles. A managed implementer that was told to implement and then went idle
   * is treated as ready, which is what makes "the developer finished, call the reviewers" fully automatic.
   * Idle chatter cannot trigger it: the agent must be holding an `implement` task for the current round.
   */
  async noteAgentIdle(agentId:string){
    if(!agentId)return;
    const sessions=this.store.listSessions({status:'active',limit:200}).filter(session=>session.kind==='review'&&session.phase==='implementing'&&session.policy.autoReviewOnAgentIdle);
    for(const session of sessions){
      for(const participant of this.store.listParticipants(session.sessionId)){
        if(participant.agentId!==agentId||participant.role!=='implementer'||participant.state!=='active')continue;
        const done=this.store.listCompletions(session.sessionId).some(entry=>entry.phase==='implementing'&&entry.round===session.round&&entry.participantId===participant.participantId);
        if(done)continue;
        const assigned=this.store.listInbox(participant.participantId,true,50).some(item=>item.type==='implement'&&Number(item.payload.round)===session.round);
        if(!assigned)continue;
        this.store.markPhaseComplete(session.sessionId,session.round,'implementing',participant.participantId);
        this.record(session.sessionId,'implementation_ready',{participantId:participant.participantId,trigger:'agent_idle',agentId},participant.participantId);
        await this.settle(session.sessionId);
      }
    }
  }
  /** The only way to move past participants that never submitted. Everything about the override is logged. */
  async advance(sessionId:string,body:unknown,actor='human'){
    const input=parse(advanceRequest,body),session=this.store.getSession(sessionId);
    if(session.kind==='scoring'){
      const pendingPanel=scoringWaitingOn(this.scoringSnapshot(sessionId));
      if(pendingPanel.length&&!input.force)throw flowError(COLLAB_ERRORS.wrongPhase,`Still waiting on ${pendingPanel.length} panelist(s): ${pendingPanel.join(', ')}. Pass force=true to override.`);
      if(pendingPanel.length&&!input.reason.trim())throw new ValidationError([fieldError('reason','REQUIRED','A forced advance must state why the pending panelists are being skipped')]);
      // Anything else that blocks the panel (no reviewer registered, a question still on the human's desk) has to
      // be reported too: settleScoring() returns quietly, so the operator would get 200 and an unchanged session.
      if(!input.force)nextScoringPhase(this.scoringSnapshot(sessionId));
      await this.settleScoring(sessionId,input.force,input.reason);
      return this.store.getSession(sessionId);
    }
    if(session.phase==='draft')return this.openRound(sessionId);
    const snapshot=this.snapshot(sessionId),pending=waitingOn(snapshot);
    if(pending.length&&!input.force)throw flowError(COLLAB_ERRORS.wrongPhase,`Still waiting on ${pending.length} participant(s): ${pending.join(', ')}. Pass force=true to override.`);
    if(pending.length&&!input.reason.trim())throw new ValidationError([fieldError('reason','REQUIRED','A forced advance must state why the pending participants are being skipped')]);
    const result=nextPhase(snapshot,{forced:input.force});
    await this.applyPhase(session,result,{forced:input.force,reason:input.reason,actor});
    // A forced step may unblock purely automatic phases (consolidating), so let the machine run on.
    await this.settle(sessionId);
    return this.store.getSession(sessionId);
  }
  retryWaiting(sessionId:string,body:unknown={},actor='human'){
    const input=parse(retryWaitingRequest,body),session=this.store.getSession(sessionId),allPending=session.kind==='scoring'?scoringWaitingOn(this.scoringSnapshot(sessionId)):waitingOn(this.snapshot(sessionId));
    const wanted=input.participantIds?.length?new Set(input.participantIds):undefined,pending=allPending.filter(participantId=>!wanted||wanted.has(participantId));
    const participants=this.store.listParticipants(sessionId),busy=pending.filter(participantId=>{const participant=participants.find(entry=>entry.participantId===participantId);return participant&&['starting','streaming','waiting_for_user','stopping'].includes(this.options.agentStatus?.(participant.agentId)??'')});
    const retryable=pending.filter(participantId=>!busy.includes(participantId));
    const baseTask=session.kind==='scoring'?({nominating:'nominate_criteria',voting:'vote_on_criteria',scoring:'score_rubric',debating:'debate_contested_scores',rescoring:'rescore_contested'} as Record<string,string>)[session.phase]
      :({implementing:'implement',collecting:'file_findings',validating:'validate_issues',merge_voting:'vote_on_merges',issue_discussing:'defend_approved_issues',issue_reconsidering:'reconsider_issue_votes',responding:'respond_to_issues',adjudicating:'rule_on_responses'} as Record<string,string>)[session.phase];
    if(!allPending.length)throw flowError(COLLAB_ERRORS.wrongPhase,'Nobody is currently waiting to submit');
    if(!baseTask)throw flowError(COLLAB_ERRORS.wrongPhase,`Phase ${session.phase} has no retryable Agent task`);
    const nonce=this.now();for(const participantId of retryable){const task=`${baseTask}#retry-${nonce}`;this.push(sessionId,participantId,task,{phase:session.phase,round:session.round,retry:true});this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round,retry:true},actor)}
    return {retried:retryable,skippedBusy:busy,phase:session.phase};
  }
  listEscalations(filter:{sessionId?:string,status?:'pending'|'resolved'|'dismissed',limit?:number}={}){return this.store.listEscalations(filter)}
  getEscalation(escalationId:string){return this.store.getEscalation(escalationId)}
  /**
   * A human ruling is terminal. Every escalation kind carries its own structured action:
   * an issue dispute rules on the issue, an exhausted budget can be raised, a deadlock can raise the round cap,
   * and a score dispute is settled by /finalize (which needs one validated ruling per contested criterion).
   */
  async resolveEscalation(escalationId:string,body:unknown,resolvedBy='human'){
    const input=parse(resolveEscalationRequest,body),escalation=this.store.getEscalation(escalationId);
    if(escalation.status!=='pending')throw flowError(COLLAB_ERRORS.conflict,`Escalation is already ${escalation.status}`);
    const session=this.store.getSession(escalation.sessionId);
    // While the session is live /finalize is the only way to settle scores (it validates one ruling per contested
    // criterion). A dispute left pending on a session that already ended can still be closed by hand.
    if(escalation.kind==='score_dispute'&&session.status==='active')
      throw flowError(COLLAB_ERRORS.wrongPhase,`A score dispute is settled by POST /api/v1/collab/sessions/${escalation.sessionId}/finalize with one ruling per contested criterion; that call resolves this escalation.`);
    const extra=(input.extra??{}) as Record<string,unknown>;
    // Validate the remedy *before* the escalation is marked resolved: a ruling is one-shot, so a payload that
    // would silently apply nothing (missing field, "600000" as a string, a cap that is not higher) must 422
    // instead of consuming the only remedy the human has.
    const errors:FieldError[]=[];
    let budgetTarget:Participant|undefined,tokenBudget=0;
    if('tokenBudget' in extra||escalation.kind==='budget_exhausted'&&extra.tokenBudget!==undefined){
      budgetTarget=escalation.kind==='budget_exhausted'&&escalation.refId?this.store.getParticipant(escalation.refId):undefined;
      if(!budgetTarget)errors.push(fieldError('extra.tokenBudget','UNEXPECTED','Only a budget_exhausted escalation can raise a token budget'));
      else if(typeof extra.tokenBudget!=='number'||!Number.isFinite(extra.tokenBudget))errors.push(fieldError('extra.tokenBudget','NOT_A_NUMBER','extra.tokenBudget must be a number, not a string'));
      else if(extra.tokenBudget<=budgetTarget.tokensUsed)errors.push(fieldError('extra.tokenBudget','OUT_OF_RANGE',`The new budget must exceed the ${budgetTarget.tokensUsed} tokens already spent`));
      else tokenBudget=Math.round(extra.tokenBudget);
    }
    let maxTotalRounds=0;
    if('maxTotalRounds' in extra){
      if(typeof extra.maxTotalRounds!=='number'||!Number.isFinite(extra.maxTotalRounds))errors.push(fieldError('extra.maxTotalRounds','NOT_A_NUMBER','extra.maxTotalRounds must be a number, not a string'));
      else if(extra.maxTotalRounds<=session.policy.maxTotalRounds)errors.push(fieldError('extra.maxTotalRounds','OUT_OF_RANGE',`The new cap must exceed the current ${session.policy.maxTotalRounds} rounds`));
      else maxTotalRounds=Math.min(50,Math.round(extra.maxTotalRounds));
    }
    if(escalation.kind==='issue_dispute'&&escalation.refId&&!input.issueDecision)
      errors.push(fieldError('issueDecision','REQUIRED','An issue dispute must say what happens to the issue (resolved/wontfix/closed/reopen)'));
    if(errors.length)throw new ValidationError(errors);
    const applied:string[]=[];
    if(escalation.kind==='issue_dispute'&&escalation.refId&&input.issueDecision){
      const issue=this.store.getIssue(escalation.refId),outcome=applyHumanRuling(this.toFlowIssue(issue),input.issueDecision);
      this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round});
      if(input.issueDecision==='reopen'&&session.policy.consensusReview)for(const reviewer of this.store.listParticipants(session.sessionId).filter(entry=>entry.role==='reviewer'&&entry.state!=='left'))this.store.saveIssueVote({sessionId:session.sessionId,issueId:issue.issueId,participantId:reviewer.participantId,round:session.round,consensusRound:session.debateRound+1,stance:'approve',rationale:`Human ruled this a valid issue: ${input.rationale}`});
      this.store.addIssueMessage(issue.issueId,outcome.round,resolvedBy,'ruling',{decision:input.decision,rationale:input.rationale,issueDecision:input.issueDecision});
      this.record(escalation.sessionId,'issue_ruled',{issueId:issue.issueId,status:outcome.status,decision:input.issueDecision},resolvedBy);
      applied.push(`issue:${input.issueDecision}`);
    }
    // "raise budget": without applying it the participant stays blocked and the phase never moves.
    if(budgetTarget&&tokenBudget){
      const updated=this.raiseBudget(budgetTarget.participantId,tokenBudget,resolvedBy);
      applied.push(`tokenBudget:${updated.tokenBudget}`);
    }
    // "raise the round cap": the deadlock escalation is only useful if the new cap actually takes effect.
    if(maxTotalRounds){
      const policy={...session.policy,maxTotalRounds};
      this.store.updateSession(session.sessionId,{policy});
      this.record(escalation.sessionId,'policy_updated',{policy},resolvedBy);
      applied.push(`maxTotalRounds:${maxTotalRounds}`);
    }
    const resolved=this.store.resolveEscalation(escalationId,{decision:input.decision,rationale:input.rationale,issueDecision:input.issueDecision,extra:input.extra,applied},resolvedBy);
    // `applied` is on the event so the board can show what a ruling actually changed, not just what it said.
    this.record(escalation.sessionId,'escalation_resolved',{escalationId,kind:escalation.kind,decision:input.decision,rationale:input.rationale,applied},resolvedBy);
    // A scoring session must be settled by the scoring machine; running the review machine on it moves
    // `awaiting_human` into the review-only `adjudicating` phase.
    if(session.kind==='scoring')await this.settleScoring(escalation.sessionId);
    else await this.settle(escalation.sessionId);
    return resolved;
  }

  // ---------------------------------------------------------------- participant operations
  authenticate(token:string):Participant{
    const participant=token?this.store.findParticipantByToken(token):undefined;
    if(!participant)throw flowError(COLLAB_ERRORS.forbidden,'Unknown participant token',401);
    return this.store.updateParticipant(participant.participantId,{lastSeenAt:new Date(this.now()).toISOString()});
  }

  async submitFindings(participant:Participant,body:unknown){
    const input=parse(findingsRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCanFileFinding(snapshot,participant.participantId);
    const baseline=this.store.getBaselineForRound(session.sessionId,session.round);
    if(!baseline)throw flowError(COLLAB_ERRORS.wrongPhase,'No baseline has been captured for this round yet');
    if(input.baselineId!==baseline.baselineId)throw Object.assign(flowError(COLLAB_ERRORS.staleBaseline,`Findings target baseline ${input.baselineId}, but the current baseline is ${baseline.baselineId}. Re-read the code and resubmit.`),{currentBaseline:baseline});
    const participants=this.store.listParticipants(session.sessionId);
    const defaultTarget=participants.find(entry=>entry.role==='implementer');
    const accepted:{externalId?:string,issueId:string}[]=[],rejected:{externalId?:string,code:string,message:string}[]=[];
    for(const finding of input.findings){
      const targetId=finding.targetParticipantId??defaultTarget?.participantId;
      if(!targetId){rejected.push({externalId:finding.externalId,code:'NO_TARGET',message:'This session has no implementer; set targetParticipantId explicitly'});continue}
      if(targetId===participant.participantId){rejected.push({externalId:finding.externalId,code:'SELF_TARGET',message:'A finding cannot be addressed to its own reporter'});continue}
      if(!participants.some(entry=>entry.participantId===targetId)){rejected.push({externalId:finding.externalId,code:COLLAB_ERRORS.participantNotFound,message:`Unknown targetParticipantId ${targetId}`});continue}
      const issue=this.store.createIssue({sessionId:session.sessionId,externalId:finding.externalId,reporterId:participant.participantId,targetParticipantId:targetId,
        title:finding.title,severity:finding.severity,category:finding.category,requiredAction:finding.requiredAction,confidence:finding.confidence,
        location:finding.location,evidence:finding.evidence,impact:finding.impact,suggestion:finding.suggestion,baselineId:baseline.baselineId,round:session.round});
      accepted.push({externalId:finding.externalId,issueId:issue.issueId});
      this.record(session.sessionId,'issue_opened',{issueId:issue.issueId,title:issue.title,severity:issue.severity,targetParticipantId:targetId},participant.participantId);
    }
    if(input.reviewComplete)this.store.markPhaseComplete(session.sessionId,session.round,'collecting',participant.participantId);
    const duplicates=this.possibleDuplicates(session.sessionId,accepted.map(entry=>entry.issueId),participant);
    const response={accepted,rejected,possibleDuplicates:duplicates,reviewComplete:input.reviewComplete,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'findings_submitted',{count:accepted.length,rejected:rejected.length,reviewComplete:input.reviewComplete},participant.participantId);
    await this.settle(session.sessionId);
    return response;
  }

  async submitIssueVotes(participant:Participant,body:unknown){
    const input=parse(issueVotesRequest,body),cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCapability(this.toFlowParticipant(participant),'vote');
    if(!['validating','issue_reconsidering'].includes(session.phase))throw flowError(COLLAB_ERRORS.wrongPhase,`Issue votes are only accepted in validating or issue_reconsidering, but the session is in ${session.phase}`);
    const consensus=issueConsensus(snapshot),expected=session.phase==='validating'
      ?this.store.listIssues(session.sessionId,{status:['open']}).filter(issue=>issue.reporterId!==participant.participantId).map(issue=>issue.issueId)
      :consensus.filter(entry=>entry.rejecters.includes(participant.participantId)).map(entry=>entry.issueId);
    const submitted=input.votes.map(vote=>vote.issueId),errors:FieldError[]=[];
    for(const issueId of expected)if(!submitted.includes(issueId))errors.push(fieldError('votes','REQUIRED',`A vote for issue ${issueId} is required`));
    for(const [index,vote] of input.votes.entries()){
      if(!expected.includes(vote.issueId))errors.push(fieldError(`votes[${index}].issueId`,'UNEXPECTED',`You do not owe a vote for ${vote.issueId}`));
      if(submitted.indexOf(vote.issueId)!==index)errors.push(fieldError(`votes[${index}].issueId`,'DUPLICATE','Only one vote per issue is accepted'));
      if(vote.stance==='reject'&&(vote.rationale??'').trim().length<20)errors.push(fieldError(`votes[${index}].rationale`,'REQUIRED','Rejecting an issue requires a rationale of at least 20 characters'));
    }
    if(session.phase!=='validating'&&input.mergeProposals.length)errors.push(fieldError('mergeProposals','WRONG_PHASE','Merge proposals are only accepted during initial issue validation'));
    if(errors.length)throw new ValidationError(errors);
    for(const vote of input.votes)this.store.saveIssueVote({sessionId:session.sessionId,issueId:vote.issueId,participantId:participant.participantId,round:session.round,consensusRound:session.phase==='validating'?0:session.debateRound,stance:vote.stance,rationale:vote.rationale});
    const proposalIds:string[]=[];
    for(const proposal of input.mergeProposals){
      const issueIds=[...new Set(proposal.issueIds)];
      if(issueIds.length<2||issueIds.some(issueId=>!this.store.findIssueInSession(session.sessionId,issueId)))throw new ValidationError([fieldError('mergeProposals','UNKNOWN_ISSUE','Every merge proposal needs at least two issues from this session')]);
      proposalIds.push(this.store.createMergeProposal({sessionId:session.sessionId,round:session.round,issueIds,participantId:participant.participantId,rationale:proposal.rationale}).proposalId);
    }
    if(input.complete)this.store.markPhaseComplete(session.sessionId,session.round,session.phase==='issue_reconsidering'?`issue_reconsidering:${session.debateRound}`:session.phase,participant.participantId);
    const response={accepted:submitted,mergeProposals:proposalIds,complete:input.complete,consensusRound:session.debateRound};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'issue_votes_submitted',{count:submitted.length,mergeProposals:proposalIds,phase:session.phase,consensusRound:session.debateRound},participant.participantId);
    await this.settle(session.sessionId);return response;
  }

  async submitMergeVotes(participant:Participant,body:unknown){
    const input=parse(mergeVotesRequest,body),cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCapability(this.toFlowParticipant(participant),'merge');
    if(session.phase!=='merge_voting')throw flowError(COLLAB_ERRORS.wrongPhase,`Merge votes are only accepted in phase merge_voting, but the session is in ${session.phase}`);
    const proposals=(snapshot.mergeProposals??[]).filter(proposal=>proposal.round===session.round),expected=proposals.filter(proposal=>!proposal.votes.some(vote=>vote.participantId===participant.participantId)).map(proposal=>proposal.proposalId),submitted=input.votes.map(vote=>vote.proposalId),errors:FieldError[]=[];
    for(const proposalId of expected)if(!submitted.includes(proposalId))errors.push(fieldError('votes','REQUIRED',`A vote for merge proposal ${proposalId} is required`));
    for(const [index,vote] of input.votes.entries()){
      if(!expected.includes(vote.proposalId))errors.push(fieldError(`votes[${index}].proposalId`,'UNEXPECTED',`You do not owe a vote for ${vote.proposalId}`));
      if(vote.stance==='reject'&&(vote.rationale??'').trim().length<20)errors.push(fieldError(`votes[${index}].rationale`,'REQUIRED','Rejecting a merge requires a rationale of at least 20 characters'));
    }
    if(errors.length)throw new ValidationError(errors);
    for(const vote of input.votes)this.store.saveMergeVote({proposalId:vote.proposalId,participantId:participant.participantId,stance:vote.stance,rationale:vote.rationale});
    if(input.complete)this.store.markPhaseComplete(session.sessionId,session.round,'merge_voting',participant.participantId);
    const response={accepted:submitted,complete:input.complete};this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'merge_votes_submitted',{count:submitted.length},participant.participantId);await this.settle(session.sessionId);return response;
  }

  async submitIssueDiscussions(participant:Participant,body:unknown){
    const input=parse(issueDiscussionsRequest,body),cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCapability(this.toFlowParticipant(participant),'debate');
    if(session.phase!=='issue_discussing')throw flowError(COLLAB_ERRORS.wrongPhase,`Issue discussions are only accepted in phase issue_discussing, but the session is in ${session.phase}`);
    const expected=issueConsensus(snapshot).filter(entry=>entry.rejecters.length&&entry.supporters.includes(participant.participantId)).map(entry=>entry.issueId),submitted=input.discussions.map(entry=>entry.issueId),errors:FieldError[]=[];
    for(const issueId of expected)if(!submitted.includes(issueId))errors.push(fieldError('discussions','REQUIRED',`A supporter argument for issue ${issueId} is required`));
    for(const [index,entry] of input.discussions.entries())if(!expected.includes(entry.issueId))errors.push(fieldError(`discussions[${index}].issueId`,'UNEXPECTED',`You are not currently a supporter of ${entry.issueId}`));
    if(errors.length)throw new ValidationError(errors);
    for(const entry of input.discussions)this.store.addIssueMessage(entry.issueId,session.round,participant.participantId,'discussion',{argument:entry.argument,respondingTo:entry.respondingTo,consensusRound:session.debateRound});
    if(input.complete)this.store.markPhaseComplete(session.sessionId,session.round,`issue_discussing:${session.debateRound}`,participant.participantId);
    const response={accepted:submitted,complete:input.complete,consensusRound:session.debateRound};this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'issue_discussions_submitted',{count:submitted.length,consensusRound:session.debateRound},participant.participantId);await this.settle(session.sessionId);return response;
  }

  async submitResponses(participant:Participant,body:unknown){
    const input=parse(responsesRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId);
    assertCapability(this.toFlowParticipant(participant),'respond');
    if(session.phase!=='responding')throw flowError(COLLAB_ERRORS.wrongPhase,`Responses are only accepted in phase responding, but the session is in ${session.phase}`);
    const baseline=this.store.getBaselineForRound(session.sessionId,session.round);
    const errors:FieldError[]=[];
    input.responses.forEach((entry,index)=>errors.push(...responseFieldErrors(entry,index)));
    if(errors.length)throw new ValidationError(errors);
    const accepted:{issueId:string,status:string}[]=[],rejected:{issueId:string,code:string,message:string}[]=[];
    for(const entry of input.responses){
      const issue=this.store.findIssueInSession(session.sessionId,entry.issueId);
      if(!issue){rejected.push({issueId:entry.issueId,code:COLLAB_ERRORS.issueNotFound,message:'Issue not found in this session'});continue}
      // "I fixed it" without any code change is the most common failure mode; reject it outright.
      if(['fixed','partially_fixed'].includes(entry.responseType)&&baseline&&entry.codeRef&&(entry.codeRef.commit??null)===(baseline.commit??null)&&(entry.codeRef.dirtyHash??null)===(baseline.dirtyHash??null)){
        rejected.push({issueId:entry.issueId,code:COLLAB_ERRORS.noCodeChange,message:'codeRef is identical to the reviewed baseline, so nothing changed'});continue;
      }
      try{
        const outcome=applyResponse({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant),responseType:entry.responseType,policy:session.policy});
        this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round},entry.expectedVersion);
        this.store.addIssueMessage(issue.issueId,outcome.round,participant.participantId,'response',entry as unknown as Record<string,unknown>);
        accepted.push({issueId:issue.issueId,status:outcome.status});
        this.record(session.sessionId,'issue_answered',{issueId:issue.issueId,responseType:entry.responseType},participant.participantId);
      }catch(error){rejected.push({issueId:entry.issueId,code:(error as any).code??'BAD_REQUEST',message:(error as Error).message})}
    }
    const response={accepted,rejected,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    await this.settle(session.sessionId);
    return response;
  }

  async submitVerdicts(participant:Participant,body:unknown){
    const input=parse(verdictsRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId);
    assertCapability(this.toFlowParticipant(participant),'verdict');
    if(session.phase!=='adjudicating')throw flowError(COLLAB_ERRORS.wrongPhase,`Verdicts are only accepted in phase adjudicating, but the session is in ${session.phase}`);
    const errors:FieldError[]=[];
    input.verdicts.forEach((entry,index)=>{if(['reject','escalate','needs_info'].includes(entry.verdict)&&(entry.rationale??'').trim().length<30)errors.push(fieldError(`verdicts[${index}].rationale`,'REQUIRED',`A ${entry.verdict} verdict must explain itself in at least 30 characters`))});
    if(errors.length)throw new ValidationError(errors);
    const accepted:{issueId:string,status:string}[]=[],rejected:{issueId:string,code:string,message:string}[]=[];
    for(const entry of input.verdicts){
      const issue=this.store.findIssueInSession(session.sessionId,entry.issueId);
      if(!issue){rejected.push({issueId:entry.issueId,code:COLLAB_ERRORS.issueNotFound,message:'Issue not found in this session'});continue}
      try{
        const outcome=applyVerdict({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant),verdict:entry.verdict,policy:session.policy});
        this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round},entry.expectedVersion);
        this.store.addIssueMessage(issue.issueId,outcome.round,participant.participantId,'verdict',entry as unknown as Record<string,unknown>);
        if(outcome.escalate)this.raiseIssueEscalation(session,issue,participant,outcome.escalateReason??'disputed',entry.rationale??'');
        accepted.push({issueId:issue.issueId,status:outcome.status});
        this.record(session.sessionId,'issue_ruled',{issueId:issue.issueId,verdict:entry.verdict,status:outcome.status},participant.participantId);
      }catch(error){rejected.push({issueId:entry.issueId,code:(error as any).code??'BAD_REQUEST',message:(error as Error).message})}
    }
    const response={accepted,rejected,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    await this.settle(session.sessionId);
    return response;
  }

  async withdrawIssue(participant:Participant,issueId:string){
    const session=this.store.getSession(participant.sessionId),issue=this.store.findIssueInSession(session.sessionId,issueId);
    if(!issue)throw flowError(COLLAB_ERRORS.issueNotFound,'Issue not found in this session',404);
    const outcome=applyWithdraw({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant)});
    const updated=this.store.updateIssue(issue.issueId,{status:outcome.status});
    this.record(session.sessionId,'issue_withdrawn',{issueId:issue.issueId},participant.participantId);
    await this.settle(session.sessionId);
    return updated;
  }

  /** Anyone in the dispute may hand it to a human. The session keeps working on everything else. */
  async raiseEscalation(participant:Participant,body:unknown):Promise<Escalation>{
    const input=parse(escalationRequest,body);
    const cached=this.replay<Escalation>(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId);
    assertCapability(this.toFlowParticipant(participant),'escalate');
    if(input.refId){
      const issue=this.store.findIssueInSession(session.sessionId,input.refId);
      if(!issue)throw flowError(COLLAB_ERRORS.issueNotFound,'Issue not found in this session',404);
      const consensusPhase=['validating','merge_voting','issue_discussing','issue_reconsidering'].includes(session.phase);
      if(consensusPhase&&participant.role==='reviewer')this.store.updateIssue(issue.issueId,{status:'escalated'});
      else{
        const outcome=applyEscalation({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant)});
        this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round});
      }
    }
    const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:input.kind,refId:input.refId,raisedBy:participant.participantId,
      summary:input.summary,positions:input.positions,question:input.question,options:input.options,urgency:input.urgency});
    this.finish(participant,input.clientRequestId,body,input.usage,escalation);
    this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:escalation.kind,refId:escalation.refId,question:escalation.question,urgency:escalation.urgency},participant.participantId);
    // Settling with the wrong machine is not a no-op: the review flow throws `Phase nominating cannot advance`
    // on a scoring session, so the escalation was persisted and the request still failed.
    if(session.kind==='scoring')await this.settleScoring(session.sessionId);
    else await this.settle(session.sessionId);
    return escalation;
  }

  /** Role-specific task package: exactly what this participant owes right now, and nothing else. */
  digest(participant:Participant):Record<string,unknown>{
    const session=this.store.getSession(participant.sessionId);
    if(session.kind==='scoring')return this.scoringDigest(participant);
    const snapshot=this.snapshot(session.sessionId);
    const baseline=this.store.getBaselineForRound(session.sessionId,session.round);
    const base={sessionId:session.sessionId,kind:session.kind,title:session.title,phase:session.phase,round:session.round,subject:session.subject,
      baseline,you:{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,tokensUsed:participant.tokensUsed,tokenBudget:participant.tokenBudget,state:participant.state},
      progress:sessionProgress(snapshot),stalled:session.stalled};
    if(session.phase==='implementing'){
      if(participant.role!=='implementer')return {...base,task:'wait',instructions:'The implementer is still working. You will be called as soon as the code is ready for review.'};
      const carried=this.store.listIssues(session.sessionId,{targetParticipantId:participant.participantId,status:['open']});
      return {...base,task:'implement',issues:carried.map(issue=>this.withHistory(issue)),
        instructions:`Do the implementation work in ${session.cwd}. When it is finished, POST /api/v1/collab/sessions/${session.sessionId}/ready with a summary, the changed files and a codeRef (commit or dirtyHash), then end your turn. The hub pins a baseline at that moment, calls the reviewers itself, and pushes their findings back to you: never sleep or poll waiting for the review.`};
    }
    if(session.phase==='collecting'){
      const own=this.store.listIssues(session.sessionId,{reporterId:participant.participantId,round:session.round});
      const required=participant.role==='reviewer';
      return {...base,task:required?'file_findings':'file_findings_optional',yourFindings:own,
        instructions:`Review the code at the pinned baseline and POST every finding to /api/v1/collab/sessions/${session.sessionId}/findings with baselineId="${baseline?.baselineId??''}". Set reviewComplete=true on your final call. location.path and evidence are mandatory.`};
    }
    if(session.phase==='validating'){
      const all=this.store.listIssues(session.sessionId,{status:['open']}),owed=all.filter(issue=>issue.reporterId!==participant.participantId);
      return {...base,task:'validate_issues',issues:all.map(issue=>this.withHistory(issue)),yourRequiredIssueIds:owed.map(issue=>issue.issueId),currentVotes:currentIssueVotes(snapshot),mergeProposals:this.store.listMergeProposals(session.sessionId),
        instructions:`All reviewers have finished the blind review. Read every issue, then POST one approve/reject vote for every issue you did not report to /api/v1/collab/sessions/${session.sessionId}/issue-votes. A reject needs a rationale. Include any duplicate groups in mergeProposals; the hub collects all proposals before a separate unanimous merge vote.`};
    }
    if(session.phase==='merge_voting'){
      const proposals=this.store.listMergeProposals(session.sessionId),owed=proposals.filter(proposal=>!proposal.votes.some(vote=>vote.participantId===participant.participantId));
      return {...base,task:owed.length?'vote_on_merges':'wait',mergeProposals:proposals,yourRequiredProposalIds:owed.map(entry=>entry.proposalId),
        instructions:`Vote on every merge proposal you did not make via POST /api/v1/collab/sessions/${session.sessionId}/merge-votes. A merge is applied only with approval from every reviewer; rejecting requires a rationale.`};
    }
    if(session.phase==='issue_discussing'){
      const consensus=issueConsensus(snapshot),owed=consensus.filter(entry=>entry.rejecters.length&&entry.supporters.includes(participant.participantId));
      return {...base,task:owed.length?'defend_approved_issues':'wait',consensus,issues:owed.map(entry=>this.withHistory(this.store.getIssue(entry.issueId))),
        instructions:`Some reviewers rejected these issues. As a current supporter, answer each rejection with evidence via POST /api/v1/collab/sessions/${session.sessionId}/issue-discussions, then end your turn. If you are the reporter and no longer stand by an issue, do not merely say "withdraw" in prose: POST /issues/{issueId}/withdraw. Any reviewer may POST /escalations with refId to request human intervention before all ${session.policy.maxConsensusRounds} rounds finish.`};
    }
    if(session.phase==='issue_reconsidering'){
      const consensus=issueConsensus(snapshot),owed=consensus.filter(entry=>entry.rejecters.includes(participant.participantId));
      return {...base,task:owed.length?'reconsider_issue_votes':'wait',consensus,issues:owed.map(entry=>this.withHistory(this.store.getIssue(entry.issueId))),
        instructions:`Read the supporters' latest discussion, then POST a revised approve/reject vote for every issue you currently reject to /api/v1/collab/sessions/${session.sessionId}/issue-votes. Keeping reject still requires a rationale. If human judgment is needed now, POST /escalations with the issue refId instead of waiting for all ${session.policy.maxConsensusRounds} rounds.`};
    }
    if(session.phase==='responding'){
      const mine=this.store.listIssues(session.sessionId,{targetParticipantId:participant.participantId,status:['open']});
      return {...base,task:mine.length?'respond_to_issues':'wait',issues:mine.map(issue=>this.withHistory(issue)),
        instructions:`Respond to every issue addressed to you via POST /api/v1/collab/sessions/${session.sessionId}/responses. Use responseType "rejected" with a rationale if you disagree; only the reporter can close an issue.`};
    }
    if(session.phase==='adjudicating'){
      const mine=this.store.listIssues(session.sessionId,{reporterId:participant.participantId,status:['answered']});
      return {...base,task:mine.length?'rule_on_responses':'wait',issues:mine.map(issue=>this.withHistory(issue)),
        instructions:`Rule on each response via POST /api/v1/collab/sessions/${session.sessionId}/verdicts. Accept closes the issue, reject reopens it for another round, escalate hands it to a human.`};
    }
    return {...base,task:'wait',instructions:session.phase==='awaiting_human'?'A human ruling is pending. Do not resubmit and do not poll; you will be prompted when it is your turn again.':'Nothing is required from you right now. End your turn; the hub prompts you when something needs you.'};
  }

  reviewConsensus(sessionId:string,viewer?:Participant){
    const session=this.store.getSession(sessionId),snapshot=this.snapshot(sessionId);
    if(viewer&&session.phase==='collecting')throw flowError(COLLAB_ERRORS.forbidden,'Consensus data stays sealed until every reviewer finishes collection',403);
    return {phase:session.phase,round:session.round,consensusRound:session.debateRound,issueVotes:this.store.listIssueVotes(sessionId),issueConsensus:issueConsensus(snapshot),mergeProposals:this.store.listMergeProposals(sessionId),discussions:this.store.listIssues(sessionId).flatMap(issue=>this.store.listIssueMessages(issue.issueId).filter(message=>message.kind==='discussion'))};
  }

  /** Blind review: while findings are being collected, a participant only sees their own. */
  listIssues(participant:Participant){
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    const issues=this.store.listIssues(session.sessionId);
    if(canSeeOthersFindings(snapshot))return issues;
    return issues.filter(issue=>issue.reporterId===participant.participantId||issue.targetParticipantId===participant.participantId);
  }
  /**
   * Event history. A participant token may read the timeline, but not through it: while a phase is sealed the
   * payload of somebody else's submission is withheld, otherwise `blindFindings` could be defeated by
   * reading `issue_opened` (title, severity, target) out of the log.
   */
  events(sessionId:string,since=0,limit=500,viewer?:Participant){return this.redactEvents(sessionId,this.store.listEvents(sessionId,since,limit),viewer)}
  /** Tail of the timeline. The board needs the *latest* events; paging from sequence 0 stops showing new ones. */
  recentEvents(sessionId:string,limit=200,viewer?:Participant){return this.redactEvents(sessionId,this.store.listRecentEvents(sessionId,limit),viewer)}
  private redactEvents(sessionId:string,events:CollabEvent[],viewer?:Participant):CollabEvent[]{
    if(!viewer)return events;
    const session=this.store.getSession(sessionId);
    const sealed=new Set<string>();
    if(session.kind==='review'){
      if(!canSeeOthersFindings(this.snapshot(sessionId)))for(const type of ['issue_opened','findings_submitted'])sealed.add(type);
    }else{
      const snapshot=this.scoringSnapshot(sessionId);
      if(nominationsSealed(snapshot))sealed.add('criteria_nominated');
      if(votesSealed(snapshot))sealed.add('criteria_voted');
      if(scoresSealed(snapshot))sealed.add('scores_submitted');
    }
    if(!sealed.size)return events;
    // The event itself stays visible so sequence numbers remain a usable cursor; only its content is withheld.
    return events.map(event=>sealed.has(event.type)&&event.actorId!==viewer.participantId
      ?{...event,payload:{redacted:true,reason:'sealed_until_the_phase_closes'}}:event);
  }
  progress(sessionId:string){return this.store.getSession(sessionId).kind==='scoring'?scoringProgress(this.scoringSnapshot(sessionId)):sessionProgress(this.snapshot(sessionId))}
  /** Same blindness rule as listIssues(): a sealed finding must not be readable through its id either. */
  issueDetail(sessionId:string,issueId:string,viewer?:Participant){
    const issue=this.store.findIssueInSession(sessionId,issueId);
    if(!issue||(viewer&&!this.canSeeIssue(sessionId,issue,viewer)))throw flowError(COLLAB_ERRORS.issueNotFound,'Issue not found in this session',404);
    return this.withHistory(issue);
  }
  /** A participant may read an issue it filed or one addressed to it; everything else waits for the seal to lift. */
  private canSeeIssue(sessionId:string,issue:Issue,viewer:Participant){
    return issue.reporterId===viewer.participantId||issue.targetParticipantId===viewer.participantId||canSeeOthersFindings(this.snapshot(sessionId));
  }

  // ---------------------------------------------------------------- scoring session operations
  /** Blind nomination: a participant only sees its own proposals until the panel finishes. */
  async submitNominations(participant:Participant,body:unknown){
    const input=parse(nominationsRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    assertScoringCapability(this.toFlowParticipant(participant),'nominate');
    assertScoringPhase(snapshot,['nominating'],'Nominating criteria');
    const accepted=input.nominations.map(nomination=>{
      const criterion=this.store.createCriterion({sessionId:session.sessionId,name:nomination.name,definition:nomination.definition,
        anchors:nomination.anchors as Record<string,string>|undefined,weight:nomination.weightSuggestion,
        source:{participantId:participant.participantId,externalId:nomination.externalId,rationale:nomination.rationale},round:session.round});
      return {externalId:nomination.externalId,criterionId:criterion.criterionId,name:criterion.name};
    });
    if(input.nominationsComplete)this.store.markPhaseComplete(session.sessionId,session.round,'nominating',participant.participantId);
    const response={accepted,round:session.round,nominationsComplete:input.nominationsComplete};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'criteria_nominated',{count:accepted.length,complete:input.nominationsComplete},participant.participantId);
    await this.settleScoring(session.sessionId);
    return response;
  }

  async submitVotes(participant:Participant,body:unknown){
    const input=parse(votesRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    assertScoringCapability(this.toFlowParticipant(participant),'vote');
    assertScoringPhase(snapshot,['voting'],'Voting on criteria');
    const accepted:string[]=[],rejected:{criterionId:string,code:string,message:string}[]=[];
    for(const vote of input.votes){
      const criterion=this.store.findCriterionInSession(session.sessionId,vote.criterionId);
      if(!criterion||criterion.state!=='candidate'){rejected.push({criterionId:vote.criterionId,code:COLLAB_ERRORS.criterionNotFound,message:'Unknown or already decided criterion'});continue}
      if(vote.stance==='reject'&&!(vote.rationale??'').trim()){rejected.push({criterionId:vote.criterionId,code:'RATIONALE_REQUIRED',message:'Rejecting a criterion requires a rationale'});continue}
      this.store.saveVote({sessionId:session.sessionId,criterionId:vote.criterionId,participantId:participant.participantId,round:session.round,stance:vote.stance,weight:vote.weight,amendment:vote.amendment,rationale:vote.rationale});
      accepted.push(vote.criterionId);
    }
    const response={accepted,rejected,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'criteria_voted',{count:accepted.length},participant.participantId);
    await this.settleScoring(session.sessionId);
    return response;
  }

  async submitScores(participant:Participant,body:unknown){
    const input=parse(scoresRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    assertScoringCapability(this.toFlowParticipant(participant),'score');
    assertScoringPhase(snapshot,['scoring','rescoring'],'Scoring');
    const {scale}=session.policy.scoring,round=snapshot.phase==='rescoring'?session.debateRound+1:session.debateRound;
    const errors:FieldError[]=[];
    input.scores.forEach((entry,index)=>{
      if(entry.score<scale.min||entry.score>scale.max)errors.push(fieldError(`scores[${index}].score`,'OUT_OF_RANGE',`Score must be between ${scale.min} and ${scale.max}`));
      const quotient=(entry.score-scale.min)/scale.step;
      if(Math.abs(quotient-Math.round(quotient))>1e-9)errors.push(fieldError(`scores[${index}].score`,'NOT_A_MULTIPLE',`Score must be a multiple of ${scale.step}`));
      if(!entry.evidence.every(item=>item.path?.trim()))errors.push(fieldError(`scores[${index}].evidence`,'EVIDENCE_REQUIRED','Every evidence entry must reference a file path'));
      // A revised score has to say why it moved, otherwise a debate just produces silent herding.
      if(snapshot.phase==='rescoring'&&!(entry.changeReason??'').trim())errors.push(fieldError(`scores[${index}].changeReason`,'REQUIRED','A rescore must state why the score changed or why it stayed'));
    });
    if(errors.length)throw new ValidationError(errors);
    const accepted:string[]=[],rejected:{criterionId:string,code:string,message:string}[]=[];
    for(const entry of input.scores){
      const criterion=this.store.findCriterionInSession(session.sessionId,entry.criterionId);
      if(!criterion||criterion.state!=='approved'){rejected.push({criterionId:entry.criterionId,code:COLLAB_ERRORS.criterionNotFound,message:'Criterion is not part of the locked rubric'});continue}
      this.store.saveScore({sessionId:session.sessionId,criterionId:entry.criterionId,participantId:participant.participantId,round,score:entry.score,rationale:entry.rationale,evidence:entry.evidence,confidence:entry.confidence,changeReason:entry.changeReason});
      accepted.push(entry.criterionId);
    }
    const response={accepted,rejected,round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'scores_submitted',{count:accepted.length,round},participant.participantId);
    await this.settleScoring(session.sessionId);
    return response;
  }

  async submitDebateArgument(participant:Participant,debateId:string,body:unknown){
    const input=parse(debateArgumentRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    // The party under review may only clarify facts; it must not argue for a score.
    assertScoringCapability(this.toFlowParticipant(participant),participant.role==='implementer'?'clarify':'debate');
    if(participant.role==='implementer'&&input.stance!=='clarify')throw flowError(COLLAB_ERRORS.forbidden,'The implementer may only contribute clarifications, not scoring positions',403);
    assertScoringPhase(snapshot,['debating'],'Debating');
    const debate=this.store.findDebateInSession(session.sessionId,debateId);
    if(!debate||debate.status!=='open')throw flowError(COLLAB_ERRORS.debateNotFound,'Debate not found or already closed',404);
    const argumentId=this.store.addDebateArgument(debateId,{participantId:participant.participantId,stance:input.stance,argument:input.argument,evidence:input.evidence,respondingTo:input.respondingTo});
    const response={argumentId,debateId,criterionId:debate.criterionId};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'debate_argument',{debateId,criterionId:debate.criterionId,stance:input.stance},participant.participantId);
    await this.settleScoring(session.sessionId);
    return response;
  }

  /** Sealed until everyone has committed, so nobody can anchor on someone else's number. */
  analysis(sessionId:string,viewer?:Participant){
    const snapshot=this.scoringSnapshot(sessionId);
    if(viewer&&scoresSealed(snapshot))throw flowError(COLLAB_ERRORS.scoresSealed,'Scores stay sealed until every panelist has submitted',403);
    return {phase:snapshot.phase,round:snapshot.round,debateRound:snapshot.debateRound,criteria:analyse(snapshot),contested:contestedCriteria(snapshot).map(entry=>entry.criterionId)};
  }
  criteria(sessionId:string,viewer?:Participant){
    const snapshot=this.scoringSnapshot(sessionId),all=this.store.listCriteria(sessionId);
    if(!viewer)return all;
    if(nominationsSealed(snapshot))return all.filter(criterion=>(criterion.source as any)?.participantId===viewer.participantId);
    return all;
  }
  votes(sessionId:string,viewer?:Participant){
    const snapshot=this.scoringSnapshot(sessionId),all=this.store.listVotes(sessionId);
    return viewer&&votesSealed(snapshot)?all.filter(vote=>vote.participantId===viewer.participantId):all;
  }
  /**
   * Human ruling on the criteria a panel could not settle; it also closes the session. It is only accepted in
   * `awaiting_human`, and it demands exactly one on-scale ruling per contested criterion: a finalize with an
   * empty rulings array used to be able to close a live session with an all-zero report.
   */
  async finalizeScoring(sessionId:string,body:unknown,resolvedBy='human'){
    const input=parse(finalizeRequest,body),session=this.store.getSession(sessionId);
    if(session.kind!=='scoring')throw flowError(COLLAB_ERRORS.wrongPhase,'Only scoring sessions can be finalized');
    if(session.phase!=='awaiting_human'||session.status!=='active')
      throw flowError(COLLAB_ERRORS.wrongPhase,`Finalizing is only accepted in phase awaiting_human, but the session is in ${session.phase} (${session.status})`);
    const snapshot=this.scoringSnapshot(sessionId);
    const contested=contestedCriteria(snapshot).map(entry=>entry.criterionId);
    const {scale}=session.policy.scoring,errors:FieldError[]=[],seen=new Set<string>();
    input.rulings.forEach((ruling,index)=>{
      if(!contested.includes(ruling.criterionId))errors.push(fieldError(`rulings[${index}].criterionId`,'UNKNOWN_CRITERION',`${ruling.criterionId} is not one of the contested criteria (${contested.join(', ')||'none'})`));
      if(seen.has(ruling.criterionId))errors.push(fieldError(`rulings[${index}].criterionId`,'DUPLICATE',`Criterion ${ruling.criterionId} already has a ruling`));
      seen.add(ruling.criterionId);
      if(ruling.score<scale.min||ruling.score>scale.max)errors.push(fieldError(`rulings[${index}].score`,'OUT_OF_RANGE',`Score must be between ${scale.min} and ${scale.max}`));
      const quotient=(ruling.score-scale.min)/scale.step;
      if(Math.abs(quotient-Math.round(quotient))>1e-9)errors.push(fieldError(`rulings[${index}].score`,'NOT_A_MULTIPLE',`Score must be a multiple of ${scale.step}`));
    });
    for(const criterionId of contested)if(!seen.has(criterionId))
      errors.push(fieldError('rulings','REQUIRED',`Contested criterion "${this.store.getCriterion(criterionId).name}" (${criterionId}) needs a ruling`));
    if(errors.length)throw new ValidationError(errors);
    const rulings=Object.fromEntries(input.rulings.map(ruling=>[ruling.criterionId,ruling.score]));
    const report=finalizeScores(snapshot,rulings);
    // The dispute and the ruling are the same act: leaving the escalation pending would keep the board red forever.
    this.settleScoreDispute(sessionId,'Final scores were set by a human via /finalize',resolvedBy,input.rulings);
    this.store.updateSession(sessionId,{phase:'finalized',status:'finished',outcome:{...report,rulings:input.rulings,resolvedBy}});
    this.record(sessionId,'session_finished',{outcome:report},resolvedBy);
    this.announceFinish(this.store.getSession(sessionId));
    return report;
  }

  scoringSnapshot(sessionId:string):ScoringSnapshot{
    const session=this.store.getSession(sessionId);
    return {
      phase:session.phase as ScoringPhase,round:session.round,debateRound:session.debateRound,policy:session.policy,status:session.status,
      participants:this.store.listParticipants(sessionId).map(participant=>this.toFlowParticipant(participant)),
      criteria:this.store.listCriteria(sessionId).map(criterion=>({criterionId:criterion.criterionId,state:criterion.state,name:criterion.name,round:criterion.round,weight:criterion.weight})),
      votes:this.store.listVotes(sessionId).map(vote=>({criterionId:vote.criterionId,participantId:vote.participantId,round:vote.round,stance:vote.stance,weight:vote.weight})),
      scores:this.store.listScores(sessionId).map(score=>({criterionId:score.criterionId,participantId:score.participantId,round:score.round,score:score.score})),
      debates:this.store.listDebates(sessionId).map(debate=>({debateId:debate.debateId,criterionId:debate.criterionId,round:debate.round,status:debate.status,arguments:debate.arguments.map(entry=>({participantId:entry.participantId}))})),
      completions:this.store.listCompletions(sessionId).filter(entry=>entry.phase==='nominating').map(entry=>({phase:'nominating' as const,round:entry.round,participantId:entry.participantId})),
      pendingEscalations:this.store.listEscalations({sessionId,status:'pending'}).length
    };
  }
  /** Scoring counterpart of settle(): advance only while the panel has finished the current step. */
  async settleScoring(sessionId:string,forced=false,reason=''){
    for(let guard=0;guard<12;guard++){
      const session=this.store.getSession(sessionId),snapshot=this.scoringSnapshot(sessionId);
      if(session.status!=='active')return;
      if(!isScoringReadyToAdvance(snapshot)&&!(forced&&guard===0))return;
      const result=nextScoringPhase(snapshot,{forced:forced&&guard===0});
      if(result.phase===snapshot.phase&&result.round===snapshot.round&&result.debateRound===snapshot.debateRound)return;
      if(result.rubric)this.applyRubric(sessionId,result.rubric);
      // Leaving awaiting_human always closes the dispute that put us there: a forced advance used to strand a
      // score_dispute that no endpoint could resolve afterwards (/finalize refuses a finished session).
      if(session.phase==='awaiting_human'&&result.phase!=='awaiting_human')
        this.settleScoreDispute(sessionId,forced&&guard===0?`Closed by a forced advance: ${reason||'no reason given'}`:'Closed when the panel left awaiting_human');
      if(result.phase==='debating')for(const criterionId of result.contested??[])this.store.createDebate(sessionId,criterionId,session.debateRound);
      if(result.phase==='rescoring')this.store.closeDebates(sessionId,session.debateRound);
      const finalized=result.phase==='finalized';
      const updated=this.store.updateSession(sessionId,{phase:result.phase,round:result.round,debateRound:result.debateRound,
        status:finalized?'finished':session.status,stalled:undefined,
        outcome:finalized?{...finalizeScores(this.scoringSnapshot(sessionId)),lockedBy:'panel'}:session.outcome});
      this.record(sessionId,'phase_changed',{from:session.phase,to:result.phase,round:result.round,debateRound:result.debateRound,reason:result.reason,
        ...(forced&&guard===0?{forced:true,forceReason:reason,skipped:result.skipped??[]}:{}),...(result.contested?{contested:result.contested}:{})});
      if(result.rubric)this.record(sessionId,'rubric_locked',{lockedBy:result.rubric.lockedBy,reason:result.rubric.reason,criteria:result.rubric.criteria});
      if(finalized){this.record(sessionId,'session_finished',{outcome:updated.outcome??{}});this.announceFinish(this.store.getSession(sessionId));return}
      if(result.phase==='awaiting_human')this.raiseScoringEscalation(updated,result.contested??[]);
      this.dispatchScoring(sessionId);
    }
  }
  private applyRubric(sessionId:string,rubric:{criteria:{criterionId:string,weight:number}[],rejected:string[]}){    for(const entry of rubric.criteria)this.store.updateCriterion(entry.criterionId,{state:'approved',weight:entry.weight});
    for(const criterionId of rubric.rejected)this.store.updateCriterion(criterionId,{state:'rejected'});
  }
  /** Closes the pending score dispute, whatever ended the wait: a ruling, a forced advance, or a late convergence. */
  private settleScoreDispute(sessionId:string,rationale:string,resolvedBy='human',rulings?:unknown){
    const pending=this.store.findPendingEscalation(sessionId,'score_dispute');
    if(!pending)return;
    this.store.resolveEscalation(pending.escalationId,{decision:rulings?'scores_ruled':'closed_without_ruling',rationale,...(rulings?{rulings}:{})},resolvedBy);
    this.record(sessionId,'escalation_resolved',{escalationId:pending.escalationId,kind:'score_dispute',decision:rulings?'scores_ruled':'closed_without_ruling',rationale},resolvedBy);
  }
  private raiseScoringEscalation(session:CollabSession,contested:string[]){
    if(this.store.findPendingEscalation(session.sessionId,'score_dispute'))return;
    const names=contested.map(criterionId=>this.store.getCriterion(criterionId).name);
    const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:'score_dispute',raisedBy:'system',
      summary:`After ${session.policy.scoring.maxDebateRounds} debate round(s) the panel still disagrees on: ${names.join(', ')}.`,
      positions:this.store.listScores(session.sessionId).filter(score=>contested.includes(score.criterionId)&&score.round===session.debateRound)
        .map(score=>({participantId:score.participantId,stance:String(score.score),rationale:score.rationale})),
      question:'What is the final score for each contested criterion?',options:['take the median','accept the lower score','accept the higher score','set a specific score'],urgency:'normal'});
    this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'score_dispute',contested});
  }
  private dispatchScoring(sessionId:string){
    const session=this.store.getSession(sessionId),snapshot=this.scoringSnapshot(sessionId);
    const task=({nominating:'nominate_criteria',voting:'vote_on_criteria',scoring:'score_rubric',debating:'debate_contested_scores',rescoring:'rescore_contested'} as Record<string,string>)[session.phase];
    if(!task)return;
    for(const participantId of scoringWaitingOn(snapshot).length?scoringWaitingOn(snapshot):scoringPanel(snapshot).map(entry=>entry.participantId)){
      this.push(sessionId,participantId,task,{phase:session.phase,round:session.round,debateRound:session.debateRound});
      this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round});
    }
  }
  scoringDigest(participant:Participant){
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    const base={sessionId:session.sessionId,kind:session.kind,title:session.title,phase:session.phase,round:session.round,debateRound:session.debateRound,
      subject:session.subject,you:{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,tokensUsed:participant.tokensUsed,tokenBudget:participant.tokenBudget,state:participant.state},
      progress:scoringProgress(snapshot),stalled:session.stalled};
    if(session.phase==='nominating')return {...base,task:'nominate_criteria',yourNominations:this.criteria(session.sessionId,participant),
      instructions:`Propose scoring criteria with a definition and anchors, then set nominationsComplete=true. You cannot see other panelists' proposals until everyone has finished.`};
    if(session.phase==='voting')return {...base,task:'vote_on_criteria',candidates:this.store.listCriteria(session.sessionId).filter(criterion=>criterion.state==='candidate'),tallies:votesSealed(snapshot)?undefined:tallyVotes(snapshot),
      instructions:'Vote approve, reject, or abstain on every candidate and suggest a weight. Rejecting requires a rationale.'};
    if(session.phase==='scoring'||session.phase==='rescoring')return {...base,task:session.phase==='scoring'?'score_rubric':'rescore_contested',
      rubric:approvedCriteria(snapshot),analysis:scoresSealed(snapshot)?undefined:analyse(snapshot),
      instructions:`Score every criterion in the locked rubric on a ${session.policy.scoring.scale.min}-${session.policy.scoring.scale.max} scale. Every score needs a rationale and at least one evidence entry with a file path.${session.phase==='rescoring'?' A rescore must include changeReason, even if the score stays the same.':''}`};
    if(session.phase==='debating')return {...base,task:'debate_contested_scores',debates:this.store.listDebates(session.sessionId).filter(debate=>debate.status==='open'),analysis:analyse(snapshot),
      instructions:'Argue your position on each contested criterion with evidence. Use stance "hold" if you stand by your score.'};
    return {...base,task:'wait',instructions:session.phase==='awaiting_human'?'A human is ruling on the contested criteria.':'Nothing is required from you right now.'};
  }

  // ---------------------------------------------------------------- internals
  snapshot(sessionId:string):ReviewSnapshot{
    const session=this.store.getSession(sessionId);
    return {
      phase:session.phase as ReviewPhase,round:session.round,debateRound:session.debateRound,policy:session.policy,status:session.status,
      participants:this.store.listParticipants(sessionId).map(participant=>this.toFlowParticipant(participant)),
      issues:this.store.listIssues(sessionId).map(issue=>this.toFlowIssue(issue)),
      issueVotes:this.store.listIssueVotes(sessionId),mergeProposals:this.store.listMergeProposals(sessionId),
      completions:this.store.listCompletions(sessionId).filter(entry=>{const [phase,suffix]=entry.phase.split(':');return !['issue_discussing','issue_reconsidering'].includes(phase)||Number(suffix)===session.debateRound}).map(entry=>({phase:entry.phase.split(':')[0] as ReviewPhase,round:entry.round,participantId:entry.participantId})),
      pendingEscalations:this.store.listEscalations({sessionId,status:'pending'}).length
    };
  }
  /** Advances as far as the rules allow after each submission. It never skips anyone; that needs a human. */
  private async settle(sessionId:string){
    for(let guard=0;guard<10;guard++){
      const session=this.store.getSession(sessionId),snapshot=this.snapshot(sessionId);
      if(session.status!=='active'||!isReadyToAdvance(snapshot))return;
      const result=nextPhase(snapshot);
      await this.applyPhase(session,result,{});
    }
  }
  private async applyPhase(session:CollabSession,result:{phase:ReviewPhase,round:number,reason:string,debateRound?:number,escalateDeadlock?:boolean,escalateConsensus?:boolean,skipped?:string[]},context:{forced?:boolean,reason?:string,actor?:string}){
    const finished=result.phase==='finished';
    if(context.forced&&result.skipped?.length){
      const completionPhase=['issue_discussing','issue_reconsidering'].includes(session.phase)?`${session.phase}:${session.debateRound}`:session.phase;
      for(const participantId of result.skipped)this.store.markPhaseComplete(session.sessionId,session.round,completionPhase,participantId);
      if(session.phase==='merge_voting')for(const proposal of this.store.listMergeProposals(session.sessionId).filter(entry=>entry.round===session.round))for(const participantId of result.skipped)if(!proposal.votes.some(vote=>vote.participantId===participantId))this.store.saveMergeVote({proposalId:proposal.proposalId,participantId,stance:'reject',rationale:`Skipped by forced advance: ${context.reason||'no reason given'}`});
    }
    if(session.phase==='merge_voting'&&result.phase==='consolidating')this.applyApprovedMerges(session.sessionId);
    if(result.escalateConsensus)this.raiseConsensusEscalations(session);
    // Pin the baseline *before* the phase is visible: otherwise a reviewer that polls in between sees
    // `collecting` with no baseline and its findings bounce off with STALE_BASELINE.
    if(result.phase==='collecting'&&(result.round!==session.round||session.phase==='implementing'))await this.captureBaseline({...session,phase:result.phase,round:result.round});
    const updated=this.store.updateSession(session.sessionId,{phase:result.phase,round:result.round,debateRound:result.debateRound??session.debateRound,status:finished?'finished':session.status,
      stalled:undefined,outcome:finished?this.outcome(session.sessionId):session.outcome});
    this.record(session.sessionId,'phase_changed',{from:session.phase,to:result.phase,round:result.round,debateRound:result.debateRound??session.debateRound,reason:result.reason,
      ...(context.forced?{forced:true,forcedBy:context.actor??'human',forceReason:context.reason,skipped:result.skipped??[]}:{})},context.forced?(context.actor??'human'):undefined);
    if(result.escalateDeadlock)this.raiseDeadlockEscalation(updated);
    if(finished){this.record(session.sessionId,'session_finished',{outcome:updated.outcome??{}});this.announceFinish(this.store.getSession(session.sessionId))}
    else this.dispatch(session.sessionId);
  }
  private async captureBaseline(session:CollabSession){
    const snapshot=await this.resolveBaseline({cwd:session.cwd,subject:session.subject,round:session.round});
    const baseline=this.store.saveBaseline({sessionId:session.sessionId,round:session.round,...snapshot});
    this.record(session.sessionId,'baseline_captured',{...baseline});
    return baseline;
  }
  /** Queues the task for every participant that now owes work. Managed agents are woken from this queue. */
  private dispatch(sessionId:string){
    const session=this.store.getSession(sessionId),participants=this.store.listParticipants(sessionId).filter(participant=>participant.state==='active');
    const targets=new Map<string,string>();
    if(session.phase==='implementing')for(const participant of participants)if(participant.role==='implementer')targets.set(participant.participantId,'implement');
    // In build-then-review the implementer is writing code, not filing reverse findings, so it gets no task here.
    if(session.phase==='collecting')for(const participant of participants)if(participant.role!=='moderator'&&!(session.policy.implementationFirst&&participant.role==='implementer'))targets.set(participant.participantId,participant.role==='reviewer'?'file_findings':'file_findings_optional');
    if(session.phase==='validating')for(const participant of participants)if(participant.role==='reviewer')targets.set(participant.participantId,'validate_issues');
    if(session.phase==='merge_voting')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'vote_on_merges');
    if(session.phase==='issue_discussing')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'defend_approved_issues');
    if(session.phase==='issue_reconsidering')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'reconsider_issue_votes');
    if(session.phase==='responding')for(const issue of this.store.listIssues(sessionId,{status:['open']}))targets.set(issue.targetParticipantId,'respond_to_issues');
    if(session.phase==='adjudicating')for(const issue of this.store.listIssues(sessionId,{status:['answered']}))targets.set(issue.reporterId,'rule_on_responses');
    for(const [participantId,task] of targets){
      this.push(sessionId,participantId,task,{phase:session.phase,round:session.round});
      this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round});
    }
  }
  private applyApprovedMerges(sessionId:string){
    const panel=this.store.listParticipants(sessionId).filter(participant=>participant.role==='reviewer'&&participant.state!=='left'),session=this.store.getSession(sessionId),proposals=this.store.listMergeProposals(sessionId).filter(proposal=>proposal.round===session.round),parent=new Map<string,string>();
    const root=(id:string):string=>{const value=parent.get(id);if(!value){parent.set(id,id);return id}if(value===id)return id;const resolved=root(value);parent.set(id,resolved);return resolved};
    const join=(a:string,b:string)=>{const left=root(a),right=root(b);if(left!==right)parent.set(right,left)};
    for(const proposal of proposals){
      const approved=panel.every(reviewer=>proposal.votes.some(vote=>vote.participantId===reviewer.participantId&&vote.stance==='approve'));
      this.record(sessionId,approved?'merge_proposal_approved':'merge_proposal_rejected',{proposalId:proposal.proposalId,issueIds:proposal.issueIds,votes:proposal.votes});
      if(approved)for(const issueId of proposal.issueIds.slice(1))join(proposal.issueIds[0],issueId);
    }
    const groups=new Map<string,string[]>();for(const issueId of parent.keys()){const key=root(issueId);groups.set(key,[...(groups.get(key)??[]),issueId])}
    for(const ids of groups.values()){
      const issues=ids.map(id=>this.store.getIssue(id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.issueId.localeCompare(b.issueId)),primary=issues[0];
      for(const duplicate of issues.slice(1)){if(duplicate.status!=='open')continue;this.store.updateIssue(duplicate.issueId,{status:'duplicate',mergedInto:primary.issueId});this.record(sessionId,'issues_merged',{primaryIssueId:primary.issueId,duplicateIssueId:duplicate.issueId})}
    }
    this.store.markPhaseComplete(sessionId,session.round,'merge_voting','system');
  }
  private raiseConsensusEscalations(session:CollabSession){
    const snapshot=this.snapshot(session.sessionId),votes=currentIssueVotes(snapshot);
    for(const issueId of contestedIssueIds(snapshot)){
      const issue=this.store.getIssue(issueId);if(this.store.findPendingEscalation(session.sessionId,'issue_dispute',issueId))continue;
      this.store.updateIssue(issueId,{status:'escalated'});
      const current=issueConsensus(snapshot).find(entry=>entry.issueId===issueId);
      const voteHistory=this.store.listIssueVotes(session.sessionId).filter(vote=>vote.issueId===issueId).map(vote=>({participantId:vote.participantId,stance:`vote round ${vote.consensusRound}: ${vote.stance}`,rationale:vote.rationale??'approved without an additional rationale'}));
      const discussions=this.store.listIssueMessages(issueId).filter(message=>message.kind==='discussion').map(message=>({participantId:message.authorId,stance:`discussion round ${message.payload.consensusRound??'?'}`,rationale:String(message.payload.argument??'')}));
      const implicit=(current?.positions??[]).filter(position=>position.implicit).map(position=>({participantId:position.participantId,stance:'initial approve (reporter)',rationale:'issue reporter implicitly approves'})),positions=[...implicit,...voteHistory,...discussions];
      const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:'issue_dispute',refId:issueId,raisedBy:'system',summary:`The review panel did not reach unanimous agreement on whether this is a valid issue after ${session.policy.maxConsensusRounds} discussion round(s): ${issue.title}`,positions,question:`Should "${issue.title}" proceed to implementation?`,options:['valid issue','not an issue','needs more investigation'],urgency:issue.severity==='blocker'||issue.severity==='critical'?'high':'normal'});
      this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'issue_dispute',refId:issueId,reason:'issue_consensus_exhausted',votes:votes.filter(vote=>vote.issueId===issueId)});
    }
  }
  private raiseIssueEscalation(session:CollabSession,issue:Issue,participant:Participant,reason:string,rationale:string){
    if(this.store.findPendingEscalation(session.sessionId,'issue_dispute',issue.issueId))return;
    const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:'issue_dispute',refId:issue.issueId,raisedBy:participant.participantId,
      summary:`${issue.title} (${issue.severity}) could not be settled between the participants: ${reason}`,
      positions:this.store.listIssueMessages(issue.issueId).slice(-6).map(message=>({participantId:message.authorId,stance:String(message.payload.responseType??message.payload.verdict??message.kind),rationale:String(message.payload.rationale??'(no rationale recorded)')})),
      question:`How should "${issue.title}" be resolved?`,options:['fix in this round','defer to a follow-up','not an issue'],urgency:issue.severity==='blocker'||issue.severity==='critical'?'high':'normal'});
    this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'issue_dispute',refId:issue.issueId,reason,rationale},participant.participantId);
  }
  private raiseDeadlockEscalation(session:CollabSession){
    if(this.store.findPendingEscalation(session.sessionId,'other'))return;
    const open=this.store.listIssues(session.sessionId).filter(issue=>['open','answered','escalated'].includes(issue.status));
    const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:'other',raisedBy:'system',
      summary:`The session reached its ${session.policy.maxTotalRounds}-round cap with ${open.length} issue(s) still open.`,
      positions:[],question:'How should the remaining issues be handled?',options:['rule on each issue','raise the round cap','close the session as is'],urgency:'high'});
    this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'other',reason:'max_total_rounds_reached'});
  }
  /** Marks a stall for humans and dashboards. It deliberately does not change the phase. */
  /**
   * A task the hub could not hand over is a different failure from "the agent is thinking about it": the bound
   * agent is gone, wedged, or was never started. Waiting the full overdue window for that is pointless, so it
   * gets its own, much shorter alarm.
   */
  private undeliveredTaskOwners(sessionId:string,overdueWarningSec:number,pending:string[]):string[]{
    if(!pending.length)return [];
    const cutoff=this.now()-Math.min(UNDELIVERED_TASK_WARNING_MS,overdueWarningSec*1000);
    const ids:string[]=[];
    for(const participant of this.store.listParticipants(sessionId)){
      // Only someone who still owes work *and* was never even told about it: anyone else is simply thinking.
      if(participant.state!=='active'||!pending.includes(participant.participantId))continue;
      if(this.store.listInbox(participant.participantId).some(item=>Date.parse(item.createdAt)<=cutoff))ids.push(participant.participantId);
    }
    return ids;
  }
  /** Participants plus the fact a human needs when a session looks frozen: what is still queued undelivered. */
  participantsForHuman(sessionId:string){
    return this.store.listParticipants(sessionId).map(participant=>({...participant,pendingTasks:this.store.listInbox(participant.participantId).length}));
  }
  checkStalls(){
    const changed:CollabSession[]=[];
    for(const session of this.store.listSessions({status:'active'})){
      const snapshot=this.snapshot(session.sessionId),allPending=waitingOn(snapshot),participants=this.store.listParticipants(session.sessionId);
      // A long review can legitimately exceed the warning window. `streaming`/`starting` means Pi is still
      // actively doing the assigned work, not that the seat forgot to submit its API result.
      const busy=new Set(participants.filter(participant=>['starting','streaming','stopping'].includes(this.options.agentStatus?.(participant.agentId)??'')).map(participant=>participant.participantId));
      const pending=allPending.filter(participantId=>!busy.has(participantId));
      const unclaimed=this.undeliveredTaskOwners(session.sessionId,session.policy.overdueWarningSec,pending);
      if(session.stalled){
        // Keep an existing marker while all remaining seats are busy: clearing it would bump updatedAt and reset
        // the overdue clock. The board renders it as "still running", and it becomes actionable immediately if
        // those Agents go idle without submitting.
        if(allPending.length&&pending.length===0)continue;
        /*
         * Do NOT re-run the timer here: writing the stall flag bumps updatedAt, so a fresh stallCheck would
         * always report "not overdue" and clear the flag a minute later, then alert again every window.
         * The flag only goes away when the situation actually changed.
         */
        const current=unclaimed.length?unclaimed:pending;
        if(!current.length||current.join('|')!==session.stalled.waitingOn.join('|'))
          changed.push(this.store.updateSession(session.sessionId,{stalled:undefined}));
        continue;
      }
      if(unclaimed.length){
        const updated=this.store.updateSession(session.sessionId,{stalled:{since:new Date(this.now()).toISOString(),waitingOn:unclaimed}});
        this.record(session.sessionId,'participant_overdue',{waitingOn:unclaimed,overdueBySec:0,phase:session.phase,reason:'task_never_delivered'});
        changed.push(updated);
        continue;
      }
      const check=stallCheck(snapshot,Date.parse(session.updatedAt),this.now());
      if(!check.stalled||!pending.length)continue;
      const updated=this.store.updateSession(session.sessionId,{stalled:{since:new Date(this.now()).toISOString(),waitingOn:pending}});
      this.record(session.sessionId,'participant_overdue',{waitingOn:pending,overdueBySec:check.overdueBySec,phase:session.phase});
      changed.push(updated);
    }
    return changed;
  }
  /**
   * Closing hand-off: every participant is told the session is over. Without it a managed agent that is waiting
   * for review feedback would sit there forever (or start polling), because a clean review pushes no other task.
   * The stored managed credentials are dropped by the dispatcher once the note has been delivered.
   */
  private announceFinish(session:CollabSession){
    const participants=this.store.listParticipants(session.sessionId).filter(participant=>participant.state!=='left');
    for(const participant of participants){
      this.push(session.sessionId,participant.participantId,'session_result',{phase:session.phase,round:session.round,outcome:session.outcome??{}});
      this.record(session.sessionId,'task_assigned',{participantId:participant.participantId,task:'session_result',phase:session.phase,round:session.round});
    }
    if(!participants.length)this.retireDispatchTokens(session.sessionId);
  }
  private outcome(sessionId:string){
    const issues=this.store.listIssues(sessionId),byStatus:Record<string,number>={};
    for(const issue of issues)byStatus[issue.status]=(byStatus[issue.status]??0)+1;
    const snapshot=this.snapshot(sessionId),approval=approvalSummary(snapshot);
    return {totalIssues:issues.length,byStatus,
      // Explicit close-out: "approved" only when every reviewer's findings were settled without a human ruling.
      verdict:issues.some(issue=>isOpenIssue(this.toFlowIssue(issue)))?'closed_with_open_issues':approval.humanRuledCount?'closed_after_human_ruling':approval.unanimous?'approved':'closed',
      approval,
      participants:this.store.listParticipants(sessionId).map(participant=>({participantId:participant.participantId,displayName:participant.displayName,role:participant.role,model:participant.model,tokensUsed:participant.tokensUsed,tokensEstimated:participant.tokensEstimated,state:participant.state}))};
  }
  private withHistory(issue:Issue){return {...issue,history:this.store.listIssueMessages(issue.issueId)}}
  /**
   * Flags likely duplicates without merging: a wrong merge silently drops a real defect. While collection is
   * blind the hint is restricted to issues the caller may already read, otherwise the id alone (and a GET on it)
   * would hand a rival reviewer the sealed finding.
   */
  private possibleDuplicates(sessionId:string,issueIds:string[],viewer?:Participant){
    if(!issueIds.length)return [];
    const all=this.store.listIssues(sessionId),results:{issueId:string,similarTo:string,score:number}[]=[];
    for(const issueId of issueIds){
      const issue=all.find(entry=>entry.issueId===issueId);if(!issue)continue;
      for(const other of all){
        if(other.issueId===issueId||issueIds.includes(other.issueId)&&other.issueId>issueId)continue;
        if(other.issueId===issueId)continue;
        if(viewer&&!this.canSeeIssue(sessionId,other,viewer))continue;
        const score=similarity(issue,other);
        if(score>=0.7)results.push({issueId,similarTo:other.issueId,score:Math.round(score*100)/100});
      }
    }
    return results;
  }
  private replay<T>(participant:Participant,clientRequestId:string):T|undefined{return this.store.getIdempotent<T>(`${participant.participantId}:${clientRequestId}`)}
  private finish(participant:Participant,clientRequestId:string,body:unknown,usage:{inputTokens?:number,outputTokens?:number,totalTokens?:number}|undefined,response:unknown){
    this.store.saveIdempotent(`${participant.participantId}:${clientRequestId}`,participant.sessionId,participant.participantId,response);
    this.chargeUsage(participant,body,usage);
  }
  /** An agent that reports real usage is charged that; one that stays silent is charged a byte-based estimate. */
  private chargeUsage(participant:Participant,body:unknown,usage?:{inputTokens?:number,outputTokens?:number,totalTokens?:number}){
    const reported=usage?.totalTokens??((usage?.inputTokens??0)+(usage?.outputTokens??0));
    const estimated=!reported;
    const tokens=reported||Math.ceil((JSON.stringify(body)?.length??0)/4);
    const updated=this.store.addTokenUsage(participant.participantId,tokens,estimated);
    if(updated.state==='budget_exhausted'&&participant.state!=='budget_exhausted'){
      this.record(participant.sessionId,'budget_exhausted',{participantId:participant.participantId,tokensUsed:updated.tokensUsed,tokenBudget:updated.tokenBudget});
      if(!this.store.findPendingEscalation(participant.sessionId,'budget_exhausted',participant.participantId)){
        const escalation=this.store.createEscalation({sessionId:participant.sessionId,kind:'budget_exhausted',refId:participant.participantId,raisedBy:'system',
          summary:`${participant.displayName} spent its ${updated.tokenBudget} token budget and can no longer submit.`,positions:[],
          question:'Raise the budget, replace the agent, or force the phase forward?',options:['raise budget','replace participant','force advance'],urgency:'high'});
        this.record(participant.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'budget_exhausted',refId:participant.participantId});
      }
    }
    return updated;
  }
  private toFlowParticipant(participant:Participant):FlowParticipant{return {participantId:participant.participantId,role:participant.role,state:participant.state}}
  private toFlowIssue(issue:Issue):FlowIssue{return {issueId:issue.issueId,reporterId:issue.reporterId,targetParticipantId:issue.targetParticipantId,status:issue.status,round:issue.round}}
}

/** Cross-field rules the schema cannot express: each response type carries its own obligations. */
export function responseFieldErrors(entry:{responseType:string,rationale?:string,changes:{path:string,summary:string}[],question?:string,codeRef?:{commit?:string,dirtyHash?:string}},index:number):FieldError[]{
  const errors:FieldError[]=[],at=(field:string)=>`responses[${index}].${field}`;
  if(['fixed','partially_fixed'].includes(entry.responseType)){
    if(!entry.changes.length)errors.push(fieldError(at('changes'),'REQUIRED',`A ${entry.responseType} response must list the files it changed`));
    if(!entry.codeRef?.commit&&!entry.codeRef?.dirtyHash)errors.push(fieldError(at('codeRef'),'REQUIRED',`A ${entry.responseType} response must reference the new code state (commit or dirtyHash)`));
  }
  if(entry.responseType==='rejected'&&(entry.rationale??'').trim().length<30)errors.push(fieldError(at('rationale'),'REQUIRED','Rejecting a finding requires a rationale of at least 30 characters'));
  if(entry.responseType==='deferred'&&(entry.rationale??'').trim().length<30)errors.push(fieldError(at('rationale'),'REQUIRED','Deferring a finding requires a rationale of at least 30 characters'));
  if(entry.responseType==='needs_info'&&!(entry.question??'').trim())errors.push(fieldError(at('question'),'REQUIRED','Asking for information requires a question'));
  return errors;
}

const words=(value:string)=>new Set(value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(token=>token.length>1));
function similarity(a:Issue,b:Issue){
  const overlapping=a.location.path===b.location.path&&
    (a.location.startLine===undefined||b.location.startLine===undefined||
     Math.max(a.location.startLine,b.location.startLine)<=Math.min(a.location.endLine??a.location.startLine,b.location.endLine??b.location.startLine));
  const left=words(`${a.title} ${a.suggestion??''}`),right=words(`${b.title} ${b.suggestion??''}`);
  const shared=[...left].filter(token=>right.has(token)).length,union=new Set([...left,...right]).size;
  return (overlapping?0.5:0)+(union?0.5*(shared/union):0);
}
