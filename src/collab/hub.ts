import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {COLLAB_ERRORS,type CollabEvent,type CollabSession,type CollabSubject,type Escalation,type Issue,type Participant,type ReviewPhase,type ScoringPhase} from './types.js';
import {CollabStore,type CreateSessionInput} from './store.js';
import {ValidationError,parse,type FieldError} from './validate.js';
import {advanceRequest,createParticipantRequest,createSessionRequest,debateArgumentRequest,escalationRequest,findingsRequest,finalizeRequest,nominationsRequest,policyPatch,resolveEscalationRequest,responsesRequest,scoresRequest,verdictsRequest,votesRequest} from './schemas.js';
import {analyse,assertScoringCapability,assertScoringPhase,approvedCriteria,contestedCriteria,finalizeScores,isScoringReadyToAdvance,lockRubric,nextScoringPhase,nominationsSealed,scoresSealed,scoringPanel,scoringProgress,scoringWaitingOn,tallyVotes,votesSealed,type ScoringSnapshot} from './scoring-flow.js';
import {applyEscalation,applyHumanRuling,applyResponse,applyVerdict,applyWithdraw,assertCanFileFinding,assertCapability,canSeeOthersFindings,flowError,isReadyToAdvance,nextPhase,sessionProgress,stallCheck,waitingOn,type FlowIssue,type FlowParticipant,type ReviewSnapshot} from './review-flow.js';

const run=promisify(execFile);

