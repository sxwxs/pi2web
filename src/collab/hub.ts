import {execFile,execFileSync,spawn} from 'node:child_process';
import {createHash,type Hash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import type {Readable} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {COLLAB_ERRORS,type CollabEvent,type CollabSession,type CollabSubject,type Escalation,type Issue,type Participant,type ReviewPhase,type ScoringPhase} from './types.js';
import {CollabStore,type CreateSessionInput} from './store.js';
import {ValidationError,parse,type FieldError} from './validate.js';
import {advanceRequest,createParticipantRequest,createSessionRequest,debateArgumentRequest,debateArgumentsRequest,escalationRequest,findingsRequest,finalizeRequest,nominationsRequest,participantBudgetRequest,policyPatch,readyRequest,rebindParticipantRequest,recheckRequest,resolveEscalationRequest,scoresRequest,votesRequest,issueVotesRequest,mergeVotesRequest,issueDiscussionsRequest,retryWaitingRequest} from './schemas.js';
import {analyse,assertScoringCapability,assertScoringPhase,contestedCriteria,finalizeScores,isScoringReadyToAdvance,nextScoringPhase,nominationsSealed,scoresSealed,scoringPanel,scoringProgress,scoringWaitingOn,tallyVotes,votesSealed,type ScoringSnapshot} from './scoring-flow.js';
import {applyEscalation,applyHumanRuling,applyWithdraw,approvalSummary,assertCanFileFinding,assertCapability,canSeeOthersFindings,flowError,isOpenIssue,isReadyToAdvance,nextPhase,sessionProgress,stallCheck,waitingOn,currentIssueVotes,issueConsensus,activeContestedIssueIds,pendingCrossVoters,owedIssueVoteIds,type AdvanceResult,type ContestedResolution,type FlowIssue,type FlowParticipant,type ReviewSnapshot} from './review-flow.js';

const run=promisify(execFile);

/**
 * Shared rulebook handed to every seat. A reviewer that does not know the panel size, the vote semantics, or
 * what happens to a contested finding cannot calibrate anything: the first live panels produced one reviewer
 * filing twelve findings against another's two, and votes that mixed "this is factually wrong" with "this is
 * out of scope". None of that was in the prompt, so none of it could be agreed on.
 */
const SEVERITY_GUIDE={
  blocker:'Ships broken or unsafe: data loss, security hole, or the feature cannot work at all.',
  critical:'Fails for a realistic input or breaks an existing caller; no acceptable workaround.',
  major:'Wrong or missing behaviour a user or operator will hit, with a workaround.',
  minor:'Narrow or unlikely impact; correctness or clarity gap worth fixing.',
  nit:'Style, naming, or wording. Never blocks a merge.'
} as const;
const REQUIRED_ACTION_GUIDE={
  must_fix:'Must not merge with this unfixed.',should_fix:'Fix in this change unless there is a reason not to.',
  discuss:'A judgment call that needs a decision, not necessarily a code change.',fyi:'Recorded for awareness only.'
} as const;
const VOTE_GUIDE={
  approve:'The finding is factually correct at this baseline and in scope for this review. Approve even if you would have rated the severity lower; say so in the rationale.',
  reject:'Only when the finding is factually wrong, already handled elsewhere in the code, or outside this review\'s subject. A different severity or a matter of taste is not a reject.'
} as const;

/** How long a queued task may sit undelivered before the human is told that the wake-up is not landing. */
const UNDELIVERED_TASK_WARNING_MS=120_000;

export type BaselineSnapshot={vcs:string,commit?:string,range?:string,rangeResolved?:string,dirtyHash?:string,paths:string[]};
export type BaselineResolver=(input:{cwd:string,subject:CollabSubject,round:number})=>Promise<BaselineSnapshot>;
export type HubOptions={resolveBaseline?:BaselineResolver,now?:()=>number,agentTokenUsage?:(agentId:string)=>Promise<number|undefined>,agentStatus?:(agentId:string)=>string|undefined};

/** Anchors every round to an immutable code state so round N+1 verdicts are not made against round N's memory. */
export const gitBaseline:BaselineResolver=async({cwd,subject})=>{
  const git=async(args:string[])=>(await run('git',args,{cwd})).stdout;
  try{
    const commit=(await git(['rev-parse','HEAD'])).trim();
    let dirtyHash:string|undefined;
    const status=await git(['status','--porcelain','-z']);
    if(status){
      const untracked=(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).sort();
      // Hashed as a stream, never buffered. A working tree diff can be tens of megabytes, and a diff dropped for
      // exceeding a buffer would leave a hash of nothing but file names - identical before and after an edit to
      // those same files, which is exactly what `assertBaselineCurrent()` exists to catch.
      const hash=createHash('sha256').update(status);
      await hashStream(hash,spawn('git',['diff','HEAD','--binary'],{cwd,stdio:['ignore','pipe','ignore']}));
      for(const relative of untracked){
        hash.update(relative).update('\0');
        // A file removed during capture is already represented by status.
        await hashStream(hash,createReadStream(path.join(cwd,relative))).catch(()=>{});
      }
      dirtyHash=`sha256:${hash.digest('hex')}`;
    }
    // A commit range such as `main...feature` is only a name: either endpoint can move while HEAD and the
    // working tree stay identical, which would silently change the code under review. Resolve both endpoints
    // so the pinned identity covers the range, not just its spelling.
    let rangeResolved:string|undefined;
    if(subject.type==='commit_range'){
      const expression=subject.value.trim();
      const endpoints=expression.includes('...')?expression.split('...'):expression.includes('..')?expression.split('..'):[expression];
      const resolved:string[]=[];
      for(const endpoint of endpoints){
        const name=endpoint.trim();
        resolved.push(name?(await git(['rev-parse','--verify',`${name}^{commit}`]).catch(()=>'')).trim()||`unresolved:${name}`:'HEAD');
      }
      rangeResolved=resolved.join('...');
    }
    return {vcs:'git',commit,range:subject.type==='commit_range'?subject.value:undefined,rangeResolved,dirtyHash,paths:subject.type==='paths'?subject.value.split(/[\n,]/).map(value=>value.trim()).filter(Boolean):[]};
  }catch{
    // Not a git checkout (or git is missing). The hub still works; it just cannot prove code identity.
    return {vcs:'none',paths:[]};
  }
};
/** Feeds one stream into a hash, rejecting on failure so a partial read can never pass as "nothing changed". */
function hashStream(hash:Hash,source:Readable|ChildProcess){
  const process='stdout' in source?source:undefined,stream=(process?process.stdout:source) as Readable|null;
  return new Promise<void>((resolve,reject)=>{
    if(!stream)return reject(new Error('Stream is not readable'));
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('error',reject);
    if(!process)return void stream.on('end',resolve);
    process.on('error',reject);
    process.on('close',code=>code===0?resolve():reject(new Error(`git exited with ${code}`)));
  });
}

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
  /** Queues a durable wake-up. The dispatcher prompts; collab_get_task acknowledges collection. */
  private push(sessionId:string,participantId:string,type:string,payload:Record<string,unknown>){
    return this.store.pushInbox(sessionId,participantId,type,payload);
  }
  /**
   * Marks queued items handled explicitly. Normal tasks use claimTaskForAgent(); this helper remains for
   * terminal notes and stale cleanup because those messages do not call collab_get_task.
   */
  completeDelivery(participantId:string,task:string){
    const items=this.store.listInbox(participantId).filter(item=>item.type===task);
    if(items.length)this.store.ackInbox(participantId,items.map(item=>item.itemId));
    return items.length;
  }
  /** Public so the dispatcher can log a wake-up attempt on the session timeline without reaching into internals. */
  logDispatch(sessionId:string,type:'agent_dispatched'|'dispatch_failed'|'dispatch_skipped',payload:Record<string,unknown>){
    try{this.record(sessionId,type,payload)}catch{/* the session may have been removed while a wake-up was in flight */}
  }
  /**
   * What this seat owes *now*. A wake-up is queued when a phase opens but delivered only once the agent's
   * previous turn ends, so by then the panel may have moved on: waking it anyway costs a full model turn to
   * learn there is nothing to do.
   */
  currentTaskFor(participantId:string):string{
    // Fails open on purpose: 'wait' retires a durable inbox item, so answering 'wait' for a transient throw
    // (a busy database, a session read mid-delete) would silently drop real work and leave the phase waiting on
    // a seat that is never woken again. An unnecessary wake-up costs one turn; a dropped one costs the session.
    try{return String(this.digest(this.store.getParticipant(participantId)).task??'wait')}catch{return 'unknown'}
  }

  // ---------------------------------------------------------------- human operations
  /** Only humans create sessions: agents must never be able to spawn collaboration loops on their own. */
  async createSession(body:unknown,resolveCwd:(workspaceId:string,relativeCwd:string)=>Promise<string>):Promise<CollabSession>{
    const input=parse(createSessionRequest,body);
    const cwd=await resolveCwd(input.workspaceId,input.relativeCwd);
    const session=this.store.createSession({kind:input.kind,title:input.title,workspaceId:input.workspaceId,cwd,subject:input.subject,policy:input.policy} as CreateSessionInput);
    this.record(session.sessionId,'session_created',{kind:session.kind,title:session.title,cwd,subject:session.subject});
    // Scoring has no open-round hand-off, so pin its code before the first panel task is issued.
    if(session.kind==='scoring')await this.captureBaseline(session);
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
  /** A dedicated collaboration Agent may own only one live seat globally; agentId alone is the bridge identity. */
  private assertAgentAvailable(agentId:string,_sessionId:string,exceptParticipantId?:string){
    const occupied=this.store.findOccupyingParticipantsByAgent(agentId).find(participant=>participant.participantId!==exceptParticipantId);
    if(occupied)throw flowError(COLLAB_ERRORS.conflict,`That agent is already registered to a seat in collaboration session ${occupied.sessionId}`);
  }
  addParticipant(sessionId:string,body:unknown){
    const input=parse(createParticipantRequest,body),session=this.store.getSession(sessionId);
    // A finished review may receive a new developer before a human starts an explicit fix/recheck cycle. Other
    // late seats would silently change the panel that produced the finished result, so they remain forbidden.
    const preparingRemediation=session.kind==='review'&&session.status==='finished'&&session.phase==='finished';
    if(session.status!=='active'&&!preparingRemediation)throw flowError(COLLAB_ERRORS.wrongPhase,`Session is ${session.status}; no new participant can be registered`);
    if(preparingRemediation&&input.role!=='implementer')throw flowError(COLLAB_ERRORS.wrongPhase,'Only a new implementer may be added to a finished review; the reviewer panel remains fixed for recheck');
    if(!preparingRemediation&&!this.registrationPhases(session).includes(session.phase))
      throw flowError(COLLAB_ERRORS.wrongPhase,session.kind==='scoring'
        // A scoring panel never returns to `nominating` once the rubric is locked, so "wait for the next round"
        // would be advice an operator cannot act on. Repairing the existing seat is the real path.
        ?`A scoring panel is fixed once the rubric is locked (the session is in ${session.phase}). Repair the existing seat instead: POST /participants/{participantId}/binding to hand it to another agent, and POST /participants/{participantId}/budget if it ran out of tokens.`
        :`A participant can only be registered in phase ${this.registrationPhases(session).join('/')}, but the session is in ${session.phase}. Wait for the next round, or rebind an existing seat.`);
    this.assertAgentAvailable(input.agentId,sessionId);
    const {participant,token}=this.store.createParticipant({sessionId,role:input.role,displayName:input.displayName,model:input.model,agentId:input.agentId,tokenBudget:input.tokenBudget});
    // Only the hash is stored: the managed agent submits through the in-process bridge, and the plaintext is
    // handed to the human exactly once, in this response.
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
    this.assertAgentAvailable(agentId,sessionId,participantId);
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
  /**
   * Reopens a completed review. `review_only` pins the current code and calls the original panel immediately;
   * `fix_then_review` first gives all selected implementer seats the confirmed findings, then /ready calls the panel.
   */
  async startRecheck(sessionId:string,body:unknown,actor='human'){
    const input=parse(recheckRequest,body),session=this.store.getSession(sessionId);
    if(session.kind!=='review'||session.status!=='finished'||session.phase!=='finished')throw flowError(COLLAB_ERRORS.wrongPhase,'Only a finished review session can start a recheck');
    if(this.store.listEscalations({sessionId,status:'pending'}).length)throw flowError(COLLAB_ERRORS.wrongPhase,'Resolve every pending escalation before starting a recheck');
    const participants=this.store.listParticipants(sessionId),reviewers=participants.filter(entry=>entry.role==='reviewer'&&entry.state==='active');
    if(!reviewers.length)throw flowError(COLLAB_ERRORS.wrongPhase,'A recheck needs at least one active reviewer');
    const selected=[...new Set(input.implementerParticipantIds)],implementers=participants.filter(entry=>entry.role==='implementer'&&entry.state==='active');
    if(input.mode==='fix_then_review'){
      if(selected.length!==1)throw new ValidationError([fieldError('implementerParticipantIds','WRONG_COUNT','Select exactly one active implementer; parallel implementers cannot safely share one workspace')]);
      for(const participantId of selected)if(!implementers.some(entry=>entry.participantId===participantId))throw new ValidationError([fieldError('implementerParticipantIds','UNKNOWN_PARTICIPANT',`${participantId} is not an active implementer in this session`)]);
    }else if(selected.length)throw new ValidationError([fieldError('implementerParticipantIds','UNEXPECTED','review_only does not assign an implementer')]);
    // Finished seats can be reused elsewhere. Reopening is the durability boundary where they become active again.
    for(const participant of participants.filter(entry=>entry.state==='active'))this.assertAgentAvailable(participant.agentId,sessionId,participant.participantId);
    const round=session.round+1,phase:ReviewPhase=input.mode==='fix_then_review'?'implementing':'collecting';
    // Closing notes from the prior result must not race the new task. The old bearer token is already in the
    // old turn's context, so every active seat is rotated; the fresh plaintext is returned to the human here
    // (the only place it exists) and nothing is persisted but its hash.
    const participantTokens:{participantId:string,displayName:string,token:string}[]=[];
    for(const participant of participants.filter(entry=>entry.state==='active')){
      this.completeDelivery(participant.participantId,'session_result');
      participantTokens.push({participantId:participant.participantId,displayName:participant.displayName,token:this.store.rotateParticipantToken(participant.participantId)});
    }
    if(input.mode==='fix_then_review')for(const implementer of implementers)if(!selected.includes(implementer.participantId))this.store.markPhaseComplete(sessionId,round,'implementing',implementer.participantId);
    if(phase==='collecting')await this.captureBaseline({...session,phase,round,status:'active'});
    const updated=this.store.updateSession(sessionId,{phase,round,debateRound:0,status:'active',stalled:undefined,outcome:undefined});
    this.record(sessionId,'review_reopened',{mode:input.mode,round,phase,implementerParticipantIds:selected},actor);
    this.dispatch(sessionId);
    return {...updated,participantTokens};
  }

  /** Moves a review session out of draft. Build-then-review sessions start in `implementing`; the rest go straight to `collecting`. */
  async openRound(sessionId:string){
    const session=this.store.getSession(sessionId);
    if(session.phase!=='draft')throw flowError(COLLAB_ERRORS.wrongPhase,`Round already open: session is in phase ${session.phase}`);
    const participants=this.store.listParticipants(sessionId);
    if(!participants.some(participant=>participant.role==='reviewer'))throw flowError(COLLAB_ERRORS.wrongPhase,'Register at least one reviewer before opening the round');
    const buildFirst=session.policy.implementationFirst;
    const implementers=participants.filter(participant=>participant.role==='implementer'&&participant.state==='active');
    if(buildFirst&&implementers.length!==1)throw flowError(COLLAB_ERRORS.wrongPhase,'An implementationFirst session needs exactly one active implementer because all seats share one workspace');
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
    assertCapability(this.toFlowParticipant(participant),'ready');
    if(participant.role!=='implementer')throw flowError(COLLAB_ERRORS.forbidden,'Only an implementer may declare the implementation ready',403);
    if(session.phase!=='implementing')throw flowError(COLLAB_ERRORS.wrongPhase,`Ready is only accepted in phase implementing, but the session is in ${session.phase}`);
    if(!waitingOn(this.snapshot(session.sessionId)).includes(participant.participantId))throw flowError(COLLAB_ERRORS.forbidden,'This implementer is not assigned to the current fix cycle',403);
    this.store.markPhaseComplete(session.sessionId,session.round,'implementing',participant.participantId);
    this.record(session.sessionId,'implementation_ready',{participantId:participant.participantId,summary:input.summary,codeRef:input.codeRef,changedFiles:input.changes.length,trigger:'self_reported'},participant.participantId);
    await this.settle(session.sessionId);
    const current=this.store.getSession(session.sessionId);
    const response={accepted:true,phase:current.phase,round:current.round,waitingOn:waitingOn(this.snapshot(session.sessionId))};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    return response;
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
    const input=parse(retryWaitingRequest,body),session=this.store.getSession(sessionId),snapshot=session.kind==='review'?this.snapshot(sessionId):undefined;
    const allPending=session.kind==='scoring'?scoringWaitingOn(this.scoringSnapshot(sessionId)):waitingOn(snapshot!);
    const crossVoters=snapshot?pendingCrossVoters(snapshot):[],owed=new Set([...allPending,...crossVoters]);
    const wanted=input.participantIds?.length?new Set(input.participantIds):undefined,pending=[...owed].filter(participantId=>!wanted||wanted.has(participantId));
    const participants=this.store.listParticipants(sessionId),busy=pending.filter(participantId=>{const participant=participants.find(entry=>entry.participantId===participantId);return participant&&['starting','streaming','waiting_for_user','stopping'].includes(this.options.agentStatus?.(participant.agentId)??'')});
    const retryable=pending.filter(participantId=>!busy.includes(participantId));
    const baseTask=session.kind==='scoring'?({nominating:'nominate_criteria',voting:'vote_on_criteria',scoring:'score_rubric',debating:'debate_contested_scores',rescoring:'rescore_contested'} as Record<string,string>)[session.phase]
      :({implementing:'implement',collecting:'file_findings',validating:'validate_issues',merge_voting:'vote_on_merges',issue_discussing:'defend_approved_issues',issue_reconsidering:'reconsider_issue_votes'} as Record<string,string>)[session.phase];
    if(!owed.size)throw flowError(COLLAB_ERRORS.wrongPhase,'Nobody is currently waiting to submit');
    if(!baseTask)throw flowError(COLLAB_ERRORS.wrongPhase,`Phase ${session.phase} has no retryable Agent task`);
    const nonce=this.now();for(const participantId of retryable){
      const taskBase=crossVoters.includes(participantId)&&!allPending.includes(participantId)?'validate_issues':baseTask;
      const task=`${taskBase}#retry-${nonce}`;this.push(sessionId,participantId,task,{phase:session.phase,round:session.round,retry:true});this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round,retry:true},actor);
    }
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
      // `reopen` means "valid finding" during review consensus. Keep it in this review round so finishing can
      // promote it to a confirmed action item instead of mistaking it for a future round's new finding.
      const ruledRound=input.issueDecision==='reopen'&&session.kind==='review'?session.round:outcome.round;
      this.store.updateIssue(issue.issueId,{status:outcome.status,round:ruledRound});
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
    // A scoring session must be settled by the scoring machine; the review machine has different phases.
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
  /** Internal bridge identity lookup. A collaboration Agent is constrained to exactly one active seat. */
  participantForAgent(agentId:string):Participant{
    const matches=this.store.findActiveParticipantsByAgent(agentId);
    if(matches.length!==1)throw flowError(COLLAB_ERRORS.forbidden,matches.length?'This collaboration Agent has more than one active seat':'This Agent has no active collaboration seat',403);
    return this.store.updateParticipant(matches[0].participantId,{lastSeenAt:new Date(this.now()).toISOString()});
  }
  /** A wake-up is durable until the extension actually asks for its task; merely queueing a Pi follow-up is not delivery. */
  claimTaskForAgent(agentId:string){
    const participant=this.participantForAgent(agentId),task=this.digest(participant),pending=this.store.listInbox(participant.participantId).filter(item=>item.type!=='session_result');
    if(pending.length){this.store.ackInbox(participant.participantId,pending.map(item=>item.itemId));this.record(participant.sessionId,'task_collected',{participantId:participant.participantId,tasks:pending.map(item=>item.type)},participant.participantId)}
    return task;
  }

  async submitFindings(participant:Participant,body:unknown){
    const input=parse(findingsRequest,body);
    const cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCanFileFinding(snapshot,participant.participantId);
    const baseline=this.store.getBaselineForRound(session.sessionId,session.round);
    if(!baseline)throw flowError(COLLAB_ERRORS.wrongPhase,'No baseline has been captured for this round yet');
    if(input.baselineId!==baseline.baselineId)throw Object.assign(flowError(COLLAB_ERRORS.staleBaseline,`Findings target baseline ${input.baselineId}, but the current baseline is ${baseline.baselineId}. Re-read the code and resubmit.`),{currentBaseline:baseline});
    await this.assertBaselineCurrent(session,baseline);
    const participants=this.store.listParticipants(session.sessionId);
    const defaultTarget=participants.find(entry=>entry.role==='implementer');
    const accepted:{externalId?:string,issueId:string}[]=[],rejected:{externalId?:string,code:string,message:string}[]=[];
    // A later review round verifies the reporter's previously confirmed findings as part of the same blind task.
    // `reviewComplete` is rejected unless every owed recheck has been explicitly resolved or kept open.
    const alreadyRechecked=new Set(this.store.listIssues(session.sessionId).flatMap(issue=>this.store.listIssueMessages(issue.issueId)
      .filter(message=>message.kind==='recheck'&&Number(message.payload.reviewRound)===session.round&&message.authorId===participant.participantId).map(message=>issue.issueId)));
    const owedRechecks=this.store.listIssues(session.sessionId,{status:['confirmed'],reporterId:participant.participantId})
      .filter(issue=>issue.round<session.round&&!alreadyRechecked.has(issue.issueId));
    const submittedRechecks=input.rechecks.map(entry=>entry.issueId),recheckErrors:FieldError[]=[];
    for(const [index,entry] of input.rechecks.entries()){
      const issue=owedRechecks.find(candidate=>candidate.issueId===entry.issueId);
      if(!issue)recheckErrors.push(fieldError(`rechecks[${index}].issueId`,'UNEXPECTED',`You do not owe a recheck for ${entry.issueId}`));
      if(submittedRechecks.indexOf(entry.issueId)!==index)recheckErrors.push(fieldError(`rechecks[${index}].issueId`,'DUPLICATE','Only one recheck per issue is accepted'));
    }
    if(input.reviewComplete)for(const issue of owedRechecks)if(!submittedRechecks.includes(issue.issueId))recheckErrors.push(fieldError('rechecks','REQUIRED',`A recheck result for confirmed issue ${issue.issueId} is required before completing this review`));
    if(recheckErrors.length)throw new ValidationError(recheckErrors);
    const acceptedRechecks:{issueId:string,outcome:string}[]=[];
    for(const entry of input.rechecks){
      const issue=owedRechecks.find(candidate=>candidate.issueId===entry.issueId)!;
      if(entry.outcome==='resolved')this.store.updateIssue(issue.issueId,{status:'resolved'});
      this.store.addIssueMessage(issue.issueId,session.round,participant.participantId,'recheck',{reviewRound:session.round,outcome:entry.outcome,rationale:entry.rationale,baselineId:baseline.baselineId});
      acceptedRechecks.push({issueId:issue.issueId,outcome:entry.outcome});
      this.record(session.sessionId,'issue_rechecked',{issueId:issue.issueId,outcome:entry.outcome,reviewRound:session.round},participant.participantId);
    }
    for(const finding of input.findings){
      // targetParticipantId is report ownership metadata now, not a mandatory responder. A reviewer-only session
      // is valid, so with no implementer the reporter itself is the harmless default owner.
      const targetId=finding.targetParticipantId??defaultTarget?.participantId??participant.participantId;
      if(!participants.some(entry=>entry.participantId===targetId)){rejected.push({externalId:finding.externalId,code:COLLAB_ERRORS.participantNotFound,message:`Unknown targetParticipantId ${targetId}`});continue}
      const issue=this.store.createIssue({sessionId:session.sessionId,externalId:finding.externalId,reporterId:participant.participantId,targetParticipantId:targetId,
        title:finding.title,severity:finding.severity,category:finding.category,requiredAction:finding.requiredAction,confidence:finding.confidence,
        location:finding.location,evidence:finding.evidence,impact:finding.impact,suggestion:finding.suggestion,baselineId:baseline.baselineId,round:session.round});
      accepted.push({externalId:finding.externalId,issueId:issue.issueId});
      this.record(session.sessionId,'issue_opened',{issueId:issue.issueId,title:issue.title,severity:issue.severity,targetParticipantId:targetId},participant.participantId);
    }
    if(input.reviewComplete)this.store.markPhaseComplete(session.sessionId,session.round,'collecting',participant.participantId);
    const duplicates=this.possibleDuplicates(session.sessionId,accepted.map(entry=>entry.issueId),participant);
    const response={accepted,rejected,rechecks:acceptedRechecks,possibleDuplicates:duplicates,reviewComplete:input.reviewComplete,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'findings_submitted',{count:accepted.length,rejected:rejected.length,reviewComplete:input.reviewComplete},participant.participantId);
    await this.settle(session.sessionId);
    this.dispatchEarlyIssueVotes(session.sessionId);
    return response;
  }

  async submitIssueVotes(participant:Participant,body:unknown){
    const input=parse(issueVotesRequest,body),cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    assertCapability(this.toFlowParticipant(participant),'vote');
    const collected=snapshot.completions.some(entry=>entry.phase==='collecting'&&entry.round===session.round&&entry.participantId===participant.participantId);
    if(session.phase==='collecting'){
      if(!session.policy.consensusReview)throw flowError(COLLAB_ERRORS.wrongPhase,'Issue votes are only accepted after collection when consensus review is enabled');
      if(!collected)throw flowError(COLLAB_ERRORS.wrongPhase,'Issue votes start after this reviewer finishes the blind review');
    }else if(!['validating','issue_reconsidering'].includes(session.phase))throw flowError(COLLAB_ERRORS.wrongPhase,`Issue votes are only accepted in validating or issue_reconsidering, but the session is in ${session.phase}`);
    const consensus=issueConsensus(snapshot),owedNow=session.phase==='issue_reconsidering'
      ?consensus.filter(entry=>activeContestedIssueIds(snapshot).includes(entry.issueId)&&entry.rejecters.includes(participant.participantId)).map(entry=>entry.issueId)
      :owedIssueVoteIds(snapshot,participant.participantId);
    const votable=session.phase==='issue_reconsidering'?owedNow:this.store.listIssues(session.sessionId,{status:['open'],round:session.round}).filter(issue=>issue.reporterId!==participant.participantId).map(issue=>issue.issueId);
    const submitted=input.votes.map(vote=>vote.issueId),errors:FieldError[]=[],dropped=new Set<string>();
    // A missing vote is not a bad request. Findings keep arriving while a reviewer reads code, so the owed set
    // grows underneath it and demanding the set as it stands at submit time threw away a whole turn of work
    // (observed: twelve REQUIRED errors against a reviewer that had voted on everything it was shown). The panel
    // is protected by the phase not completing below, and the hub simply calls this seat back for the rest.
    if(!input.votes.length&&owedNow.length)errors.push(fieldError('votes','REQUIRED','Submit a vote for every finding in yourRequiredIssueIds'));
    for(const [index,vote] of input.votes.entries()){
      const known=this.store.findIssueInSession(session.sessionId,vote.issueId);
      // A finding can leave the votable set between this reviewer's wake-up and its submission: another
      // rejecter voting first can freeze a contested issue (stale), and its reporter can withdraw it. Failing
      // the batch for that throws away every other ballot in the same call - the exact failure the vote
      // relaxation above was introduced to remove - so a no-longer-votable id is dropped instead, the way
      // submitIssueDiscussions drops arguments for findings that closed underneath it.
      if(!known)errors.push(fieldError(`votes[${index}].issueId`,'UNEXPECTED',`${vote.issueId} is not a finding in this session`));
      else if(!votable.includes(vote.issueId)){dropped.add(vote.issueId);continue}
      if(submitted.indexOf(vote.issueId)!==index)errors.push(fieldError(`votes[${index}].issueId`,'DUPLICATE','Only one vote per issue is accepted'));
      if(vote.stance==='reject'&&(vote.rationale??'').trim().length<20)errors.push(fieldError(`votes[${index}].rationale`,'REQUIRED','Rejecting an issue requires a rationale of at least 20 characters'));
    }
    if(session.phase!=='validating'&&input.mergeProposals.length)errors.push(fieldError('mergeProposals','WRONG_PHASE','Merge proposals are only accepted during initial issue validation'));
    if(errors.length)throw new ValidationError(errors);
    const counted=input.votes.filter(vote=>!dropped.has(vote.issueId)),acceptedIds=counted.map(vote=>vote.issueId);
    for(const vote of counted)this.store.saveIssueVote({sessionId:session.sessionId,issueId:vote.issueId,participantId:participant.participantId,round:session.round,consensusRound:session.phase==='validating'?0:session.debateRound,stance:vote.stance,rationale:vote.rationale});
    const proposalIds:string[]=[];
    for(const proposal of input.mergeProposals){
      const issueIds=[...new Set(proposal.issueIds)];
      if(issueIds.length<2||issueIds.some(issueId=>!this.store.findIssueInSession(session.sessionId,issueId)))throw new ValidationError([fieldError('mergeProposals','UNKNOWN_ISSUE','Every merge proposal needs at least two issues from this session')]);
      proposalIds.push(this.store.createMergeProposal({sessionId:session.sessionId,round:session.round,issueIds,participantId:participant.participantId,rationale:proposal.rationale}).proposalId);
    }
    // Completion is measured against the ballot box, not against the request: a reviewer is done when nothing
    // is owed any more, whichever call finally covered it.
    const remaining=this.owedVotesAfter(session,participant,acceptedIds,owedNow);
    if(input.complete&&!remaining.length&&session.phase!=='collecting')this.store.markPhaseComplete(session.sessionId,session.round,session.phase==='issue_reconsidering'?`issue_reconsidering:${session.debateRound}`:session.phase,participant.participantId);
    const response={accepted:acceptedIds,dropped:[...dropped],mergeProposals:proposalIds,complete:input.complete&&!remaining.length,stillOwed:remaining,consensusRound:session.debateRound};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'issue_votes_submitted',{count:acceptedIds.length,dropped:dropped.size,mergeProposals:proposalIds,phase:session.phase,consensusRound:session.debateRound,stillOwed:remaining.length},participant.participantId);
    await this.settle(session.sessionId);
    // Whatever this seat still owes has to come back to it as a task, or the session waits on a reviewer that
    // believes it is finished.
    if(remaining.length)this.requeueVotes(session.sessionId,participant.participantId,remaining.length);
    return response;
  }
  /** Findings this participant still owes a ballot on once the votes in this request are counted. */
  private owedVotesAfter(session:CollabSession,participant:Participant,submitted:string[],owedNow:string[]){
    const covered=new Set(submitted);
    return owedNow.filter(issueId=>!covered.has(issueId));
  }
  private requeueVotes(sessionId:string,participantId:string,owed:number){
    const session=this.store.findSession(sessionId);
    if(!session||session.status!=='active'||!['collecting','validating','issue_reconsidering'].includes(session.phase))return;
    const prefix=session.phase==='issue_reconsidering'?'reconsider_issue_votes':'validate_issues';
    const task=`${prefix}#${owed}`;
    // Dedup on the prefix, not on the whole type: the owed count is part of the type only as a hint, so
    // `validate_issues#3` and `validate_issues#5` would otherwise pile up as two wake-ups for the same seat.
    if(this.store.listInbox(participantId).some(item=>item.type.split('#')[0]===prefix))return;
    this.push(sessionId,participantId,task,{phase:session.phase,round:session.round,owed});
    this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round,remainder:true});
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
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(participant.sessionId);
    assertCapability(this.toFlowParticipant(participant),'debate');
    if(session.phase!=='issue_discussing')throw flowError(COLLAB_ERRORS.wrongPhase,`Issue discussions are only accepted in phase issue_discussing, but the session is in ${session.phase}`);
    const active=new Set(activeContestedIssueIds(snapshot));
    const expected=issueConsensus(snapshot).filter(entry=>active.has(entry.issueId)&&entry.supporters.includes(participant.participantId)).map(entry=>entry.issueId);
    const errors:FieldError[]=[];
    // Withdrawals are validated and applied first: a reporter that no longer stands by a finding must be able to
    // say so in the same call that defends the rest. Two calls are impossible for an agent, because the
    // submission tool ends its turn - which is exactly how three rounds of "I am withdrawing this" prose still
    // reached a human as an unresolved dispute.
    const withdrawn=new Set<string>(),alreadyClosed=new Set<string>();
    for(const [index,entry] of input.withdrawals.entries()){
      const issue=this.store.findIssueInSession(session.sessionId,entry.issueId);
      if(!issue){errors.push(fieldError(`withdrawals[${index}].issueId`,'UNEXPECTED',`${entry.issueId} is not a finding in this session`));continue}
      if(issue.reporterId!==participant.participantId){errors.push(fieldError(`withdrawals[${index}].issueId`,'FORBIDDEN','Only the reporter of a finding may withdraw it; argue it in discussions[] instead'));continue}
      // collab_withdraw_issue does not end the turn, so a model can withdraw standalone and then repeat the id
      // here. Its own finding is already gone: that is the outcome it asked for, not a bad request, and
      // rejecting the batch over it would strand every other finding in the same call.
      if(!expected.includes(entry.issueId)){
        if(!isOpenIssue(this.toFlowIssue(issue))){alreadyClosed.add(entry.issueId);continue}
        errors.push(fieldError(`withdrawals[${index}].issueId`,'UNEXPECTED',`${entry.issueId} is not one of the findings you were asked about`));continue;
      }
      withdrawn.add(entry.issueId);
    }
    const submitted=input.discussions.map(entry=>entry.issueId);
    for(const issueId of expected)if(!submitted.includes(issueId)&&!withdrawn.has(issueId))errors.push(fieldError('discussions','REQUIRED',`Argue or withdraw finding ${issueId}`));
    for(const [index,entry] of input.discussions.entries()){
      // An argument for something already closed (withdrawn here, or by the standalone tool earlier in the same
      // turn) is dropped, not rejected: failing the batch would strand every other finding in it.
      if(withdrawn.has(entry.issueId)||alreadyClosed.has(entry.issueId))continue;
      const known=this.store.findIssueInSession(session.sessionId,entry.issueId);
      if(known&&!expected.includes(entry.issueId)&&!isOpenIssue(this.toFlowIssue(known)))continue;
      if(!expected.includes(entry.issueId))errors.push(fieldError(`discussions[${index}].issueId`,'UNEXPECTED',`You are not currently a supporter of ${entry.issueId}`));
      if(submitted.indexOf(entry.issueId)!==index)errors.push(fieldError(`discussions[${index}].issueId`,'DUPLICATE','Only one argument per finding is accepted'));
    }
    if(!input.discussions.length&&!withdrawn.size&&!alreadyClosed.size)errors.push(fieldError('discussions','REQUIRED','Submit an argument for every finding you still stand by, or withdraw it'));
    if(errors.length)throw new ValidationError(errors);
    const accepted:string[]=[];
    for(const entry of input.withdrawals){
      if(!withdrawn.has(entry.issueId))continue;
      const issue=this.store.getIssue(entry.issueId);
      const outcome=applyWithdraw({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant)});
      this.store.updateIssue(issue.issueId,{status:outcome.status});
      this.store.addIssueMessage(issue.issueId,session.round,participant.participantId,'discussion',{argument:`Withdrawn by the reporter: ${entry.rationale}`,withdrawn:true,consensusRound:session.debateRound});
      this.record(session.sessionId,'issue_withdrawn',{issueId:issue.issueId,rationale:entry.rationale,consensusRound:session.debateRound},participant.participantId);
    }
    for(const entry of input.discussions){
      if(withdrawn.has(entry.issueId)||!expected.includes(entry.issueId))continue;
      this.store.addIssueMessage(entry.issueId,session.round,participant.participantId,'discussion',{argument:entry.argument,respondingTo:entry.respondingTo,consensusRound:session.debateRound});
      accepted.push(entry.issueId);
    }
    if(input.complete)this.store.markPhaseComplete(session.sessionId,session.round,`issue_discussing:${session.debateRound}`,participant.participantId);
    const response={accepted,withdrawn:[...withdrawn],alreadyWithdrawn:[...alreadyClosed],complete:input.complete,consensusRound:session.debateRound};this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'issue_discussions_submitted',{count:accepted.length,withdrawn:withdrawn.size,alreadyWithdrawn:alreadyClosed.size,consensusRound:session.debateRound},participant.participantId);await this.settle(session.sessionId);return response;
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
    if(session.status!=='active')throw flowError(COLLAB_ERRORS.wrongPhase,'A finished review is changed only by a human starting a recheck');
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
    const panel=this.store.listParticipants(session.sessionId).filter(entry=>entry.state!=='left')
      .map(entry=>({participantId:entry.participantId,role:entry.role,displayName:entry.displayName,model:entry.model,isYou:entry.participantId===participant.participantId}));
    const base={sessionId:session.sessionId,kind:session.kind,title:session.title,phase:session.phase,round:session.round,subject:session.subject,
      baseline:baseline?{...baseline,...this.reviewScope(session,baseline)}:baseline,panel,
      you:{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,tokensUsed:participant.tokensUsed,tokenBudget:participant.tokenBudget,state:participant.state},
      progress:sessionProgress(snapshot),stalled:session.stalled};
    if(session.phase==='implementing'){
      if(participant.role!=='implementer'||!waitingOn(snapshot).includes(participant.participantId))return this.waitDigest(session,base,'Another implementer is working. Nothing is required from you; end your turn.');
      // A remediation seat may be a newly added developer, so it receives the whole confirmed action list rather
      // than only findings that originally targeted an older implementer seat.
      const carried=this.store.listIssues(session.sessionId,{status:['confirmed','open']});
      const initial=session.round===1&&session.policy.implementationFirst&&!carried.length;
      return {...base,task:'implement',issues:carried.map(issue=>this.withHistory(issue)),
        instructions:initial
          ?`Implement the requested subject in ${session.cwd}. When the code is ready, call collab_submit_ready with a summary, the changed files and a codeRef (commit or dirtyHash), then end your turn. The hub pins the baseline and calls the reviewers.`
          :`Fix the confirmed review findings listed in issues[] in ${session.cwd}. When the code is ready, call collab_submit_ready with a summary, the changed files and a codeRef (commit or dirtyHash), then end your turn. The hub pins the new baseline and calls the reviewers; there is no per-issue response stage.`};
    }
    if(session.phase==='collecting'){
      const collected=snapshot.completions.some(entry=>entry.phase==='collecting'&&entry.round===session.round&&entry.participantId===participant.participantId);
      if(collected)return this.crossVoteDigest(session,participant,snapshot,base,'You finished the blind review. End your turn; the hub will prompt you if later findings need a vote or the panel moves on.');
      const own=this.store.listIssues(session.sessionId,{reporterId:participant.participantId,round:session.round});
      const issuesToRecheck=this.store.listIssues(session.sessionId,{status:['confirmed'],reporterId:participant.participantId}).filter(issue=>issue.round<session.round).map(issue=>this.withHistory(issue));
      const required=participant.role==='reviewer',reviewerCount=panel.filter(entry=>entry.role==='reviewer').length;
      return {...base,task:required?'file_findings':'file_findings_optional',yourFindings:own,issuesToRecheck,
        rules:{...this.consensusRules(session),severity:SEVERITY_GUIDE,requiredAction:REQUIRED_ACTION_GUIDE,
          blind:`This is a blind review by ${reviewerCount} reviewer(s). You cannot see anyone else's findings yet, and they cannot see yours. Afterwards each of you votes on the others' findings.`,
          scope:'Review exactly the subject, and when baseline.changedFiles is present, those files. Reporting something outside that scope is what the other reviewers vote down.'},
        instructions:`Review the code at the pinned baseline in ${session.cwd} and report every finding in ONE call to collab_submit_findings; that call closes your blind review and ends your turn, so gather everything first. location.path and evidence are mandatory, and evidence must be something you verified in this checkout. ${issuesToRecheck.length?`Also include one rechecks[] entry (outcome resolved or still_present, with a rationale) for each of the ${issuesToRecheck.length} issuesToRecheck entries. `:''}Rate severity and requiredAction by rules.severity and rules.requiredAction, not by how important the finding feels.`};
    }
    if(session.phase==='validating')return this.crossVoteDigest(session,participant,snapshot,base,'You have voted on every finding that needs your ballot. End your turn; the hub calls you back if later findings need one.');
    if(session.phase==='merge_voting'){
      const proposals=this.store.listMergeProposals(session.sessionId),owed=proposals.filter(proposal=>!proposal.votes.some(vote=>vote.participantId===participant.participantId));
      if(!owed.length)return this.waitDigest(session,base);
      return {...base,task:'vote_on_merges',mergeProposals:proposals,yourRequiredProposalIds:owed.map(entry=>entry.proposalId),
        instructions:'Call collab_submit_merge_votes once with a vote on every proposal in yourRequiredProposalIds. A merge is applied only if every reviewer approves it, so reject anything that would fold two genuinely different findings into one; rejecting requires a rationale.'};
    }
    if(session.phase==='issue_discussing'){
      const consensus=this.annotatedConsensus(session,snapshot),active=new Set(activeContestedIssueIds(snapshot));
      const owed=consensus.filter(entry=>active.has(entry.issueId)&&entry.supporters.includes(participant.participantId));
      if(!owed.length)return this.waitDigest(session,base);
      const alone=owed.filter(entry=>entry.reporterId===participant.participantId&&entry.panelRejected).length;
      return {...base,task:'defend_approved_issues',consensus,issues:owed.map(entry=>this.withHistory(this.store.getIssue(entry.issueId))),
        yourRequiredIssueIds:owed.map(entry=>entry.issueId),rules:this.consensusRules(session),
        instructions:`Reviewers rejected the findings in yourRequiredIssueIds and you are a current supporter of each. Call collab_submit_issue_discussions ONCE; it ends your turn, so put everything into that single call. For each finding either answer the rejection with evidence in discussions[], or, if you are its reporter and no longer stand by it, drop it in withdrawals[] with the reason${alone?` — ${alone===1?'one of them is':`${alone} of them are`} now rejected by every other reviewer, so withdrawing is the expected outcome unless you have new evidence`:''}. consensus[].positions holds what the rejecters actually argued. If this genuinely needs the human operator, call collab_escalate first: it does not end your turn.`};
    }
    if(session.phase==='issue_reconsidering'){
      const consensus=this.annotatedConsensus(session,snapshot),active=new Set(activeContestedIssueIds(snapshot));
      const owed=consensus.filter(entry=>active.has(entry.issueId)&&entry.rejecters.includes(participant.participantId));
      if(!owed.length)return this.waitDigest(session,base);
      return {...base,task:'reconsider_issue_votes',consensus,issues:owed.map(entry=>this.withHistory(this.store.getIssue(entry.issueId))),
        yourRequiredIssueIds:owed.map(entry=>entry.issueId),rules:this.consensusRules(session),
        instructions:'Read the supporters\' latest arguments in issues[].history, then call collab_submit_issue_votes once with a vote for every finding in yourRequiredIssueIds. Switch to approve if the argument answered your objection; keeping reject still requires a rationale that engages with what was argued. A rationale that only repeats your previous one ends the discussion for that finding.'};
    }
    return this.waitDigest(session,base);
  }
  /** The panel's own rules, in the prompt, so a vote is cast against a known standard instead of a guess. */
  private consensusRules(session:CollabSession){
    return {vote:VOTE_GUIDE,
      contested:`Any reject makes a finding contested: its supporters answer with evidence, then the rejecters vote again, for at most ${session.policy.maxConsensusRounds} round(s).`,
      outcome:'Still contested at the end: a finding every other reviewer rejected is dropped, a split panel is decided by majority, and only a blocker/critical dispute reaches the human operator.',
      withdraw:'The reporter of a finding may withdraw it at any time (collab_withdraw_issue, or withdrawals[] in collab_submit_issue_discussions). Withdrawing something you no longer stand by is a normal, expected move, not a failure.'};
  }
  /** Consensus board plus the two facts a defender needs: who filed it, and whether anybody else still agrees. */
  private annotatedConsensus(session:CollabSession,snapshot:ReviewSnapshot){
    const panel=this.store.listParticipants(session.sessionId).filter(entry=>entry.role==='reviewer'&&entry.state!=='left');
    return issueConsensus(snapshot).map(entry=>{
      const issue=this.store.getIssue(entry.issueId),voters=panel.filter(reviewer=>reviewer.participantId!==issue.reporterId);
      return {...entry,reporterId:issue.reporterId,severity:issue.severity,title:issue.title,
        panelRejected:voters.length>0&&voters.every(reviewer=>entry.rejecters.includes(reviewer.participantId))};
    });
  }
  /** A seat with nothing to do must be told exactly that: a stale phase blurb reads as work that was not done. */
  private waitDigest(session:CollabSession,base:Record<string,unknown>,reason?:string){
    return {...base,task:'wait',instructions:reason??(session.phase==='awaiting_human'
      ?'A human ruling is pending. Nothing is required from you. Do not resubmit and do not poll; end your turn.'
      :'Nothing is required from you right now. Do not submit anything; end your turn. The hub prompts you when something needs you.')};
  }
  /**
   * The concrete file list behind a review subject. Without it every reviewer re-derives the scope from prose
   * like "git diff master", they end up reviewing different code, and the divergence surfaces later as
   * disagreement about findings rather than about scope. Derived, never persisted: a function of the pinned commit.
   */
  private scopeCache=new Map<string,{changedFiles?:string[],changedFilesTruncated?:boolean}>();
  private scopeKey(session:CollabSession,baseline:{commit?:string,dirtyHash?:string}){return `${session.sessionId}:${baseline.commit??''}:${baseline.dirtyHash??''}`}
  /** Only bare refs/ranges are forwarded, never flags: in the `free` case the value is human-authored prose. */
  private scopeArgs(session:CollabSession){
    const tokens=session.subject.value.split(/\s+/).filter(token=>token&&!token.startsWith('-')&&!['git','diff','log','show'].includes(token)).slice(0,2);
    return ['diff','--name-only',...(tokens.length?tokens:['HEAD'])];
  }
  private toScope(stdout:string){
    const files=stdout.split('\n').map(line=>line.trim()).filter(Boolean);
    return {changedFiles:files.slice(0,200),changedFilesTruncated:files.length>200};
  }
  private reviewScope(session:CollabSession,baseline:{vcs:string,commit?:string,dirtyHash?:string,paths:string[]}){
    if(baseline.vcs!=='git')return {};
    if(session.subject.type==='paths'&&baseline.paths.length)return {changedFiles:baseline.paths,changedFilesTruncated:false};
    const key=this.scopeKey(session,baseline),cached=this.scopeCache.get(key);
    if(cached)return cached;
    // Failures are cached too. A `free` subject is prose ("current branch"), so `git diff --name-only current
    // branch` fails on the *common* path, and an uncached failure re-forked git synchronously - blocking the
    // event loop - on every digest, which currentTaskFor now triggers on every dispatch attempt as well.
    let scope:{changedFiles?:string[],changedFilesTruncated?:boolean}={};
    try{scope=this.toScope(execFileSync('git',this.scopeArgs(session),{cwd:session.cwd,encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','ignore']}))}
    catch{scope={}}
    this.scopeCache.set(key,scope);
    return scope;
  }
  /**
   * Computes the scope where it belongs: once, asynchronously, when the baseline is pinned. The digest then only
   * reads the cache; the synchronous fallback above survives for restarts, where the cache is empty.
   */
  private async warmReviewScope(session:CollabSession,baseline:{vcs:string,commit?:string,dirtyHash?:string,paths:string[]}){
    if(baseline.vcs!=='git'||(session.subject.type==='paths'&&baseline.paths.length))return;
    const key=this.scopeKey(session,baseline);
    if(this.scopeCache.has(key))return;
    try{this.scopeCache.set(key,this.toScope((await run('git',this.scopeArgs(session),{cwd:session.cwd,timeout:10_000,maxBuffer:4*1024*1024})).stdout))}
    catch{this.scopeCache.set(key,{})}
  }

  reviewSummary(sessionId:string){
    const issues=this.store.listIssues(sessionId),severityOrder:Record<string,number>={blocker:0,critical:1,major:2,minor:3,nit:4};
    const entries=issues.map(issue=>{
      const messages=this.store.listIssueMessages(issue.issueId),response=[...messages].reverse().find(message=>message.kind==='response'),verdict=[...messages].reverse().find(message=>message.kind==='verdict');
      const responseType=typeof response?.payload.responseType==='string'?response.payload.responseType:undefined,verdictType=typeof verdict?.payload.verdict==='string'?verdict.payload.verdict:undefined;
      // Historical versions mapped every accepted response to `resolved`. Derive the actionable disposition from
      // the actual response so a deferred finding never disappears from the close-out report as "fixed".
      const disposition=responseType==='deferred'&&verdictType==='accept'?'deferred':responseType==='rejected'&&verdictType==='accept'?'wontfix':responseType==='needs_info'&&verdictType==='accept'?'needs_info':issue.status;
      const requiresAction=['open','confirmed','answered','escalated','deferred','needs_info'].includes(disposition)||responseType==='partially_fixed';
      return {number:issue.number,issueId:issue.issueId,title:issue.title,severity:issue.severity,status:issue.status,disposition,requiresAction,category:issue.category,requiredAction:issue.requiredAction,
        location:issue.location,description:issue.suggestion||issue.impact||issue.evidence||issue.title,evidence:issue.evidence,impact:issue.impact,suggestion:issue.suggestion,
        response:response?{responseType,rationale:response.payload.rationale,changes:response.payload.changes??[]}:undefined,verdict:verdict?{verdict:verdictType,rationale:verdict.payload.rationale}:undefined};
    }).sort((a,b)=>(severityOrder[a.severity]??99)-(severityOrder[b.severity]??99)||a.number-b.number);
    const actionItems=entries.filter(entry=>entry.requiresAction),bySeverity:Record<string,number>={},byDisposition:Record<string,number>={};
    for(const entry of entries){bySeverity[entry.severity]=(bySeverity[entry.severity]??0)+1;byDisposition[entry.disposition]=(byDisposition[entry.disposition]??0)+1}
    const urgent=actionItems.filter(entry=>entry.severity==='blocker'||entry.severity==='critical').length;
    return {description:actionItems.length?`${actionItems.length} issue(s) still require implementation or follow-up${urgent?`, including ${urgent} blocker/critical`:''}.`:`All ${entries.length} reviewed issue(s) have a terminal disposition and no remaining implementation action.`,
      verdict:actionItems.length?(urgent?'changes_required':'follow_up_required'):'approved',totalIssues:entries.length,actionItemCount:actionItems.length,bySeverity,byDisposition,actionItems,issues:entries};
  }
  reviewConsensus(sessionId:string,viewer?:Participant){
    const session=this.store.getSession(sessionId),snapshot=this.snapshot(sessionId);
    if(viewer&&session.phase==='collecting')throw flowError(COLLAB_ERRORS.forbidden,'Consensus data stays sealed until every reviewer finishes collection',403);
    // The state machine only evaluates still-open issues, but the board is also an audit view after finish.
    // Include terminal/resolved/merged issues here so their historical ballots do not disappear at close-out.
    return {phase:session.phase,round:session.round,consensusRound:session.debateRound,issueVotes:this.store.listIssueVotes(sessionId),issueConsensus:issueConsensus(snapshot,{includeFinal:true}),mergeProposals:this.store.listMergeProposals(sessionId),discussions:this.store.listIssues(sessionId).flatMap(issue=>this.store.listIssueMessages(issue.issueId).filter(message=>message.kind==='discussion')),summary:this.reviewSummary(sessionId)};
  }

  /**
   * Per-round audit of a review. The single issue list only ever shows the *current* verdict, so once a recheck
   * flips a finding to `resolved` the board loses the fact that round 2 was the wave that fixed it — and a
   * finding that appeared only in round 3 looks like it was there from the start. Each entry is one wave:
   * what the panel re-verified from earlier rounds, and what it newly found at that round's baseline.
   */
  reviewRounds(sessionId:string){
    const session=this.store.getSession(sessionId);
    if(session.kind!=='review')throw flowError(COLLAB_ERRORS.wrongPhase,'Round history exists for review sessions only');
    const issues=this.store.listIssues(sessionId),events=this.store.listEventsByType(sessionId,['review_reopened','phase_changed','session_finished']);
    const history=new Map(issues.map(issue=>[issue.issueId,this.store.listIssueMessages(issue.issueId)]));
    const rechecksOf=(issueId:string)=>(history.get(issueId)??[]).filter(message=>message.kind==='recheck')
      .map(message=>({round:Number(message.payload.reviewRound??message.round),outcome:String(message.payload.outcome??''),rationale:String(message.payload.rationale??''),reviewerId:message.authorId,at:message.createdAt}));
    const brief=(issue:Issue)=>({issueId:issue.issueId,number:issue.number,title:issue.title,severity:issue.severity,category:issue.category,
      status:issue.status,reporterId:issue.reporterId,location:issue.location,foundInRound:issue.round});
    // A recheck only ever closes an issue by writing `resolved`. Sessions recorded by the older
    // respond/adjudicate flow closed findings with no recheck message at all, so where this round left no
    // recheck evidence the current status decides — otherwise every long-closed legacy finding would be
    // reported forever as "nobody re-verified this".
    const actionable=['open','confirmed','answered','escalated'];
    const rounds=[];
    for(let round=1;round<=session.round;round++){
      const reopened=events.find(event=>event.type==='review_reopened'&&Number(event.payload.round)===round);
      const carried=issues.filter(issue=>{
        if(issue.round>=round)return false;
        const past=rechecksOf(issue.issueId);
        if(past.some(entry=>entry.round<round&&entry.outcome==='resolved'))return false;
        // Being asked to re-verify it at this round or later proves it was still open here.
        if(past.some(entry=>entry.round>=round))return true;
        return actionable.includes(issue.status);
      });
      const rechecks=carried.map(issue=>{
        const done=rechecksOf(issue.issueId).find(entry=>entry.round===round);
        // `pending` is not a reviewer verdict: it is "this wave never reported back on it", which for the live
        // round means still owed and for a closed round means it was carried further without an answer.
        return {...brief(issue),outcome:done?done.outcome:'pending',rationale:done?.rationale??'',reviewerId:done?.reviewerId??issue.reporterId,at:done?.at};
      });
      const newIssues=issues.filter(issue=>issue.round===round).map(issue=>({...brief(issue),
        rechecks:rechecksOf(issue.issueId).filter(entry=>entry.round>round)}));
      const finishedEvent=events.find(event=>event.type==='phase_changed'&&event.payload.to==='finished'&&Number(event.payload.round)===round);
      const closed=finishedEvent?events.find(event=>event.type==='session_finished'&&event.sequence>finishedEvent.sequence):undefined;
      const verdict=(closed?.payload.outcome as {verdict?:string}|undefined)?.verdict;
      rounds.push({round,mode:round===1?'initial':String(reopened?.payload.mode??'recheck'),
        startedAt:round===1?session.createdAt:reopened?.createdAt,finishedAt:finishedEvent?.createdAt,
        status:round<session.round||session.status!=='active'?'finished':'in_progress',
        phase:round===session.round?session.phase:'finished',verdict,
        baseline:this.store.getBaselineForRound(sessionId,round),
        rechecks,newIssues,
        counts:{carried:carried.length,resolved:rechecks.filter(entry=>entry.outcome==='resolved').length,
          stillPresent:rechecks.filter(entry=>entry.outcome==='still_present').length,
          pending:rechecks.filter(entry=>entry.outcome==='pending').length,newIssues:newIssues.length}});
    }
    return rounds;
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
        anchors:nomination.anchors,weight:nomination.weightSuggestion,
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
    const expected=this.store.listCriteria(session.sessionId).filter(criterion=>criterion.state==='candidate').map(criterion=>criterion.criterionId),submitted=input.votes.map(vote=>vote.criterionId),voteErrors:FieldError[]=[];
    for(const criterionId of expected)if(!submitted.includes(criterionId))voteErrors.push(fieldError('votes','REQUIRED',`A vote for criterion ${criterionId} is required`));
    for(const [index,criterionId] of submitted.entries()){
      if(!expected.includes(criterionId))voteErrors.push(fieldError(`votes[${index}].criterionId`,'UNEXPECTED',`Criterion ${criterionId} is not a current candidate`));
      if(submitted.indexOf(criterionId)!==index)voteErrors.push(fieldError(`votes[${index}].criterionId`,'DUPLICATE','Only one vote per criterion is accepted'));
    }
    // A missing rationale fails the whole call *before* anything is written. Reporting it as a per-criterion
    // `rejected[]` entry inside a 200 used to end the agent's turn with that criterion unvoted, so the panel
    // waited on a seat that believed it was finished.
    input.votes.forEach((vote,index)=>{
      if(vote.stance==='reject'&&!(vote.rationale??'').trim())voteErrors.push(fieldError(`votes[${index}].rationale`,'REQUIRED','Rejecting a criterion requires a rationale'));
    });
    if(voteErrors.length)throw new ValidationError(voteErrors);
    const accepted:string[]=[],rejected:{criterionId:string,code:string,message:string}[]=[];
    for(const vote of input.votes){
      const criterion=this.store.findCriterionInSession(session.sessionId,vote.criterionId);
      if(!criterion||criterion.state!=='candidate'){rejected.push({criterionId:vote.criterionId,code:COLLAB_ERRORS.criterionNotFound,message:'Unknown or already decided criterion'});continue}
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
    await this.assertBaselineCurrent(session);
    const {scale}=session.policy.scoring,round=snapshot.phase==='rescoring'?session.debateRound+1:session.debateRound;
    const expected=(snapshot.phase==='rescoring'
      ?this.store.listDebates(session.sessionId).filter(debate=>debate.round===session.debateRound).map(debate=>debate.criterionId)
      :this.store.listCriteria(session.sessionId).filter(criterion=>criterion.state==='approved').map(criterion=>criterion.criterionId));
    const submitted=input.scores.map(entry=>entry.criterionId),errors:FieldError[]=[];
    for(const criterionId of expected)if(!submitted.includes(criterionId))errors.push(fieldError('scores','REQUIRED',`A score for criterion ${criterionId} is required`));
    input.scores.forEach((entry,index)=>{
      if(!expected.includes(entry.criterionId))errors.push(fieldError(`scores[${index}].criterionId`,'UNEXPECTED',`You do not owe a score for ${entry.criterionId} in this phase`));
      if(submitted.indexOf(entry.criterionId)!==index)errors.push(fieldError(`scores[${index}].criterionId`,'DUPLICATE','Only one score per criterion is accepted'));
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
    await this.assertBaselineCurrent(session);
    const debate=this.store.findDebateInSession(session.sessionId,debateId);
    if(!debate||debate.status!=='open')throw flowError(COLLAB_ERRORS.debateNotFound,'Debate not found or already closed',404);
    const argumentId=this.store.addDebateArgument(debateId,{participantId:participant.participantId,stance:input.stance,argument:input.argument,evidence:input.evidence,respondingTo:input.respondingTo});
    const response={argumentId,debateId,criterionId:debate.criterionId};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'debate_argument',{debateId,criterionId:debate.criterionId,stance:input.stance},participant.participantId);
    await this.settleScoring(session.sessionId);
    return response;
  }

  /** Batched tool counterpart: a reviewer must answer every open debate before ending its turn. */
  async submitDebateArguments(participant:Participant,body:unknown){
    const input=parse(debateArgumentsRequest,body),cached=this.replay(participant,input.clientRequestId);if(cached)return cached;
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId);
    assertScoringCapability(this.toFlowParticipant(participant),'debate');
    assertScoringPhase(snapshot,['debating'],'Debating');
    await this.assertBaselineCurrent(session);
    const expected=this.store.listDebates(session.sessionId).filter(debate=>debate.status==='open'&&debate.round===session.debateRound
      &&this.store.listScores(session.sessionId).some(score=>score.criterionId===debate.criterionId&&score.participantId===participant.participantId)
      &&!debate.arguments.some(argument=>argument.participantId===participant.participantId)).map(debate=>debate.debateId);
    const submitted=input.arguments.map(argument=>argument.debateId),errors:FieldError[]=[];
    for(const debateId of expected)if(!submitted.includes(debateId))errors.push(fieldError('arguments','REQUIRED',`An argument for debate ${debateId} is required`));
    for(const [index,debateId] of submitted.entries()){
      if(!expected.includes(debateId))errors.push(fieldError(`arguments[${index}].debateId`,'UNEXPECTED',`You do not owe an argument for ${debateId}`));
      if(submitted.indexOf(debateId)!==index)errors.push(fieldError(`arguments[${index}].debateId`,'DUPLICATE','Only one argument per debate is accepted'));
    }
    if(errors.length)throw new ValidationError(errors);
    const accepted=input.arguments.map(entry=>{
      const debate=this.store.findDebateInSession(session.sessionId,entry.debateId)!;
      const argumentId=this.store.addDebateArgument(entry.debateId,{participantId:participant.participantId,stance:entry.stance,argument:entry.argument,evidence:entry.evidence,respondingTo:entry.respondingTo});
      this.record(session.sessionId,'debate_argument',{debateId:entry.debateId,criterionId:debate.criterionId,stance:entry.stance},participant.participantId);
      return {debateId:entry.debateId,argumentId};
    });
    const response={accepted,round:session.debateRound};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
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
    this.store.updateSession(sessionId,{phase:'finalized',status:'finished',outcome:{...(session.outcome??{}),...report,rulings:input.rulings,resolvedBy}});
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
      const session=this.store.getSession(sessionId);let snapshot=this.scoringSnapshot(sessionId);
      if(session.status!=='active')return;
      if(session.phase==='consolidating'){this.consolidateCriteria(sessionId);snapshot=this.scoringSnapshot(sessionId)}
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
      const rubricOutcome=result.rubric?{...(session.outcome??{}),rubricLockedBy:result.rubric.lockedBy,rubricLockReason:result.rubric.reason}:session.outcome;
      const updated=this.store.updateSession(sessionId,{phase:result.phase,round:result.round,debateRound:result.debateRound,
        status:finalized?'finished':session.status,stalled:undefined,
        outcome:finalized?{...(rubricOutcome??{}),...finalizeScores(this.scoringSnapshot(sessionId))}:rubricOutcome});
      this.record(sessionId,'phase_changed',{from:session.phase,to:result.phase,round:result.round,debateRound:result.debateRound,reason:result.reason,
        ...(forced&&guard===0?{forced:true,forceReason:reason,skipped:result.skipped??[]}:{}),...(result.contested?{contested:result.contested}:{})});
      if(result.rubric)this.record(sessionId,'rubric_locked',{lockedBy:result.rubric.lockedBy,reason:result.rubric.reason,criteria:result.rubric.criteria});
      if(finalized){this.record(sessionId,'session_finished',{outcome:updated.outcome??{}});this.announceFinish(this.store.getSession(sessionId));return}
      if(result.phase==='awaiting_human')this.raiseScoringEscalation(updated,result.contested??[]);
      this.dispatchScoring(sessionId);
    }
  }
  /** Deterministically merges only certain duplicates: normalized names must be identical. Ambiguous semantics stay separate for the panel. */
  private consolidateCriteria(sessionId:string){
    const candidates=this.store.listCriteria(sessionId).filter(criterion=>criterion.state==='candidate'),groups=new Map<string,typeof candidates>();
    const key=(name:string)=>name.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
    for(const criterion of candidates){const normalized=key(criterion.name);groups.set(normalized,[...(groups.get(normalized)??[]),criterion])}
    for(const entries of groups.values()){
      if(entries.length<2)continue;
      const [primary,...duplicates]=entries;
      const detailed=[...entries].sort((a,b)=>b.definition.length-a.definition.length||a.createdAt.localeCompare(b.createdAt))[0];
      const anchored=[...entries].sort((a,b)=>Object.keys(b.anchors??{}).length-Object.keys(a.anchors??{}).length)[0];
      const sources=entries.flatMap(entry=>Array.isArray((entry.source as any)?.sources)?(entry.source as any).sources:[entry.source].filter(Boolean));
      this.store.updateCriterion(primary.criterionId,{definition:detailed.definition,anchors:anchored.anchors,source:{sources,mergedCriterionIds:duplicates.map(entry=>entry.criterionId)}});
      for(const duplicate of duplicates)this.store.updateCriterion(duplicate.criterionId,{state:'rejected'});
      this.record(sessionId,'criteria_consolidated',{criterionId:primary.criterionId,mergedCriterionIds:duplicates.map(entry=>entry.criterionId),reason:'identical_normalized_name'});
    }
  }
  private applyRubric(sessionId:string,rubric:{criteria:{criterionId:string,weight:number}[],rejected:string[]}){
    for(const entry of rubric.criteria)this.store.updateCriterion(entry.criterionId,{state:'approved',weight:entry.weight});
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
    const session=this.store.getSession(participant.sessionId),snapshot=this.scoringSnapshot(session.sessionId),criteria=this.store.listCriteria(session.sessionId),votes=this.store.listVotes(session.sessionId),scores=this.store.listScores(session.sessionId),debates=this.store.listDebates(session.sessionId);
    const byId=(ids:string[])=>ids.map(id=>criteria.find(criterion=>criterion.criterionId===id)).filter((entry):entry is NonNullable<typeof entry>=>!!entry);
    const base={sessionId:session.sessionId,kind:session.kind,title:session.title,phase:session.phase,round:session.round,debateRound:session.debateRound,
      subject:session.subject,baseline:this.store.getBaselineForRound(session.sessionId,1),scoringPolicy:session.policy.scoring,
      you:{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,tokensUsed:participant.tokensUsed,tokenBudget:participant.tokenBudget,state:participant.state},
      progress:scoringProgress(snapshot),stalled:session.stalled};
    if(session.phase==='nominating'){
      const previousRound=session.round>1?session.round-1:undefined;
      return {...base,task:'nominate_criteria',yourNominations:criteria.filter(criterion=>criterion.round===session.round&&(criterion.source as any)?.participantId===participant.participantId),
        existingCandidates:criteria.filter(criterion=>criterion.state==='candidate'&&criterion.round<session.round),
        previousRound:previousRound?{round:previousRound,tallies:tallyVotes(snapshot,previousRound),amendments:votes.filter(vote=>vote.round===previousRound&&vote.amendment)}:undefined,
        instructions:`Propose enough distinct scoring criteria to help the panel reach ${session.policy.scoring.minCriteria}-${session.policy.scoring.maxCriteria} dimensions. Include a definition and concrete score anchors. Your current-round proposals stay blind until every reviewer finishes.`};
    }
    if(session.phase==='voting'){
      const candidates=criteria.filter(criterion=>criterion.state==='candidate'),required=candidates.filter(criterion=>!votes.some(vote=>vote.criterionId===criterion.criterionId&&vote.participantId===participant.participantId&&vote.round===session.round)).map(criterion=>criterion.criterionId),previousRound=session.round>1?session.round-1:undefined;
      return {...base,task:'vote_on_criteria',candidates,yourRequiredCriterionIds:required,
        previousRound:previousRound?{round:previousRound,tallies:tallyVotes(snapshot,previousRound),amendments:votes.filter(vote=>vote.round===previousRound&&vote.amendment)}:undefined,
        instructions:`Vote approve, reject, or abstain on every required candidate. The rubric needs ${session.policy.scoring.minCriteria}-${session.policy.scoring.maxCriteria} dimensions. Suggest a weight for approvals; rejecting requires a rationale.`};
    }
    if(session.phase==='scoring'){
      const rubric=criteria.filter(criterion=>criterion.state==='approved'),required=rubric.filter(criterion=>!scores.some(score=>score.criterionId===criterion.criterionId&&score.participantId===participant.participantId&&score.round===session.debateRound)).map(criterion=>criterion.criterionId);
      return {...base,task:'score_rubric',rubric,yourRequiredCriterionIds:required,
        instructions:`Score every required criterion on the ${session.policy.scoring.scale.min}-${session.policy.scoring.scale.max} scale in increments of ${session.policy.scoring.scale.step}. Apply its definition and anchors independently. Every score needs a rationale and file evidence.`};
    }
    if(session.phase==='debating'){
      const open=debates.filter(debate=>debate.status==='open'&&debate.round===session.debateRound),required=open.filter(debate=>scores.some(score=>score.criterionId===debate.criterionId&&score.participantId===participant.participantId)&&!debate.arguments.some(argument=>argument.participantId===participant.participantId)).map(debate=>debate.debateId);
      return {...base,task:'debate_contested_scores',debates:open.map(debate=>({...debate,criterion:criteria.find(entry=>entry.criterionId===debate.criterionId)})),yourRequiredDebateIds:required,analysis:analyse(snapshot),scoreDetails:scores.filter(score=>open.some(debate=>debate.criterionId===score.criterionId)&&score.round===session.debateRound),
        instructions:'Address every required debate using the criterion definition, score evidence, and other panelists arguments. Use hold if you keep your score, raise/lower if the evidence changes your position.'};
    }
    if(session.phase==='rescoring'){
      const contested=[...new Set(debates.filter(debate=>debate.round===session.debateRound).map(debate=>debate.criterionId))],nextRound=session.debateRound+1,required=contested.filter(criterionId=>!scores.some(score=>score.criterionId===criterionId&&score.participantId===participant.participantId&&score.round===nextRound));
      return {...base,task:'rescore_contested',rubric:byId(contested),yourRequiredCriterionIds:required,analysis:analyse(snapshot),
        debates:debates.filter(debate=>debate.round===session.debateRound).map(debate=>({...debate,criterion:criteria.find(entry=>entry.criterionId===debate.criterionId)})),scoreDetails:scores.filter(score=>contested.includes(score.criterionId)&&score.round<=session.debateRound),
        instructions:`Rescore every required contested criterion on the ${session.policy.scoring.scale.min}-${session.policy.scoring.scale.max} scale after reading the debate. Evidence and rationale remain mandatory; changeReason must explain both a change and an explicit hold.`};
    }
    return {...base,task:'wait',instructions:session.phase==='awaiting_human'?'A human is ruling on the contested criteria. End your turn.':'Nothing is required from you right now. End your turn.'};
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
  private async applyPhase(session:CollabSession,result:AdvanceResult,context:{forced?:boolean,reason?:string,actor?:string}){
    const finished=result.phase==='finished';
    if(context.forced&&result.skipped?.length){
      const completionPhase=['issue_discussing','issue_reconsidering'].includes(session.phase)?`${session.phase}:${session.debateRound}`:session.phase;
      for(const participantId of result.skipped)this.store.markPhaseComplete(session.sessionId,session.round,completionPhase,participantId);
      if(session.phase==='merge_voting')for(const proposal of this.store.listMergeProposals(session.sessionId).filter(entry=>entry.round===session.round))for(const participantId of result.skipped)if(!proposal.votes.some(vote=>vote.participantId===participantId))this.store.saveMergeVote({proposalId:proposal.proposalId,participantId,stance:'reject',rationale:`Skipped by forced advance: ${context.reason||'no reason given'}`});
    }
    if(session.phase==='merge_voting'&&result.phase==='consolidating')this.applyApprovedMerges(session.sessionId);
    if(result.resolutions?.length)this.applyContestedResolutions(session,result.resolutions);
    // Pin the baseline *before* the phase is visible: otherwise a reviewer that polls in between sees
    // `collecting` with no baseline and its findings bounce off with STALE_BASELINE.
    if(result.phase==='collecting'&&(result.round!==session.round||session.phase==='implementing'))await this.captureBaseline({...session,phase:result.phase,round:result.round});
    // Panel-approved findings are final review output, not workflow-blocking "open" negotiations. They stay
    // actionable as `confirmed` until a later explicit recheck resolves them.
    if(finished)for(const issue of this.store.listIssues(session.sessionId,{status:['open'],round:result.round})){
      this.store.updateIssue(issue.issueId,{status:'confirmed'});
      this.record(session.sessionId,'issue_confirmed',{issueId:issue.issueId,round:result.round});
    }
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
    await this.warmReviewScope(session,baseline);
    return baseline;
  }
  /** The id names a snapshot, but the live workspace must still match it when a reviewer submits evidence. */
  private async assertBaselineCurrent(session:CollabSession,baseline=this.store.getBaselineForRound(session.sessionId,session.kind==='scoring'?1:session.round)){
    if(!baseline||baseline.vcs==='none')return;
    const current=await this.resolveBaseline({cwd:session.cwd,subject:session.subject,round:baseline.round});
    if(current.vcs!==baseline.vcs||current.commit!==baseline.commit||current.dirtyHash!==baseline.dirtyHash||(baseline.rangeResolved!==undefined&&current.rangeResolved!==baseline.rangeResolved))
      throw Object.assign(flowError(COLLAB_ERRORS.staleBaseline,'The workspace changed after this collaboration baseline was captured. Refresh or restart the review against a new baseline.'),{currentBaseline:{...current,round:baseline.round}});
  }
  /**
   * Cross-voting is one task with two entry points: a reviewer that already closed its blind review while the
   * panel is still `collecting`, and the whole panel in `validating`. Both ask the same question - what do I
   * still owe a ballot on - so both come through here, and a seat that owes nothing simply waits: the typed
   * submission tool has no empty ballot, and `requiredActors` does not wait for that seat either.
   */
  private crossVoteDigest(session:CollabSession,participant:Participant,snapshot:ReviewSnapshot,base:Record<string,unknown>,idle:string){
    const owed=owedIssueVoteIds(snapshot,participant.participantId);
    if(!owed.length)return this.waitDigest(session,base,idle);
    return {...base,task:'validate_issues',issues:this.store.listIssues(session.sessionId,{status:['open'],round:session.round}).map(issue=>this.withHistory(issue)),
      yourRequiredIssueIds:owed,currentVotes:currentIssueVotes(snapshot),mergeProposals:this.store.listMergeProposals(session.sessionId),
      rules:{...this.consensusRules(session),severity:SEVERITY_GUIDE},
      instructions:session.phase==='collecting'
        ?'You finished your blind review; other reviewers are still filing. Verify each finding in yourRequiredIssueIds against the code yourself, then call collab_submit_issue_votes once with a vote for every one of them. Voting on the set you were given is enough: the hub calls you again for findings that arrive later. A reject needs a rationale. Do not wait, sleep or poll. Merge proposals wait until every reviewer has filed.'
        :'Every reviewer has finished the blind review. Verify each finding in yourRequiredIssueIds against the code yourself - approve and reject are claims about the code, not impressions - then call collab_submit_issue_votes once with a vote for each. A reject needs a rationale of at least 20 characters. Put findings that are genuinely the same defect into mergeProposals. Fixing is a separate, human-triggered cycle; this review ends at consensus.'};
  }
  /**
   * Cross-votes should not wait for the slowest collector. As soon as two reviewers have closed their own
   * findings, each already-finished reviewer can validate the issues that are already on the table.
   */
  dispatchEarlyIssueVotes(sessionId:string){
    const session=this.store.findSession(sessionId);
    if(!session||session.kind!=='review'||session.phase!=='collecting'||session.status!=='active'||!session.policy.consensusReview)return [];
    const snapshot=this.snapshot(sessionId),assigned:string[]=[];
    for(const participantId of pendingCrossVoters(snapshot)){
      const owed=owedIssueVoteIds(snapshot,participantId),task=`validate_issues#${owed.length}`;
      // Findings arrive one wave at a time, so the owed count grows: dedup on the prefix or the same seat
      // collects validate_issues#2, #5, #9 as separate durable items and separate wake-ups.
      if(!owed.length||this.store.listInbox(participantId).some(item=>item.type.split('#')[0]==='validate_issues'))continue;
      this.push(sessionId,participantId,task,{phase:session.phase,round:session.round,owed:owed.length});
      this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round,early:true});
      assigned.push(participantId);
    }
    return assigned;
  }
  /** Restart recovery: finished collectors that still owe votes must be re-queued, not left idle until the last finding. */
  recoverEarlyIssueVotes(){
    for(const session of this.store.listSessions({status:'active',limit:200}))this.dispatchEarlyIssueVotes(session.sessionId);
  }
  /** Queues the task for every participant that now owes work. Managed agents are woken from this queue. */
  private dispatch(sessionId:string){
    const session=this.store.getSession(sessionId),participants=this.store.listParticipants(sessionId).filter(participant=>participant.state==='active');
    const targets=new Map<string,string>();
    if(session.phase==='implementing')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'implement');
    // In build-then-review the implementer is writing code, not filing reverse findings, so it gets no task here.
    if(session.phase==='collecting')for(const participant of participants)if(participant.role!=='moderator'&&!(session.policy.implementationFirst&&participant.role==='implementer'))targets.set(participant.participantId,participant.role==='reviewer'?'file_findings':'file_findings_optional');
    if(session.phase==='validating')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'validate_issues');
    if(session.phase==='merge_voting')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'vote_on_merges');
    if(session.phase==='issue_discussing')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'defend_approved_issues');
    if(session.phase==='issue_reconsidering')for(const participantId of waitingOn(this.snapshot(sessionId)))targets.set(participantId,'reconsider_issue_votes');
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
  /**
   * Final disposition of every finding the panel could not agree on. Only a genuine judgment call reaches the
   * human: a serious finding with a split panel, or a serious finding the whole panel rejected over its
   * reporter's objection. The rest is decided here and recorded, because handing a person six "is this an issue?"
   * questions per review is the same as having no panel at all.
   */
  private applyContestedResolutions(session:CollabSession,resolutions:ContestedResolution[]){
    const snapshot=this.snapshot(session.sessionId);
    for(const resolution of resolutions){
      const issue=this.store.getIssue(resolution.issueId);
      if(resolution.disposition!=='escalate'){
        const status=resolution.disposition==='majority_confirmed'?'confirmed':'wontfix';
        this.store.updateIssue(issue.issueId,{status});
        this.store.addIssueMessage(issue.issueId,session.round,'system','ruling',{decision:resolution.disposition,rationale:resolution.reason,
          supporters:resolution.supporters,rejecters:resolution.rejecters,consensusRound:session.debateRound});
        this.record(session.sessionId,'issue_panel_ruled',{issueId:issue.issueId,disposition:resolution.disposition,reason:resolution.reason,status,
          severity:issue.severity,supporters:resolution.supporters,rejecters:resolution.rejecters});
        continue;
      }
      if(this.store.findPendingEscalation(session.sessionId,'issue_dispute',issue.issueId))continue;
      this.store.updateIssue(issue.issueId,{status:'escalated'});
      const voteHistory=this.store.listIssueVotes(session.sessionId).filter(vote=>vote.issueId===issue.issueId).map(vote=>({participantId:vote.participantId,stance:`vote round ${vote.consensusRound}: ${vote.stance}`,rationale:vote.rationale??'approved without an additional rationale'}));
      const discussions=this.store.listIssueMessages(issue.issueId).filter(message=>message.kind==='discussion').map(message=>({participantId:message.authorId,stance:`discussion round ${message.payload.consensusRound??'?'}`,rationale:String(message.payload.argument??'')}));
      const current=issueConsensus(snapshot).find(entry=>entry.issueId===issue.issueId);
      const implicit=(current?.positions??[]).filter(position=>position.implicit).map(position=>({participantId:position.participantId,stance:'initial approve (reporter)',rationale:'issue reporter implicitly approves'}));
      const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:'issue_dispute',refId:issue.issueId,raisedBy:'system',
        summary:resolution.reason==='panel_unanimously_rejected'
          ?`Every other reviewer rejected this ${issue.severity} finding, but its reporter did not withdraw it: ${issue.title}`
          :`The panel split on this ${issue.severity} finding and did not converge in ${session.debateRound} discussion round(s): ${issue.title}`,
        positions:[...implicit,...voteHistory,...discussions],question:`Should "${issue.title}" proceed to implementation?`,
        options:['valid issue','not an issue','needs more investigation'],urgency:issue.severity==='blocker'||issue.severity==='critical'?'high':'normal'});
      this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:'issue_dispute',refId:issue.issueId,reason:resolution.reason,
        supporters:resolution.supporters,rejecters:resolution.rejecters});
    }
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
   */
  private announceFinish(session:CollabSession){
    const participants=this.store.listParticipants(session.sessionId).filter(participant=>participant.state!=='left');
    for(const participant of participants){
      this.push(session.sessionId,participant.participantId,'session_result',{phase:session.phase,round:session.round,outcome:session.outcome??{}});
      this.record(session.sessionId,'task_assigned',{participantId:participant.participantId,task:'session_result',phase:session.phase,round:session.round});
    }
  }
  private outcome(sessionId:string){
    const issues=this.store.listIssues(sessionId),byStatus:Record<string,number>={};
    for(const issue of issues)byStatus[issue.status]=(byStatus[issue.status]??0)+1;
    const snapshot=this.snapshot(sessionId),approval=approvalSummary(snapshot);
    const summary=this.reviewSummary(sessionId);
    return {totalIssues:issues.length,byStatus,
      // A review now closes with confirmed action items. The verdict describes the report, not whether every
      // finding went through the removed response/adjudication negotiation.
      verdict:summary.verdict,
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
  private toFlowIssue(issue:Issue):FlowIssue{return {issueId:issue.issueId,reporterId:issue.reporterId,targetParticipantId:issue.targetParticipantId,status:issue.status,round:issue.round,severity:issue.severity}}
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
