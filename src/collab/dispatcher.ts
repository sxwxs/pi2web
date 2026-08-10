import type {CollabHub} from './hub.js';
import type {CollabEvent,CollabSession,Participant} from './types.js';

/**
 * Wakes *managed* participants. An external agent polls `/inbox`; a managed agent is a pi2web agent that
 * cannot poll anything, so the hub has to push the task into its conversation via AgentManager.command().
 *
 * The wake-up message is a briefing, never a decision: the agent still has to talk to the HTTP API,
 * and every rule (baseline, evidence, phase) is enforced there.
 */
export type DispatchDeps={
  command:(agentId:string,kind:'prompt'|'follow-up',message:string)=>Promise<unknown>,
  /** Current agent status; a busy agent is queued with `follow-up` instead of a fresh `prompt`. */
  agentStatus:(agentId:string)=>string|undefined,
  baseUrl:()=>string,
  /** Coalescing window: one phase change assigns several tasks to the same agent. */
  delayMs?:number,
  log?:(message:string)=>void
};

const BUSY_STATES=['starting','streaming','waiting_for_user','stopping'];
const MAX_DIGEST_CHARS=8000;
/** How long after a session finished a still-undelivered closing note is worth retrying. */
const CLOSING_NOTE_RETRY_WINDOW_MS=24*3600_000;

export class CollabDispatcher {
  private unsubscribe?:()=>void;
  private pending=new Map<string,ReturnType<typeof setTimeout>>();
  private inFlight=new Map<string,Promise<void>>();
  /** Last delivered task key per participant, so a re-emitted assignment does not spam the agent. */
  private delivered=new Map<string,string>();
  private closed=false;
  constructor(private readonly hub:CollabHub,private readonly deps:DispatchDeps){}

