import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../src/metadata-store.js';
import {CollabStore} from '../src/collab/store.js';
import {CollabHub,type BaselineResolver} from '../src/collab/hub.js';
import {CollabDispatcher,toolBriefing} from '../src/collab/dispatcher.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';
import {MailNotifier} from '../src/mail-notifier.js';

const temp=(prefix:string)=>mkdtemp(path.join(tmpdir(),prefix));
const rid=()=>`req-${randomUUID()}`;

describe('collab dispatcher',()=>{
  let dir:string,metadata:MetadataStore,store:CollabStore,hub:CollabHub,dispatcher:CollabDispatcher;
  let sent:{agentId:string,kind:string,message:string}[],statuses:Map<string,string>;
  const baseline:BaselineResolver=async()=>({vcs:'git',commit:'commit-1',paths:[]});

  beforeEach(async()=>{
    dir=await temp('collab-dispatch-');metadata=new MetadataStore(dir);metadata.init();
    store=new CollabStore(()=>metadata.connection);
    hub=new CollabHub(store,{resolveBaseline:baseline});hub.init();
    sent=[];statuses=new Map();
    dispatcher=new CollabDispatcher(hub,{
      command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},
      agentStatus:agentId=>statuses.get(agentId),
      delayMs:0
    });
    dispatcher.start();
  });
  afterEach(async()=>{await dispatcher.stop();metadata.close()});

  const session=async()=>hub.createSession({kind:'review',title:'Payment callback review',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~1..HEAD'}},async()=>dir);

  it('keeps the Pi collaboration extension wake-up free of raw transport credentials and ids',async()=>{
    const created=await session(),reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-security',agentId:'agent-1'});
    const message=toolBriefing({session:created,participant:reviewer.participant,task:'file_findings'});
    expect(message).toContain('collab_get_task');
    expect(message).toContain(created.cwd);
    expect(message).not.toContain(created.sessionId);
    expect(message).not.toContain(reviewer.token);
    expect(message).not.toContain('Authorization:');
    expect(message).not.toContain('http://');
  });

  it('wakes each seat with the extension-only collaboration prompt and skips repeats',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-security',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    // Every seat is a local agent, so every seat that owes work is prompted.
    expect(sent.map(entry=>entry.agentId).sort()).toEqual(['agent-1','agent-impl']);
    sent.splice(1);
    expect(sent[0]).toMatchObject({agentId:'agent-1',kind:'prompt'});
    expect(sent[0].message).toContain('action: file_findings');
    expect(sent[0].message).toContain('collab_get_task');
    expect(sent[0].message).not.toContain(reviewer.token);
    expect(sent[0].message).not.toContain(created.sessionId);
    expect(sent[0].message).not.toContain('Authorization:');
    expect(hub.events(created.sessionId).some(event=>event.type==='agent_dispatched')).toBe(true);

    // Re-emitting the very same assignment (same task, phase and round) must not prompt the agent twice.
    (hub as any).dispatch(created.sessionId);
    await dispatcher.drain();
    expect(sent).toHaveLength(1);
  });

  it('wakes finished collectors to cross-vote before the last reviewer files',async()=>{
    const created=await hub.createSession({kind:'review',title:'Overlap',workspaceId:'ws-1',subject:{type:'free',value:'branch'},policy:{consensusReview:true}},async()=>dir);
    const a=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'A',agentId:'agent-A'});
    const b=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'B',agentId:'agent-B'});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'C',agentId:'agent-C'});
    await hub.openRound(created.sessionId);await dispatcher.drain();sent.length=0;
    const baselineId=store.getBaselineForRound(created.sessionId,1)!.baselineId;
    await hub.submitFindings(a.participant,{clientRequestId:rid(),baselineId,findings:[{title:'First collector correctness issue',severity:'major',category:'correctness',location:{path:'src/a.ts',startLine:1},evidence:'The implementation at line 1 demonstrably violates the required behavior.'}],reviewComplete:true});
    await hub.submitFindings(b.participant,{clientRequestId:rid(),baselineId,findings:[{title:'Second collector correctness issue',severity:'major',category:'correctness',location:{path:'src/b.ts',startLine:2},evidence:'The implementation at line 2 demonstrably violates the required behavior.'}],reviewComplete:true});
    await dispatcher.drain();
    expect(sent.filter(entry=>entry.message.includes('action: validate_issues')).map(entry=>entry.agentId).sort()).toEqual(['agent-A','agent-B']);
    expect(sent.some(entry=>entry.agentId==='agent-C'&&entry.message.includes('validate_issues'))).toBe(false);
  });

  it('drops a wake-up whose work the panel has already moved past',async()=>{
    const created=await hub.createSession({kind:'review',title:'Stale wake-up',workspaceId:'ws-1',subject:{type:'free',value:'branch'},policy:{consensusReview:true}},async()=>dir);
    const a=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'A',agentId:'agent-A'});
    const b=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'B',agentId:'agent-B'});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'C',agentId:'agent-C'});
    await hub.openRound(created.sessionId);await dispatcher.drain();
    const baselineId=store.getBaselineForRound(created.sessionId,1)!.baselineId;
    const filed=await hub.submitFindings(a.participant,{clientRequestId:rid(),baselineId,findings:[{title:'A concrete correctness issue',severity:'major',category:'correctness',location:{path:'src/a.ts',startLine:1},evidence:'The implementation at line 1 demonstrably violates the required behavior.'}],reviewComplete:true});
    await hub.submitFindings(b.participant,{clientRequestId:rid(),baselineId,findings:[],reviewComplete:true});
    // B owes a cross-vote, casts it, and only then does the queued wake-up for that same work get delivered.
    await hub.submitIssueVotes(b.participant,{clientRequestId:rid(),votes:[{issueId:(filed as any).accepted[0].issueId,stance:'approve'}],complete:true});
    await dispatcher.drain();sent.length=0;
    (hub as any).push(created.sessionId,b.participant.participantId,'validate_issues',{phase:'collecting',round:1});
    (hub as any).record(created.sessionId,'task_assigned',{participantId:b.participant.participantId,task:'validate_issues',phase:'collecting',round:1});
    await dispatcher.drain();
    expect(sent.some(entry=>entry.agentId==='agent-B')).toBe(false);
    expect(store.listInbox(b.participant.participantId).some(item=>item.type==='validate_issues')).toBe(false);
    expect(hub.events(created.sessionId).some(event=>event.type==='dispatch_skipped'&&event.payload.reason==='NOTHING_OWED')).toBe(true);
    // The session itself is untouched: C is still the one everybody is waiting for.
    expect(hub.progress(created.sessionId)).toMatchObject({phase:'collecting'});
  });

  it('still wakes a seat when the digest cannot be computed',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'A',agentId:'agent-1'});
    await hub.openRound(created.sessionId);await dispatcher.drain();sent.length=0;
    // A transient failure (a locked database, a session read while it is being removed) must not be read as
    // "nothing owed": that acks the durable item and the phase then waits forever on a seat nobody wakes again.
    const digest=hub.digest.bind(hub);
    (hub as any).digest=()=>{throw new Error('database is locked')};
    try{
      (hub as any).push(created.sessionId,reviewer.participant.participantId,'validate_issues',{phase:'collecting',round:1});
      (hub as any).record(created.sessionId,'task_assigned',{participantId:reviewer.participant.participantId,task:'validate_issues',phase:'collecting',round:1});
      await dispatcher.drain();
    }finally{(hub as any).digest=digest}
    expect(sent.some(entry=>entry.agentId==='agent-1'&&entry.message.includes('action: validate_issues'))).toBe(true);
    expect(store.listInbox(reviewer.participant.participantId).some(item=>item.type==='validate_issues')).toBe(true);
    expect(hub.events(created.sessionId).some(event=>event.type==='dispatch_skipped')).toBe(false);
  });

  it('keeps a single queued cross-vote per seat while the owed set grows',async()=>{
    const created=await hub.createSession({kind:'review',title:'Growing ballot',workspaceId:'ws-1',subject:{type:'free',value:'branch'},policy:{consensusReview:true}},async()=>dir);
    const seats:Record<string,any>={};
    for(const name of ['A','B','C','D'])seats[name]=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:name,agentId:`agent-${name}`});
    await hub.openRound(created.sessionId);await dispatcher.drain();
    const baselineId=store.getBaselineForRound(created.sessionId,1)!.baselineId;
    const file=async(name:string,count:number)=>hub.submitFindings(seats[name].participant,{clientRequestId:rid(),baselineId,
      findings:Array.from({length:count},(_,index)=>({title:`${name} correctness issue ${index+1}`,severity:'major',category:'correctness',
        location:{path:`src/${name}-${index}.ts`,startLine:index+1},evidence:'The implementation demonstrably violates the required behavior.'})),reviewComplete:true});
    await file('A',1);await file('B',1);await dispatcher.drain();
    // The owed count is only a hint inside the task type. A second wave must not queue validate_issues#3 next to
    // the validate_issues#1 that is still waiting for the same seat.
    await file('C',2);await dispatcher.drain();
    expect(store.listInbox(seats.A.participant.participantId).filter(item=>item.type.split('#')[0]==='validate_issues')).toHaveLength(1);
  });

  it('tells a managed agent that the session is over instead of leaving it waiting',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    // A clean review pushes no further task, so without the closing note the agent would wait forever.
    await hub.submitFindings(reviewer.participant,{clientRequestId:rid(),baselineId:(hub.digest(reviewer.participant) as any).baseline.baselineId,findings:[],reviewComplete:true});
    await dispatcher.drain();
    const closing=sent.at(-1)!;
    expect(closing.message).toContain('finished');
    expect(closing.message).toContain('Result: approved');
    expect(closing.message).not.toContain('token');
    // The delivered note is acked, so a restart never re-fires it.
    expect(store.listInbox(reviewer.participant.participantId).filter(item=>item.type==='session_result')).toHaveLength(0);
  });

  it('queues a busy agent with follow-up instead of interrupting it with a fresh prompt',async()=>{
    const created=await session();
    statuses.set('agent-busy','streaming');
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-busy',agentId:'agent-busy'});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-idle',agentId:'agent-idle'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    expect(sent.find(entry=>entry.agentId==='agent-busy')?.kind).toBe('follow-up');
    expect(sent.find(entry=>entry.agentId==='agent-idle')?.kind).toBe('prompt');
  });

  it('records a failure instead of dropping the task when the agent cannot be reached',async()=>{
    const created=await session();
    dispatcher=new CollabDispatcher(hub,{command:async()=>{throw Error('Agent is not running')},agentStatus:()=>undefined,delayMs:0});
    dispatcher.start();
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-dead'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    const failure=hub.events(created.sessionId).find(event=>event.type==='dispatch_failed');
    expect(failure?.payload).toMatchObject({agentId:'agent-dead',reason:'Agent is not running'});
  });

  it('re-wakes a managed agent whose task was queued before a restart',async()=>{
    const created=await session();
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await dispatcher.stop();                              // the task is queued while nobody is dispatching
    await hub.openRound(created.sessionId);
    expect(sent).toHaveLength(0);

    const restarted=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,delayMs:0});
    restarted.start();
    await restarted.drain();
    await restarted.stop();
    expect(sent.map(entry=>entry.agentId).sort()).toEqual(['agent-1','agent-impl']);
  });

  it('delivers the closing note to every managed seat',async()=>{
    const created=await session();
    const first=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-a',agentId:'agent-1'});
    const second=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-b',agentId:'agent-2'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();
    for(const seat of [first,second])
      await hub.submitFindings(seat.participant,{clientRequestId:rid(),baselineId:(hub.digest(seat.participant) as any).baseline.baselineId,findings:[],reviewComplete:true});
    await dispatcher.drain();

    // Both agents must be told the session is over: retiring the whole session's state on the first delivery
    // used to leave the second one undelivered, so its closing note was silently dropped.
    const closing=sent.filter(entry=>entry.message.includes('collaboration is finished'));
    expect(closing.map(entry=>entry.agentId).sort()).toEqual(['agent-1','agent-2','agent-impl']);
    for(const seat of [first,second])expect(store.listInbox(seat.participant.participantId).filter(item=>item.type==='session_result')).toHaveLength(0);
    // A seat's bearer token is never persisted in clear text; only its hash is stored.
    const columns=(metadata.connection.prepare('PRAGMA table_info(collab_participants)').all() as {name:string}[]).map(column=>column.name);
    expect(columns).not.toContain('dispatch_token');
    expect(metadata.connection.prepare('SELECT COUNT(*) AS hits FROM collab_participants WHERE token_hash=?').get(first.token)).toMatchObject({hits:0});
  });

  it('delivers a closing note that was queued but never dispatched before a restart',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();
    sent.length=0;
    await dispatcher.stop();                              // the process dies between announceFinish() and delivery
    await hub.submitFindings(reviewer.participant,{clientRequestId:rid(),baselineId:(hub.digest(reviewer.participant) as any).baseline.baselineId,findings:[],reviewComplete:true});
    expect(store.getSession(created.sessionId).status).toBe('finished');
    expect(sent).toHaveLength(0);

    const restarted=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,delayMs:0});
    restarted.start();
    await restarted.drain();
    await restarted.stop();
    expect(sent.at(-1)?.message).toContain('finished');

    // A delivered note is acked, so a later restart must not re-fire it.
    sent.length=0;
    const again=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,delayMs:0});
    again.start();
    await again.drain();
    await again.stop();
    expect(sent).toHaveLength(0);
    expect(hub.events(created.sessionId).filter(event=>event.type==='dispatch_failed')).toHaveLength(0);
  });

  it('keeps a failed closing note retryable instead of acking it',async()=>{
    const created=await session();
    await dispatcher.stop();
    let failing=true;
    const flaky=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{if(failing)throw Error('Agent is not running');sent.push({agentId,kind,message})},
      agentStatus:()=>undefined,delayMs:0});
    flaky.start();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await flaky.drain();
    await hub.submitFindings(reviewer.participant,{clientRequestId:rid(),baselineId:(hub.digest(reviewer.participant) as any).baseline.baselineId,findings:[],reviewComplete:true});
    await flaky.drain();
    await flaky.stop();
    expect(sent).toHaveLength(0);
    // The queued item must survive a failed delivery, otherwise the retry the resume exists for is impossible.
    expect(store.listInbox(reviewer.participant.participantId).filter(item=>item.type==='session_result')).toHaveLength(1);

    failing=false;
    const restarted=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,delayMs:0});
    restarted.start();
    await restarted.drain();
    await restarted.stop();
    expect(sent.at(-1)?.message).toContain('finished');
    expect(store.listInbox(reviewer.participant.participantId).filter(item=>item.type==='session_result')).toHaveLength(0);
  });

  it('rebinds a seat whose agent never answered and re-delivers the task it already had',async()=>{
    const created=await hub.createSession({kind:'review',title:'Payment callback review',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~1..HEAD'},policy:{implementationFirst:true}},async()=>dir);
    const failing=new CollabDispatcher(hub,{command:async()=>{throw Error('Agent is not running')},agentStatus:()=>undefined,delayMs:0});
    await dispatcher.stop();
    failing.start();
    const impl=hub.addParticipant(created.sessionId,{role:'implementer',displayName:'dev',agentId:'agent-dead'});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'});
    await hub.openRound(created.sessionId);
    await failing.drain();
    await failing.stop();
    expect(sent).toHaveLength(0);

    // The queued task survives the failed delivery, so handing the seat to a live agent hands over the work too.
    dispatcher=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,delayMs:0});
    dispatcher.start();
    const rebound=hub.rebindParticipant(created.sessionId,impl.participant.participantId,{agentId:'agent-dev'});
    await dispatcher.drain();
    expect(rebound.participant.agentId).toBe('agent-dev');
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe('agent-dev');
    expect(sent[0].message).toContain('action: implement');
    expect(sent[0].message).not.toContain(rebound.token);
    expect(store.findParticipantByToken(impl.token)).toBeUndefined();
  });

  it('delivers to the replacement agent when a managed seat is rebound to another agent',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-security',agentId:'agent-1'});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();
    expect(sent.filter(entry=>entry.agentId==='agent-1')).toHaveLength(1);

    // Same seat, same task, different agent: a delivery guard keyed only on the task skipped this and left
    // the replacement agent idle with an assignment nobody had told it about.
    const rebound=hub.rebindParticipant(created.sessionId,reviewer.participant.participantId,{agentId:'agent-2'});
    await dispatcher.drain();
    const replacement=sent.filter(entry=>entry.agentId==='agent-2');
    expect(replacement).toHaveLength(1);
    expect(replacement[0].message).toContain('action: file_findings');
    expect(replacement[0].message).not.toContain(rebound.token);
  });

  it('raises the alarm quickly when a queued task never reaches its agent',async()=>{
    let clock=Date.now();
    const timed=new CollabHub(store,{resolveBaseline:baseline,now:()=>clock});timed.init();
    const created=await timed.createSession({kind:'review',title:'Uncollected task',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~1..HEAD'},policy:{implementationFirst:true}},async()=>dir);
    const dev=timed.addParticipant(created.sessionId,{role:'implementer',displayName:'dev',agentId:'agent-dev'}).participant;
    timed.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'});
    await timed.openRound(created.sessionId);

    expect(timed.checkStalls()).toHaveLength(0);           // a task queued seconds ago is not yet suspicious
    clock+=3*60_000;                                       // …but two minutes without the agent being told is
    const stalled=timed.checkStalls();
    expect(stalled[0]?.stalled?.waitingOn).toEqual([dev.participantId]);
    expect(timed.events(created.sessionId).find(event=>event.type==='participant_overdue')?.payload)
      .toMatchObject({reason:'task_never_delivered',waitingOn:[dev.participantId]});
    // The board must be able to show "queued but never delivered" without digging through the event log.
    expect(timed.participantsForHuman(created.sessionId).find(entry=>entry.displayName==='dev'))
      .toMatchObject({pendingTasks:1});

    // The flag stays put while nothing changes, instead of flapping once a minute.
    expect(timed.checkStalls()).toHaveLength(0);
  });

  it('does not call a long-running streaming Agent stalled, but alarms if it goes idle without submitting',async()=>{
    let clock=Date.now(),status='streaming';
    const timed=new CollabHub(store,{resolveBaseline:baseline,now:()=>clock,agentStatus:()=>status});timed.init();
    const created=await timed.createSession({kind:'review',title:'Long active review',workspaceId:'ws-1',subject:{type:'free',value:'branch'},policy:{overdueWarningSec:60}},async()=>dir);
    const reviewer=timed.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'}).participant;
    await timed.openRound(created.sessionId);clock+=5*60_000;
    expect(timed.checkStalls()).toHaveLength(0);
    status='idle';
    expect(timed.checkStalls()[0]?.stalled?.waitingOn).toEqual([reviewer.participantId]);
  });

  it('retires the durable queue entry only when the extension actually collects the task',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',agentId:'agent-reviewer'});
    const implementer=hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',agentId:'agent-impl'});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();
    expect(sent).toHaveLength(2);
    // command() may only have queued a follow-up, so dispatch acceptance is not yet durable delivery.
    expect(store.listInbox(reviewer.participant.participantId)).toHaveLength(1);
    hub.claimTaskForAgent('agent-reviewer');hub.claimTaskForAgent('agent-impl');
    expect(store.listInbox(reviewer.participant.participantId)).toHaveLength(0);
    expect(store.listInbox(implementer.participant.participantId)).toHaveLength(0);
    expect(hub.participantsForHuman(created.sessionId).every(entry=>entry.pendingTasks===0)).toBe(true);
  });
});

