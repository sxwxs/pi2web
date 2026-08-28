import type {CollabHub} from './hub.js';
import type {CollabEvent,CollabSession,Participant} from './types.js';

/**
 * Wakes the agent behind a seat. Every participant is a local pi2web agent that cannot poll anything, so the
 * hub pushes the task into its conversation via AgentManager.command(). This is the only delivery path.
 *
 * The wake-up message only tells the Pi extension to fetch its task. The extension owns transport and
 * submission details; every rule (baseline, evidence, phase) is enforced by the hub. No credential is
 * carried by, or stored for, a wake-up: the extension submits through the in-process bridge.
 */
export type DispatchDeps={
  command:(agentId:string,kind:'prompt'|'follow-up',message:string)=>Promise<unknown>,
  /** Current agent status; a busy agent is queued with `follow-up` instead of a fresh `prompt`. */
  agentStatus:(agentId:string)=>string|undefined,
  /** Dedicated Pi sessions are the only sessions with collab_get_task and typed collab_submit_* tools. */
  isCollabAgent?:(agentId:string)=>boolean,
  /** Coalescing window: one phase change assigns several tasks to the same agent. */
  delayMs?:number,
  log?:(message:string)=>void
};

const BUSY_STATES=['starting','streaming','waiting_for_user','stopping'];
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
      this.hub.recoverEarlyIssueVotes();
      const cutoff=Date.now()-CLOSING_NOTE_RETRY_WINDOW_MS;
      const finished=this.hub.store.listSessions({status:'finished',limit:50});
      for(const session of [...this.hub.store.listSessions({status:'active',limit:200}),...finished]){
        const stale=session.status!=='active'&&Date.parse(session.updatedAt)<cutoff;
        for(const participant of this.hub.store.listParticipants(session.sessionId)){
          if(!participant.agentId||participant.state!=='active')continue;
          const pending=this.hub.store.listInbox(participant.participantId);
          const last=pending[pending.length-1];
          // A finished session only ever has one deliverable left: its closing note.
          if(!last||(session.status!=='active'&&last.type!=='session_result'))continue;
          // Past the retry window nobody is waiting any more: stop re-trying.
          if(stale){this.hub.completeDelivery(participant.participantId,'session_result');continue}
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
    const agentId=participant.agentId;
    if(!agentId){                                                        // only a pre-managed-only row can get here
      this.hub.logDispatch(sessionId,'dispatch_failed',{participantId,task,reason:'NO_AGENT_BOUND'});
      return;
    }
    if(participant.state!=='active')return;                              // left or out of budget: a human has to act
    if(this.deps.isCollabAgent?.(agentId)===false){                     // undefined: the check is not wired up
      this.hub.logDispatch(sessionId,'dispatch_failed',{participantId,agentId,task,reason:'COLLAB_PROFILE_REQUIRED'});
      this.deps.log?.(`Collab dispatch skipped for ${participant.displayName}: the Agent is not profile=collab.`);
      return;
    }
    const session=this.hub.store.findSession(sessionId);
    // A human may reopen a review while the previous closing note is still scheduled. Never deliver that stale
    // "finished" message into a new active cycle, and do not retire the freshly rotated credential with it.
    const terminal=task==='session_result';
    if(!session)return;
    if(terminal&&session.status!=='finished'){this.hub.completeDelivery(participantId,task);return}
    if(!terminal&&session.status!=='active')return;
    // Delivery is serialised per seat and a `command()` only resolves when the agent's turn ends, so a wake-up
    // queued at the start of a phase can arrive after the panel has already moved past it. Waking an agent to
    // tell it "nothing to do" costs a full model turn, so the queued item is retired instead.
    if(!terminal&&this.hub.currentTaskFor(participantId)==='wait'){
      this.hub.completeDelivery(participantId,task);
      this.delivered.delete(participantId);
      this.hub.logDispatch(sessionId,'dispatch_skipped',{participantId,agentId,task,reason:'NOTHING_OWED',phase:session.phase,round:session.round});
      return;
    }
    // The bound agent is part of the identity of a delivery: after a rebind the *new* agent has received
    // nothing, so a key without it matches the old delivery and leaves the replacement agent idle.
    const key=`${agentId}:${task}:${session.phase}:${session.round}:${session.debateRound}`;
    // The prompt was already accepted in this process. Keep the durable item until collab_get_task actually
    // collects it: followUp() only queues work and may be lost if the process stops before the next turn.
    if(this.delivered.get(participantId)===key)return;
    const status=this.deps.agentStatus(agentId);
    const kind=status&&BUSY_STATES.includes(status)?'follow-up':'prompt';
    try{
      await this.deps.command(agentId,kind,toolBriefing({session,participant,task}));
      this.delivered.set(participantId,key);
      this.hub.logDispatch(sessionId,'agent_dispatched',{participantId,agentId,task,kind,phase:session.phase,round:session.round});
      // Normal work is acknowledged by collab_get_task, not here: followUp() returning means queued, not run.
      // A closing note has no tool collection step, so successful completion remains its acknowledgement.
      if(terminal){this.hub.completeDelivery(participantId,task);this.delivered.delete(participantId)}
    }catch(error){
      this.hub.logDispatch(sessionId,'dispatch_failed',{participantId,agentId,task,reason:(error as Error).message});
      this.deps.log?.(`Collab dispatch to agent ${agentId} failed: ${(error as Error).message}`);
      // The note did NOT arrive, so the item stays unacked: a restart retries it inside
      // CLOSING_NOTE_RETRY_WINDOW_MS.
    }
  }
}

/** The only dispatcher prompt. Credentials, URLs, opaque ids, and task JSON are deliberately confined to the Pi extension. */
export function toolBriefing(input:{session:CollabSession,participant:Participant,task:string}):string{
  if(input.task==='session_result'){
    const verdict=typeof input.session.outcome?.verdict==='string'?` Result: ${input.session.outcome.verdict}.`:'';
    return `[pi2web collaboration] This local code collaboration is finished.${verdict} Nothing further is required; end your turn.`;
  }
  return [
    '[pi2web collaboration] You have a local code collaboration task.',
    `role: ${input.participant.role}; action: ${input.task}; working directory: ${input.session.cwd}`,
    'Call collab_get_task first. It activates the exact collab_submit_* tool for this task; use that tool to record the complete result.',
    'Do not use curl, construct URLs, handle credentials, contact other agents, sleep, or poll. End your turn after submitting.'
  ].join('\n');
}