  start(){
    if(this.unsubscribe||this.closed)return;
    this.unsubscribe=this.hub.subscribe(event=>this.onEvent(event));
    this.resumePending();
  }
  /**
   * Wake-ups are triggered by events, and events are not replayed after a restart. Without this,
   * a managed agent whose task was queued before the restart would wait forever. Recently finished sessions are
   * scanned too: a crash between `announceFinish()` and the delayed dispatch would otherwise leave the closing
   * note undelivered. A delivered note is acked, so this never re-fires for a note that did arrive.
   */
  private resumePending(){
    try{
      const cutoff=Date.now()-CLOSING_NOTE_RETRY_WINDOW_MS;
      const finished=this.hub.store.listSessions({status:'finished',limit:50});
      for(const session of [...this.hub.store.listSessions({status:'active',limit:200}),...finished]){
        const stale=session.status!=='active'&&Date.parse(session.updatedAt)<cutoff;
        for(const participant of this.hub.store.listParticipants(session.sessionId)){
          if(participant.binding.type!=='managed'||!participant.binding.agentId||participant.state!=='active')continue;
          const pending=this.hub.store.listInbox(participant.participantId);
          const last=pending[pending.length-1];
          // A finished session only ever has one deliverable left: its closing note.
          if(!last||(session.status!=='active'&&last.type!=='session_result'))continue;
          // Past the retry window nobody is waiting any more: stop re-trying and stop holding the credential.
          if(stale){this.hub.completeDelivery(participant.participantId,'session_result');this.hub.retireDispatchToken(participant.participantId);continue}
          this.schedule(session.sessionId,participant.participantId,last.type);
        }
      }
    }catch(error){this.deps.log?.(`Collab dispatch resume failed: ${(error as Error).message}`)}
  }
  async stop(){
    this.closed=true;
    this.unsubscribe?.();this.unsubscribe=undefined;
    for(const timer of this.pending.values())clearTimeout(timer);
    this.pending.clear();
    await Promise.allSettled([...this.inFlight.values()]);
  }
  /** Test seam: waits until every scheduled wake-up has been attempted. */
  async drain(){
    for(let guard=0;guard<50&&(this.pending.size||this.inFlight.size);guard++){
      await Promise.allSettled([...this.inFlight.values()]);
      if(this.pending.size)await new Promise(resolve=>setTimeout(resolve,(this.deps.delayMs??150)+10));
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private onEvent(event:CollabEvent){
    if(event.type!=='task_assigned')return;
    const participantId=String(event.payload.participantId??''),task=String(event.payload.task??'');
    if(!participantId||!task)return;
    this.schedule(event.sessionId,participantId,task);
  }
  private schedule(sessionId:string,participantId:string,task:string){
    if(this.closed)return;
    const existing=this.pending.get(participantId);
    if(existing)clearTimeout(existing);
    const timer=setTimeout(()=>{this.pending.delete(participantId);void this.enqueue(sessionId,participantId,task)},this.deps.delayMs??150);
    timer.unref?.();
    this.pending.set(participantId,timer);
  }
  /** One wake-up at a time per participant: two overlapping prompts would race inside the agent. */
  private enqueue(sessionId:string,participantId:string,task:string){
    const previous=this.inFlight.get(participantId)??Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>this.wake(sessionId,participantId,task));
    const tracked=job.finally(()=>{if(this.inFlight.get(participantId)===tracked)this.inFlight.delete(participantId)});
    this.inFlight.set(participantId,tracked);
    return tracked;
  }
  private async wake(sessionId:string,participantId:string,task:string){
    let participant:Participant;
    try{participant=this.hub.store.getParticipant(participantId)}catch{return}
    const agentId=participant.binding.agentId;
    if(participant.binding.type!=='managed'||!agentId)return;            // external agents poll the inbox themselves
    if(participant.state!=='active')return;                              // left or out of budget: a human has to act
    const session=this.hub.store.findSession(sessionId);
    // `session_result` is the closing note, so it is the one task that may still be delivered after the session ended.
    const terminal=task==='session_result';
    if(!session||(session.status!=='active'&&!terminal))return;
    // The bound agent is part of the identity of a delivery: after a rebind the *new* agent has received
    // nothing, so a key without it matches the old delivery and leaves the replacement agent idle.
    const key=`${agentId}:${task}:${session.phase}:${session.round}:${session.debateRound}`;
    if(this.delivered.get(participantId)===key)return;
    const token=this.hub.store.getDispatchToken(participantId);
    if(!token){
      this.hub.logDispatch(sessionId,'dispatch_failed',{participantId,agentId,task,reason:'NO_DISPATCH_TOKEN'});
      this.deps.log?.(`Collab dispatch skipped for ${participant.displayName}: no stored participant token (re-register the participant).`);
      return;
    }
    let digest:unknown;
    try{digest=this.hub.digest(participant)}catch{digest=undefined}
    const status=this.deps.agentStatus(agentId);
    const kind=status&&BUSY_STATES.includes(status)?'follow-up':'prompt';
    try{
      await this.deps.command(agentId,kind,briefing({baseUrl:this.deps.baseUrl(),session,participant,task,token,digest}));
      this.delivered.set(participantId,key);
      this.hub.logDispatch(sessionId,'agent_dispatched',{participantId,agentId,task,kind,phase:session.phase,round:session.round});
      // The closing note reached the agent: ack the item (a managed agent cannot ack for itself, and an
      // unacked item would be re-scheduled on every restart) and only then drop the credential it used.
      if(terminal){this.delivered.delete(participantId);this.hub.completeDelivery(participantId,'session_result');this.hub.retireDispatchToken(participantId)}
    }catch(error){
      this.hub.logDispatch(sessionId,'dispatch_failed',{participantId,agentId,task,reason:(error as Error).message});
      this.deps.log?.(`Collab dispatch to agent ${agentId} failed: ${(error as Error).message}`);
      // The note did NOT arrive, so the item stays unacked and the credential stays: a restart retries it
      // inside CLOSING_NOTE_RETRY_WINDOW_MS. Retiring the token here is what used to make that retry impossible.
    }
  }
}

const clip=(value:string,max:number)=>value.length<=max?value:`${value.slice(0,max)}\n… (truncated; call GET /digest for the full task package)`;

/**
 * The rule that keeps an agent from burning its turn (and its budget) on `sleep`+poll loops: this hub is
 * push-based. Whoever is waiting on someone else must end the turn; the hub sends a new message when it is
 * their turn again. Repeated in every briefing because agents only reliably obey what is in the last prompt.
 */
const HAND_BACK=[
  'When you have nothing left to submit, END YOUR TURN.',
  'Do NOT sleep, poll, retry in a loop, or wait for the other agents: the hub pushes you a new message the',
  'moment something needs you (review comments, a ruling, or the final result). Waiting here only wastes budget.'
];

export function briefing(input:{baseUrl:string,session:CollabSession,participant:Participant,task:string,token:string,digest:unknown}):string{
  if(input.task==='implement')return workOrder(input);
  if(input.task==='session_result')return closingNote(input);
  return protocolBriefing(input);
}

/**
 * First contact with a developer agent. Deliberately *not* the full protocol: at this point the agent only has to
 * build the thing, and a wall of review-API detail is what tempts it to start polling for review feedback.
 */
function workOrder(input:{baseUrl:string,session:CollabSession,participant:Participant,token:string,digest:unknown}):string{
  const {baseUrl,session,participant,token}=input;
  const api=`${baseUrl.replace(/\/$/,'')}/api/v1/collab/sessions/${session.sessionId}`;
  const carried=(input.digest as any)?.issues as unknown[]|undefined;
  return [
    `[pi2web collaboration hub] Development task in collaboration session "${session.title}".`,
    '',
    `you: ${participant.displayName} (role=implementer)`,
    'task now due: implement',
    `working directory: ${session.cwd}`,
    '',
    'What to build:',
    `  ${session.subject.type}: ${session.subject.value}`,
    ...(session.subject.notes?[`  notes: ${session.subject.notes}`]:[]),
    ...(carried?.length?['',`${carried.length} issue(s) from the previous round are still open; GET ${api}/digest for their text.`]:[]),
    '',
    'When the code is finished, report it once:',
    `  curl -X POST ${api}/ready \\`,
    `    -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \\`,
    `    -d '{"clientRequestId":"<unique>","summary":"<what you changed and why>","changes":[{"path":"src/…","summary":"…"}],"codeRef":{"commit":"<sha or dirty>"}}'`,
    '',
    'That call pins the baseline the reviewers will read, so make it your last action: anything you edit afterwards',
    'is outside the review. Then stop.',
    '',
    ...HAND_BACK,
    'The reviewers are called by the hub, not by you. You will be prompted again with their findings (or with the',
    'final result if they had none), and only then do you answer them.'
  ].join('\n');
}

/** The session is over; say so plainly so the agent stops watching for something that will never arrive. */
function closingNote(input:{session:CollabSession,participant:Participant}):string{
  const {session,participant}=input;
  const outcome=session.outcome as any;
  return [
    `[pi2web collaboration hub] Collaboration session "${session.title}" is finished.`,
    '',
    `you: ${participant.displayName} (role=${participant.role})`,
    ...(outcome?.verdict?[`verdict: ${outcome.verdict}`]:[]),
    ...(outcome?[`outcome: ${clip(JSON.stringify(outcome),2000)}`]:[]),
    '',
    'Nothing further is required from you and your participant token is no longer needed.',
    'END YOUR TURN. Do not poll the hub again for this session.'
  ].join('\n');
}

/** Full protocol package for the phases where an agent really does have to talk to the API. */
function protocolBriefing(input:{baseUrl:string,session:CollabSession,participant:Participant,task:string,token:string,digest:unknown}):string{
  const {baseUrl,session,participant,task,token}=input;
  const api=`${baseUrl.replace(/\/$/,'')}/api/v1/collab/sessions/${session.sessionId}`;
  const digest=input.digest===undefined?'(unavailable, call GET /digest)':clip(JSON.stringify(input.digest,null,2),MAX_DIGEST_CHARS);
  const submit=session.kind==='review'
    ? `POST ${api}/findings | ${api}/responses | ${api}/verdicts`
    : `POST ${api}/nominations | ${api}/votes | ${api}/scores | ${api}/debates/{debateId}/arguments`;
  return [
    `[pi2web collaboration hub] You have a task in collaboration session "${session.title}".`,
    '',
    `sessionId: ${session.sessionId} (kind=${session.kind}, phase=${session.phase}, round=${session.round})`,
    `you: ${participant.displayName} (participantId=${participant.participantId}, role=${participant.role})`,
    `task now due: ${task}`,
    '',
    'Work only through the hub HTTP API. Never message the other agents directly; they cannot see your chat.',
    `Authorization header for every call: Authorization: Bearer ${token}`,
    '',
    'Endpoints:',
    `  GET  ${api}/digest                 what you owe right now (authoritative)`,
    `  POST ${api}/inbox/ack              {"itemIds":["..."]} once you have handled an item`,
    `  ${submit}`,
    `  POST ${api}/escalations            hand a deadlock to a human`,
    '',
    ...HAND_BACK,
    '',
    'Rules:',
    '  - every submission needs a unique clientRequestId (retries with the same id replay the first result);',
    '  - review findings must carry location.path plus real evidence, and must target the pinned baselineId;',
    '  - scores need a rationale and at least one evidence entry pointing at a file;',
    '  - on HTTP 422 read error.fieldErrors, repair the payload and retry;',
    '  - on HTTP 409 STALE_BASELINE re-read the code at error.currentBaseline and resubmit.',
    '',
    'Current task package:',
    '```json',
    digest,
    '```'
  ].join('\n');
}
