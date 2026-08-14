import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../src/metadata-store.js';
import {CollabStore} from '../src/collab/store.js';
import {CollabHub,type BaselineResolver} from '../src/collab/hub.js';
import {ValidationError} from '../src/collab/validate.js';
import type {CollabEvent,Participant} from '../src/collab/types.js';

const temp=()=>mkdtemp(path.join(tmpdir(),'collab-hub-'));
const rid=()=>`req-${randomUUID()}`;

describe('collab hub',()=>{
  let dir:string,metadata:MetadataStore,store:CollabStore,hub:CollabHub,events:CollabEvent[],commit:string,clock:number;
  const baseline:BaselineResolver=async()=>({vcs:'git',commit,paths:[]});

  beforeEach(async()=>{
    dir=await temp();metadata=new MetadataStore(dir);metadata.init();
    store=new CollabStore(()=>metadata.connection);
    commit='commit-1';clock=Date.now();events=[];
    hub=new CollabHub(store,{resolveBaseline:baseline,now:()=>clock});
    hub.init();hub.subscribe(event=>events.push(event));
  });
  afterEach(()=>metadata.close());

  const resolveCwd=async()=>dir;
  const newSession=async(policy?:Record<string,unknown>)=>hub.createSession({kind:'review',title:'Payment callback review',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~3..HEAD'},...(policy?{policy}:{})},resolveCwd);
  const addParticipant=(sessionId:string,role:string,displayName:string,extra:Record<string,unknown>={})=>hub.addParticipant(sessionId,{role,displayName,agentId:`agent-${displayName}`,...extra});
  const finding=(overrides:Record<string,unknown>={})=>({title:'Callback signature is never verified',severity:'critical',category:'security',
    location:{path:'src/pay/callback.ts',startLine:42,endLine:58},evidence:'handleCallback() parses the body and marks the order paid without checking the HMAC.',
    suggestion:'Verify the merchant HMAC and reject stale timestamps.',...overrides});
  const fileFindings=async(participant:Participant,findings:Record<string,unknown>[],reviewComplete=true,baselineId?:string)=>hub.submitFindings(participant,{
    clientRequestId:rid(),baselineId:baselineId??store.getBaselineForRound(participant.sessionId,store.getSession(participant.sessionId).round)!.baselineId,findings,reviewComplete});
  const typeOf=(type:string)=>events.filter(event=>event.type===type);

  const setup=async()=>{
    const session=await newSession();
    const r1=addParticipant(session.sessionId,'reviewer','reviewer-security');
    const r2=addParticipant(session.sessionId,'reviewer','reviewer-correctness');
    const impl=addParticipant(session.sessionId,'implementer','implementer',{agentId:'agent-1'});
    await hub.openRound(session.sessionId);
    return {session,r1:r1.participant,r2:r2.participant,impl:impl.participant,tokens:{r1:r1.token,r2:r2.token,impl:impl.token}};
  };

  it('rejects findings written against an outdated baseline and reports the current one',async()=>{
    const {r1}=await setup();
    await expect(fileFindings(r1,[finding()],true,'b-stale')).rejects.toMatchObject({code:'STALE_BASELINE'});
  });

  it('replays an identical submission instead of duplicating issues',async()=>{
    const {session,r1}=await setup();
    const clientRequestId=rid(),baselineId=store.getBaselineForRound(session.sessionId,1)!.baselineId;
    const first=await hub.submitFindings(r1,{clientRequestId,baselineId,findings:[finding()],reviewComplete:false});
    const replayed=await hub.submitFindings(r1,{clientRequestId,baselineId,findings:[finding()],reviewComplete:false});
    expect(replayed).toEqual(first);
    expect(store.listIssues(session.sessionId)).toHaveLength(1);
  });

  it('keeps findings blind until the collecting phase closes',async()=>{
    const {r1,r2}=await setup();
    await fileFindings(r1,[finding()],false);
    expect(hub.listIssues(r2)).toHaveLength(0);
    expect(hub.listIssues(r1)).toHaveLength(1);
    await fileFindings(r1,[],true);
    await fileFindings(r2,[]);
    expect(hub.listIssues(r2)).toHaveLength(1);
  });

  it('never advances a phase on its own while someone still owes work, and records who a human skipped',async()=>{
    const {session,r1}=await setup();
    await fileFindings(r1,[finding()]);
    expect(hub.getSession(session.sessionId).phase).toBe('collecting');
    clock+=3600*1000;
    hub.checkStalls();
    expect(hub.getSession(session.sessionId).stalled?.waitingOn).toEqual([expect.any(String)]);
    expect(hub.getSession(session.sessionId).phase).toBe('collecting');

    // Writing the stall flag bumps updatedAt, so a second sweep must not "un-stall" the session (and re-alert later).
    clock+=60*1000;
    expect(hub.checkStalls()).toEqual([]);
    expect(hub.getSession(session.sessionId).stalled?.waitingOn).toEqual([expect.any(String)]);

    await expect(hub.advance(session.sessionId,{force:false})).rejects.toMatchObject({code:'COLLAB_WRONG_PHASE'});
    await expect(hub.advance(session.sessionId,{force:true})).rejects.toBeInstanceOf(ValidationError);
    await hub.advance(session.sessionId,{force:true,reason:'reviewer-correctness crashed and will not return'});
    expect(hub.getSession(session.sessionId)).toMatchObject({phase:'finished',status:'finished'});
    const forced=typeOf('phase_changed').find(event=>event.payload.forced);
    expect(forced?.payload).toMatchObject({forcedBy:'human',forceReason:'reviewer-correctness crashed and will not return'});
    expect((forced?.payload.skipped as string[]).length).toBe(1);
  });

  it('locks writes and calls a human when a participant burns its token budget',async()=>{
    const session=await newSession();
    const reviewer=addParticipant(session.sessionId,'reviewer','reviewer-security',{tokenBudget:100}).participant;
    addParticipant(session.sessionId,'implementer','implementer');
    await hub.openRound(session.sessionId);
    await fileFindings(reviewer,[finding()],false);
    const exhausted=store.getParticipant(reviewer.participantId);
    expect(exhausted.state).toBe('budget_exhausted');
    await expect(fileFindings(exhausted,[finding()],false)).rejects.toMatchObject({code:'TOKEN_BUDGET_EXHAUSTED',httpStatus:429});
    expect(hub.listEscalations({status:'pending'})[0]).toMatchObject({kind:'budget_exhausted',refId:reviewer.participantId});
    expect(hub.digest(exhausted).you).toMatchObject({state:'budget_exhausted'});
  });

  it('refuses to seat the same agent twice and requires an agentId for managed participants',async()=>{
    const session=await newSession();
    hub.addParticipant(session.sessionId,{role:'reviewer',displayName:'r1',agentId:'agent-1'});
    expect(()=>hub.addParticipant(session.sessionId,{role:'reviewer',displayName:'r2',agentId:'agent-1'})).toThrow(/already registered/);
    expect(()=>hub.addParticipant(session.sessionId,{role:'reviewer',displayName:'r3',binding:{type:'managed'}})).toThrow(ValidationError);
  });

  it('requires a reviewer before a round opens and rejects a second open',async()=>{
    const session=await newSession();
    await expect(hub.openRound(session.sessionId)).rejects.toMatchObject({code:'COLLAB_WRONG_PHASE'});
    addParticipant(session.sessionId,'reviewer','r1');
    await hub.openRound(session.sessionId);
    await expect(hub.openRound(session.sessionId)).rejects.toThrow(/Round already open/);
  });

  it('authenticates only a known participant token',async()=>{
    const {tokens,r1}=await setup();
    expect(hub.authenticate(tokens.r1).participantId).toBe(r1.participantId);
    expect(hub.authenticate(tokens.r1).lastSeenAt).toBeTruthy();
    expect(()=>hub.authenticate('cpt_nope')).toThrow(expect.objectContaining({code:'COLLAB_FORBIDDEN',httpStatus:401}));
  });

  it('flags likely duplicates without merging them, and never across the blind seal',async()=>{
    const {session,r1,r2}=await setup();
    await fileFindings(r1,[finding()],false);
    const second=await hub.submitFindings(r2,{clientRequestId:rid(),baselineId:store.getBaselineForRound(session.sessionId,1)!.baselineId,
      findings:[finding({title:'Callback signature is never verified in handler'})],reviewComplete:false});
    // Blind collection: pointing at the rival's issueId would hand over the id needed to read the sealed finding.
    expect(second.possibleDuplicates).toEqual([]);
    expect(store.listIssues(session.sessionId)).toHaveLength(2);

    // With blind collection switched off the hint is back, because there is nothing left to protect.
    const open=await hub.createSession({kind:'review',title:'Open review',workspaceId:'ws-1',subject:{type:'free',value:'x'},policy:{blindFindings:false}},resolveCwd);
    const a=addParticipant(open.sessionId,'reviewer','reviewer-a').participant;
    const b=addParticipant(open.sessionId,'reviewer','reviewer-b').participant;
    addParticipant(open.sessionId,'implementer','impl');
    await hub.openRound(open.sessionId);
    await fileFindings(a,[finding()],false);
    const echo=await hub.submitFindings(b,{clientRequestId:rid(),baselineId:store.getBaselineForRound(open.sessionId,1)!.baselineId,
      findings:[finding({title:'Callback signature is never verified in handler'})],reviewComplete:false});
    expect(echo.possibleDuplicates[0]).toMatchObject({score:expect.any(Number)});
  });

  it('keeps a sealed finding unreadable even when its id is known',async()=>{
    const {session,r1,r2}=await setup();
    const {accepted}=await fileFindings(r1,[finding()],false);
    const issueId=accepted[0].issueId;
    // The rival may hold the id (from an earlier round, a duplicate hint, or a guess): the read must still 404.
    expect(()=>hub.issueDetail(session.sessionId,issueId,r2)).toThrow(expect.objectContaining({code:'COLLAB_ISSUE_NOT_FOUND',httpStatus:404}));
    expect(hub.issueDetail(session.sessionId,issueId,r1)).toMatchObject({issueId});
    expect(hub.issueDetail(session.sessionId,issueId)).toMatchObject({issueId});    // the human sees everything
    await fileFindings(r1,[],true);
    await fileFindings(r2,[],true);
    expect(hub.issueDetail(session.sessionId,issueId,r2)).toMatchObject({issueId}); // the seal lifted with the phase
  });

  it('keeps a replayable event log for reconnecting clients',async()=>{
    const {session,r1}=await setup();
    await fileFindings(r1,[finding()],false);
    const all=hub.events(session.sessionId);
    expect(all.map(event=>event.sequence)).toEqual(all.map((_,index)=>index+1));
    const tail=hub.events(session.sessionId,all.length-1);
    expect(tail).toHaveLength(1);
    expect(events.at(-1)?.sequence).toBe(all.length);
    // The tail view is what a board needs: paging from sequence 0 stops showing new activity once the log grows.
    expect(hub.recentEvents(session.sessionId,2).map(event=>event.sequence)).toEqual([all.length-1,all.length]);
  });

  it('withholds another participant\'s sealed submissions from the event timeline',async()=>{
    const {session,r1,r2}=await setup();
    await fileFindings(r1,[finding()],false);
    const seen=hub.events(session.sessionId,0,500,r2).filter(event=>event.type==='issue_opened');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({redacted:true});
    // The reporter still sees its own, and a human sees everything.
    expect(hub.events(session.sessionId,0,500,r1).find(event=>event.type==='issue_opened')?.payload.title).toBeTruthy();
    expect(hub.events(session.sessionId).find(event=>event.type==='issue_opened')?.payload.title).toBeTruthy();
    // Once collection closes there is nothing left to hide.
    await fileFindings(r1,[],true);
    await fileFindings(r2,[],true);
    expect(hub.events(session.sessionId,0,500,r2).find(event=>event.type==='issue_opened')?.payload.title).toBeTruthy();
  });

  it('applies the structured action of a non-issue escalation instead of only recording it',async()=>{
    const session=await newSession();
    const reviewer=addParticipant(session.sessionId,'reviewer','reviewer-security',{tokenBudget:100}).participant;
    addParticipant(session.sessionId,'implementer','implementer');
    await hub.openRound(session.sessionId);
    await fileFindings(reviewer,[finding()],false);
    const escalation=hub.listEscalations({status:'pending'})[0];
    // A ruling is one-shot, so a payload that would apply nothing must be refused instead of consuming it.
    await expect(hub.resolveEscalation(escalation.escalationId,{decision:'raise budget',rationale:'Give it more room to work.',extra:{tokenBudget:'50000'}})).rejects.toBeInstanceOf(ValidationError);
    await expect(hub.resolveEscalation(escalation.escalationId,{decision:'raise budget',rationale:'Give it more room to work.',extra:{tokenBudget:50}})).rejects.toBeInstanceOf(ValidationError);
    expect(hub.getEscalation(escalation.escalationId).status).toBe('pending');

    await hub.resolveEscalation(escalation.escalationId,{decision:'raise budget',rationale:'The review is worth another 50k tokens.',extra:{tokenBudget:50_000}});
    const restored=store.getParticipant(reviewer.participantId);
    expect(restored).toMatchObject({state:'active',tokenBudget:50_000});
    expect(typeOf('budget_raised')).toHaveLength(1);
    expect(typeOf('escalation_resolved')[0].payload.applied).toEqual(['tokenBudget:50000']);
    await expect(fileFindings(restored,[finding()],true)).resolves.toMatchObject({round:1});
  });

  it('raises a spent budget outside the one-shot ruling and re-announces the pending task',async()=>{
    const session=await newSession();
    const reviewer=addParticipant(session.sessionId,'reviewer','reviewer-security',{tokenBudget:100}).participant;
    addParticipant(session.sessionId,'implementer','implementer');
    await hub.openRound(session.sessionId);
    await fileFindings(reviewer,[finding()],false);
    const escalation=hub.listEscalations({status:'pending'})[0];
    // The human first chose "replace the agent", which consumes the escalation without raising anything.
    await hub.resolveEscalation(escalation.escalationId,{decision:'replace participant',rationale:'I will hand the seat to another agent.'});
    expect(store.getParticipant(reviewer.participantId).state).toBe('budget_exhausted');
    await expect(hub.resolveEscalation(escalation.escalationId,{decision:'raise budget',rationale:'Changed my mind about the budget.',extra:{tokenBudget:50_000}})).rejects.toMatchObject({code:'COLLAB_CONFLICT'});

    // The seat is still recoverable: raising the budget is its own endpoint, usable at any time.
    expect(()=>hub.raiseParticipantBudget(session.sessionId,reviewer.participantId,{tokenBudget:100})).toThrow(ValidationError);
    const raised=hub.raiseParticipantBudget(session.sessionId,reviewer.participantId,{tokenBudget:50_000});
    expect(raised).toMatchObject({state:'active',tokenBudget:50_000});
    expect(typeOf('task_assigned').filter(event=>event.payload.reason==='budget_raised').length).toBeGreaterThan(0);
    await expect(fileFindings(raised,[finding()],true)).resolves.toMatchObject({round:1});
  });

  it('finishes review after collection and keeps accepted findings as confirmed action items',async()=>{
    const {session,r1,r2,impl}=await setup();
    const submitted=await fileFindings(r1,[finding({externalId:'sec-1'})]);
    await fileFindings(r2,[]);
    const issueId=submitted.accepted[0].issueId,finished=hub.getSession(session.sessionId);
    expect(finished).toMatchObject({phase:'finished',status:'finished',outcome:{verdict:'changes_required'}});
    expect(store.getIssue(issueId).status).toBe('confirmed');
    expect(hub.digest(impl)).toMatchObject({task:'wait',phase:'finished'});
    expect(typeOf('phase_changed').map(event=>event.payload.to)).toEqual(['collecting','consolidating','finished']);
  });

  it('lets a human add a new developer, run a fix, and have the original reviewers recheck it',async()=>{
    const {session,r1,r2}=await setup();
    const submitted=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const issueId=submitted.accepted[0].issueId;
    const developer=addParticipant(session.sessionId,'implementer','remediation-developer').participant;
    await hub.startRecheck(session.sessionId,{mode:'fix_then_review',implementerParticipantIds:[developer.participantId]});
    expect(hub.getSession(session.sessionId)).toMatchObject({phase:'implementing',status:'active',round:2});
    expect(hub.digest(developer)).toMatchObject({task:'implement',issues:[expect.objectContaining({issueId,status:'confirmed'})]});

    commit='commit-2';
    await hub.markImplementationReady(developer,{clientRequestId:rid(),summary:'Added callback HMAC verification and regression coverage.',changes:[{path:'src/pay/callback.ts',summary:'verify HMAC'}],codeRef:{commit:'commit-2'}});
    expect(hub.getSession(session.sessionId).phase).toBe('collecting');
    expect(hub.digest(store.getParticipant(r1.participantId))).toMatchObject({task:'file_findings',issuesToRecheck:[expect.objectContaining({issueId})]});
    await expect(fileFindings(store.getParticipant(r1.participantId),[])).rejects.toBeInstanceOf(ValidationError);
    const baselineId=store.getBaselineForRound(session.sessionId,2)!.baselineId;
    await hub.submitFindings(store.getParticipant(r1.participantId),{clientRequestId:rid(),baselineId,findings:[],rechecks:[{issueId,outcome:'resolved',rationale:'The implementation now verifies the callback HMAC before updating payment state.'}],reviewComplete:true});
    await hub.submitFindings(store.getParticipant(r2.participantId),{clientRequestId:rid(),baselineId,findings:[],rechecks:[],reviewComplete:true});
    expect(hub.getSession(session.sessionId)).toMatchObject({phase:'finished',status:'finished',round:2,outcome:{verdict:'approved'}});
  });

  it('rechecks a finished review directly and resolves the original reporters confirmed finding',async()=>{
    const {session,r1,r2}=await setup();
    const submitted=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const issueId=submitted.accepted[0].issueId;
    await hub.startRecheck(session.sessionId,{mode:'review_only'});
    const baselineId=store.getBaselineForRound(session.sessionId,2)!.baselineId;
    await hub.submitFindings(store.getParticipant(r1.participantId),{clientRequestId:rid(),baselineId,findings:[],rechecks:[{issueId,outcome:'resolved',rationale:'The new baseline verifies the HMAC before changing payment state.'}],reviewComplete:true});
    await hub.submitFindings(store.getParticipant(r2.participantId),{clientRequestId:rid(),baselineId,findings:[],rechecks:[],reviewComplete:true});
    expect(hub.getSession(session.sessionId)).toMatchObject({phase:'finished',status:'finished',round:2,outcome:{verdict:'approved'}});
    expect(store.getIssue(issueId).status).toBe('resolved');
  });

});