describe('collaboration wiring over HTTP',()=>{
  let server:RemotePiServer|undefined;
  afterEach(async()=>{await server?.stop();server=undefined});

  it('wakes a managed pi2web agent and mails the human when an escalation is raised',async()=>{
    const dataDir=await temp('remote-pi-collab-wire-'),root=await temp('collab-ws-');
    const mails:any[]=[];
    const mailNotifier=new MailNotifier({endpoint:'https://mail.example/send',apiKey:'key',recipient:'owner@example.com'},
      (async(_url:any,init:any)=>{mails.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true}),{status:200})}) as any);
    const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd));
    server=new RemotePiServer({port:0,dataDir,workspaces,agents,mailNotifier});
    const auth=await server.auth.init(),address=await server.start();
    const base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
    const call=async(method:string,url:string,body?:unknown,token=human)=>{
      const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const payload:any=await response.json().catch(()=>({}));
      return {status:response.status,data:payload.data,error:payload.error};
    };

    const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
    const agent=(await call('POST','/api/v1/agents',{workspaceId:workspace.id,profile:'collab'})).data;
    const implementerAgent=(await call('POST','/api/v1/agents',{workspaceId:workspace.id,profile:'collab'})).data;
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Managed dispatch review',workspaceId:workspace.id,subject:{type:'free',value:'everything'}})).data.sessionId;
    const managed=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer-managed',agentId:agent.agentId})).data;
    expect(managed.participantToken).toMatch(/^cpt_/);
    const implementer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',agentId:implementerAgent.agentId})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});

    // The managed reviewer must have been prompted by the hub, with a usable participant token.
    const prompt=await waitFor(async()=>{
      const messages=await agents.messages(agent.agentId) as any[];
      return messages.map(entry=>String(entry.content??'')).find(text=>text.includes('[pi2web collaboration]'));
    });
    expect(prompt).toContain('action: file_findings');
    expect(prompt).toContain('collab_get_task');
    expect(prompt).not.toContain(managed.participantToken);
    expect(prompt).not.toContain(sessionId);

    const escalation=await call('POST',`/api/v1/collab/sessions/${sessionId}/escalations`,{clientRequestId:rid(),kind:'other',
      summary:'The reviewer and the implementer cannot agree on the callback verification requirement.',
      question:'Should the HMAC check ship in this round?',options:['ship now','defer'],urgency:'high'},managed.participantToken);
    expect(escalation.status).toBe(202);

    const mail=await waitFor(async()=>mails[0]);
    expect(mail.subject).toContain('需要人工裁定');
    expect(mail.text).toContain('Managed dispatch review');
    expect(mail.text).toContain(`/collab.html?session=${sessionId}`);
    expect(mail.metadata).toMatchObject({kind:'collab'});
  });

  it('serves the collaboration board',async()=>{
    const dataDir=await temp('remote-pi-collab-web-');
    server=new RemotePiServer({port:0,dataDir});
    await server.auth.init();
    const address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
    const page=await fetch(`${base}/collab.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('协作看板');
    expect((await fetch(`${base}/collab.js`)).headers.get('content-type')).toContain('text/javascript');
  });
});

async function waitFor<T>(probe:()=>Promise<T|undefined>,timeoutMs=5000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  for(;;){
    const value=await probe();
    if(value!==undefined&&value!==null)return value;
    if(Date.now()>deadline)throw Error('Timed out waiting for the expected value');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