export type BaselineSnapshot={vcs:string,commit?:string,range?:string,dirtyHash?:string,paths:string[]};
export type BaselineResolver=(input:{cwd:string,subject:CollabSubject,round:number})=>Promise<BaselineSnapshot>;
export type HubOptions={resolveBaseline?:BaselineResolver,now?:()=>number,agentTokenUsage?:(agentId:string)=>Promise<number|undefined>};

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
  private readonly resolveBaseline:BaselineResolver;
  private readonly now:()=>number;
  constructor(readonly store:CollabStore,private readonly options:HubOptions={}){
    this.resolveBaseline=options.resolveBaseline??gitBaseline;
    this.now=options.now??(()=>Date.now());
  }
  init(){this.store.init()}
  subscribe(listener:(event:CollabEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  private emit(event:CollabEvent){for(const listener of this.listeners)try{listener(event)}catch{/* A broken subscriber must not roll back committed state. */}}
  private record(sessionId:string,type:string,payload:Record<string,unknown>={},actorId?:string){const event=this.store.appendEvent(sessionId,type,payload,actorId);this.emit(event);return event}

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
  addParticipant(sessionId:string,body:unknown){
    const input=parse(createParticipantRequest,body),session=this.store.getSession(sessionId);
    if(input.binding.type==='managed'&&!input.binding.agentId)throw new ValidationError([fieldError('binding.agentId','REQUIRED','A managed participant must reference an agentId')]);
    // One agent may not hold two seats: a single model must not be able to vote twice.
    if(input.binding.agentId&&this.store.listParticipants(sessionId).some(existing=>existing.binding.agentId===input.binding.agentId))
      throw flowError(COLLAB_ERRORS.conflict,'That agent is already registered in this session');
    const {participant,token}=this.store.createParticipant({sessionId,role:input.role,displayName:input.displayName,model:input.model,bindingType:input.binding.type,agentId:input.binding.agentId,tokenBudget:input.tokenBudget});
    this.record(sessionId,'participant_added',{participantId:participant.participantId,role:participant.role,displayName:participant.displayName,binding:participant.binding,model:participant.model});
    if(session.kind==='scoring'&&session.phase==='nominating'&&participant.role==='reviewer'){
      this.store.pushInbox(sessionId,participant.participantId,'nominate_criteria',{phase:session.phase,round:session.round});
      this.record(sessionId,'task_assigned',{participantId:participant.participantId,task:'nominate_criteria',phase:session.phase,round:session.round});
    }
    return {participant,token,session};
  }
  /** Moves a review session from draft into its first collecting phase and pins the baseline. */
  async openRound(sessionId:string){
    const session=this.store.getSession(sessionId);
    if(session.phase!=='draft')throw flowError(COLLAB_ERRORS.wrongPhase,`Round already open: session is in phase ${session.phase}`);
    if(!this.store.listParticipants(sessionId).some(participant=>participant.role==='reviewer'))throw flowError(COLLAB_ERRORS.wrongPhase,'Register at least one reviewer before opening the round');
    const updated=this.store.updateSession(sessionId,{phase:'collecting'});
    await this.captureBaseline(updated);
    this.record(sessionId,'phase_changed',{from:'draft',to:'collecting',round:updated.round,reason:'round_opened'});
    this.dispatch(sessionId);
    return this.store.getSession(sessionId);
  }
  /** The only way to move past participants that never submitted. Everything about the override is logged. */
  async advance(sessionId:string,body:unknown,actor='human'){
    const input=parse(advanceRequest,body),session=this.store.getSession(sessionId);
    if(session.kind==='scoring'){
      const pendingPanel=scoringWaitingOn(this.scoringSnapshot(sessionId));
      if(pendingPanel.length&&!input.force)throw flowError(COLLAB_ERRORS.wrongPhase,`Still waiting on ${pendingPanel.length} panelist(s): ${pendingPanel.join(', ')}. Pass force=true to override.`);
      if(pendingPanel.length&&!input.reason.trim())throw new ValidationError([fieldError('reason','REQUIRED','A forced advance must state why the pending panelists are being skipped')]);
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
  listEscalations(filter:{sessionId?:string,status?:'pending'|'resolved'|'dismissed',limit?:number}={}){return this.store.listEscalations(filter)}
  getEscalation(escalationId:string){return this.store.getEscalation(escalationId)}
  /** A human ruling is terminal: the issue moves to a status no agent may change. */
  async resolveEscalation(escalationId:string,body:unknown,resolvedBy='human'){
    const input=parse(resolveEscalationRequest,body),escalation=this.store.getEscalation(escalationId);
    if(escalation.status!=='pending')throw flowError(COLLAB_ERRORS.conflict,`Escalation is already ${escalation.status}`);
    const resolved=this.store.resolveEscalation(escalationId,{decision:input.decision,rationale:input.rationale,issueDecision:input.issueDecision,extra:input.extra},resolvedBy);
    if(escalation.refId&&input.issueDecision){
      const issue=this.store.getIssue(escalation.refId),outcome=applyHumanRuling(this.toFlowIssue(issue),input.issueDecision);
      this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round});
      this.store.addIssueMessage(issue.issueId,outcome.round,resolvedBy,'ruling',{decision:input.decision,rationale:input.rationale,issueDecision:input.issueDecision});
      this.record(escalation.sessionId,'issue_ruled',{issueId:issue.issueId,status:outcome.status,decision:input.issueDecision},resolvedBy);
    }
    this.record(escalation.sessionId,'escalation_resolved',{escalationId,decision:input.decision,rationale:input.rationale},resolvedBy);
    await this.settle(escalation.sessionId);
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
    const duplicates=this.possibleDuplicates(session.sessionId,accepted.map(entry=>entry.issueId));
    const response={accepted,rejected,possibleDuplicates:duplicates,reviewComplete:input.reviewComplete,round:session.round};
    this.finish(participant,input.clientRequestId,body,input.usage,response);
    this.record(session.sessionId,'findings_submitted',{count:accepted.length,rejected:rejected.length,reviewComplete:input.reviewComplete},participant.participantId);
    await this.settle(session.sessionId);
    return response;
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
      const outcome=applyEscalation({issue:this.toFlowIssue(issue),actor:this.toFlowParticipant(participant)});
      this.store.updateIssue(issue.issueId,{status:outcome.status,round:outcome.round});
    }
    const escalation=this.store.createEscalation({sessionId:session.sessionId,kind:input.kind,refId:input.refId,raisedBy:participant.participantId,
      summary:input.summary,positions:input.positions,question:input.question,options:input.options,urgency:input.urgency});
    this.finish(participant,input.clientRequestId,body,input.usage,escalation);
    this.record(session.sessionId,'escalation_raised',{escalationId:escalation.escalationId,kind:escalation.kind,refId:escalation.refId,question:escalation.question,urgency:escalation.urgency},participant.participantId);
    await this.settle(session.sessionId);
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
    if(session.phase==='collecting'){
      const own=this.store.listIssues(session.sessionId,{reporterId:participant.participantId,round:session.round});
      const required=participant.role==='reviewer';
      return {...base,task:required?'file_findings':'file_findings_optional',yourFindings:own,
        instructions:`Review the code at the pinned baseline and POST every finding to /api/v1/collab/sessions/${session.sessionId}/findings with baselineId="${baseline?.baselineId??''}". Set reviewComplete=true on your final call. location.path and evidence are mandatory.`};
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
    return {...base,task:'wait',instructions:session.phase==='awaiting_human'?'A human ruling is pending. Do not resubmit; you will be notified.':'Nothing is required from you right now.'};
  }

  /** Blind review: while findings are being collected, a participant only sees their own. */
  listIssues(participant:Participant){
    const session=this.store.getSession(participant.sessionId),snapshot=this.snapshot(session.sessionId);
    const issues=this.store.listIssues(session.sessionId);
    if(canSeeOthersFindings(snapshot))return issues;
    return issues.filter(issue=>issue.reporterId===participant.participantId||issue.targetParticipantId===participant.participantId);
  }
  events(sessionId:string,since=0,limit=500){return this.store.listEvents(sessionId,since,limit)}
  progress(sessionId:string){return this.store.getSession(sessionId).kind==='scoring'?scoringProgress(this.scoringSnapshot(sessionId)):sessionProgress(this.snapshot(sessionId))}
  issueDetail(sessionId:string,issueId:string){
    const issue=this.store.findIssueInSession(sessionId,issueId);
    if(!issue)throw flowError(COLLAB_ERRORS.issueNotFound,'Issue not found in this session',404);
    return this.withHistory(issue);
  }
  inbox(participant:Participant){
    const items=this.store.listInbox(participant.participantId);
    this.store.markDelivered(items.map(item=>item.itemId));
    return items;
  }
  ackInbox(participant:Participant,itemIds:string[]){this.store.ackInbox(participant.participantId,itemIds);return {acknowledged:itemIds.length}}

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
  /** Human ruling on the criteria a panel could not settle; it also closes the session. */
  async finalizeScoring(sessionId:string,body:unknown,resolvedBy='human'){
    const input=parse(finalizeRequest,body),session=this.store.getSession(sessionId);
    if(session.kind!=='scoring')throw flowError(COLLAB_ERRORS.wrongPhase,'Only scoring sessions can be finalized');
    const snapshot=this.scoringSnapshot(sessionId);
    const rulings=Object.fromEntries(input.rulings.map(ruling=>[ruling.criterionId,ruling.score]));
    const report=finalizeScores(snapshot,rulings);
    this.store.updateSession(sessionId,{phase:'finalized',status:'finished',outcome:{...report,rulings:input.rulings,resolvedBy}});
    this.record(sessionId,'session_finished',{outcome:report},resolvedBy);
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
      if(result.phase==='debating')for(const criterionId of result.contested??[])this.store.createDebate(sessionId,criterionId,session.debateRound);
      if(result.phase==='rescoring')this.store.closeDebates(sessionId,session.debateRound);
      const finalized=result.phase==='finalized';
      const updated=this.store.updateSession(sessionId,{phase:result.phase,round:result.round,debateRound:result.debateRound,
        status:finalized?'finished':session.status,stalled:undefined,
        outcome:finalized?{...finalizeScores(this.scoringSnapshot(sessionId)),lockedBy:'panel'}:session.outcome});
      this.record(sessionId,'phase_changed',{from:session.phase,to:result.phase,round:result.round,debateRound:result.debateRound,reason:result.reason,
        ...(forced&&guard===0?{forced:true,forceReason:reason,skipped:result.skipped??[]}:{}),...(result.contested?{contested:result.contested}:{})});
      if(result.rubric)this.record(sessionId,'rubric_locked',{lockedBy:result.rubric.lockedBy,reason:result.rubric.reason,criteria:result.rubric.criteria});
      if(finalized){this.record(sessionId,'session_finished',{outcome:updated.outcome??{}});return}
      if(result.phase==='awaiting_human')this.raiseScoringEscalation(updated,result.contested??[]);
      this.dispatchScoring(sessionId);
    }
  }
  private applyRubric(sessionId:string,rubric:{criteria:{criterionId:string,weight:number}[],rejected:string[]}){
    for(const entry of rubric.criteria)this.store.updateCriterion(entry.criterionId,{state:'approved',weight:entry.weight});
    for(const criterionId of rubric.rejected)this.store.updateCriterion(criterionId,{state:'rejected'});
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
      this.store.pushInbox(sessionId,participantId,task,{phase:session.phase,round:session.round,debateRound:session.debateRound});
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
      phase:session.phase as ReviewPhase,round:session.round,policy:session.policy,status:session.status,
      participants:this.store.listParticipants(sessionId).map(participant=>this.toFlowParticipant(participant)),
      issues:this.store.listIssues(sessionId).map(issue=>this.toFlowIssue(issue)),
      completions:this.store.listCompletions(sessionId).filter(entry=>entry.phase==='collecting').map(entry=>({phase:'collecting' as const,round:entry.round,participantId:entry.participantId})),
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
  private async applyPhase(session:CollabSession,result:{phase:ReviewPhase,round:number,reason:string,escalateDeadlock?:boolean,skipped?:string[]},context:{forced?:boolean,reason?:string,actor?:string}){
    const finished=result.phase==='finished';
    const updated=this.store.updateSession(session.sessionId,{phase:result.phase,round:result.round,status:finished?'finished':session.status,
      stalled:undefined,outcome:finished?this.outcome(session.sessionId):session.outcome});
    if(result.phase==='collecting'&&result.round!==session.round)await this.captureBaseline(updated);
    this.record(session.sessionId,'phase_changed',{from:session.phase,to:result.phase,round:result.round,reason:result.reason,
      ...(context.forced?{forced:true,forcedBy:context.actor??'human',forceReason:context.reason,skipped:result.skipped??[]}:{})},context.forced?(context.actor??'human'):undefined);
    if(result.escalateDeadlock)this.raiseDeadlockEscalation(updated);
    if(finished)this.record(session.sessionId,'session_finished',{outcome:updated.outcome??{}});
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
    if(session.phase==='collecting')for(const participant of participants)if(participant.role!=='moderator')targets.set(participant.participantId,participant.role==='reviewer'?'file_findings':'file_findings_optional');
    if(session.phase==='responding')for(const issue of this.store.listIssues(sessionId,{status:['open']}))targets.set(issue.targetParticipantId,'respond_to_issues');
    if(session.phase==='adjudicating')for(const issue of this.store.listIssues(sessionId,{status:['answered']}))targets.set(issue.reporterId,'rule_on_responses');
    for(const [participantId,task] of targets){
      this.store.pushInbox(sessionId,participantId,task,{phase:session.phase,round:session.round});
      this.record(sessionId,'task_assigned',{participantId,task,phase:session.phase,round:session.round});
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
  checkStalls(){
    const changed:CollabSession[]=[];
    for(const session of this.store.listSessions({status:'active'})){
      const snapshot=this.snapshot(session.sessionId),check=stallCheck(snapshot,Date.parse(session.updatedAt),this.now());
      const wasStalled=!!session.stalled;
      if(check.stalled&&!wasStalled){
        const updated=this.store.updateSession(session.sessionId,{stalled:{since:new Date(this.now()).toISOString(),waitingOn:check.waitingOn}});
        this.record(session.sessionId,'participant_overdue',{waitingOn:check.waitingOn,overdueBySec:check.overdueBySec,phase:session.phase});
        changed.push(updated);
      }else if(!check.stalled&&wasStalled){
        changed.push(this.store.updateSession(session.sessionId,{stalled:undefined}));
      }
    }
    return changed;
  }
  private outcome(sessionId:string){
    const issues=this.store.listIssues(sessionId),byStatus:Record<string,number>={};
    for(const issue of issues)byStatus[issue.status]=(byStatus[issue.status]??0)+1;
    return {totalIssues:issues.length,byStatus,participants:this.store.listParticipants(sessionId).map(participant=>({participantId:participant.participantId,displayName:participant.displayName,role:participant.role,model:participant.model,tokensUsed:participant.tokensUsed,tokensEstimated:participant.tokensEstimated,state:participant.state}))};
  }
  private withHistory(issue:Issue){return {...issue,history:this.store.listIssueMessages(issue.issueId)}}
  /** Flags likely duplicates without merging: a wrong merge silently drops a real defect. */
  private possibleDuplicates(sessionId:string,issueIds:string[]){
    if(!issueIds.length)return [];
    const all=this.store.listIssues(sessionId),results:{issueId:string,similarTo:string,score:number}[]=[];
    for(const issueId of issueIds){
      const issue=all.find(entry=>entry.issueId===issueId);if(!issue)continue;
      for(const other of all){
        if(other.issueId===issueId||issueIds.includes(other.issueId)&&other.issueId>issueId)continue;
        if(other.issueId===issueId)continue;
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
  /** Managed agents report real usage; external agents that stay silent are charged a byte-based estimate. */
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
