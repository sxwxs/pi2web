import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../src/metadata-store.js';
import {CollabStore} from '../src/collab/store.js';
import {CollabHub,responseFieldErrors,type BaselineResolver} from '../src/collab/hub.js';
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
  const addParticipant=(sessionId:string,role:string,displayName:string,extra:Record<string,unknown>={})=>hub.addParticipant(sessionId,{role,displayName,binding:{type:'external'},...extra});
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
    const impl=addParticipant(session.sessionId,'implementer','implementer',{binding:{type:'managed',agentId:'agent-1'}});
    await hub.openRound(session.sessionId);
    return {session,r1:r1.participant,r2:r2.participant,impl:impl.participant,tokens:{r1:r1.token,r2:r2.token,impl:impl.token}};
  };

  it('runs a full round: findings, responses, verdicts, and a finished session',async()=>{
    const {session,r1,r2,impl}=await setup();
    expect(hub.getSession(session.sessionId).phase).toBe('collecting');
    expect(store.getBaselineForRound(session.sessionId,1)?.commit).toBe('commit-1');

    const submitted=await fileFindings(r1,[finding({externalId:'sec-1'})]);
    expect(submitted.accepted).toHaveLength(1);
    expect(hub.getSession(session.sessionId).phase).toBe('collecting');

    await fileFindings(r2,[]);
    expect(hub.getSession(session.sessionId).phase).toBe('responding');

    const issueId=submitted.accepted[0].issueId;
    expect(hub.digest(impl)).toMatchObject({task:'respond_to_issues'});
    commit='commit-2';
    const responded=await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'fixed',changes:[{path:'src/pay/callback.ts',summary:'verify HMAC and timestamp'}],codeRef:{commit:'commit-2'}}]});
    expect(responded.accepted).toEqual([{issueId,status:'answered'}]);
    expect(hub.getSession(session.sessionId).phase).toBe('adjudicating');

    expect(hub.digest(r2)).toMatchObject({task:'wait'});
    await hub.submitVerdicts(r1,{clientRequestId:rid(),verdicts:[{issueId,verdict:'accept'}]});
    const finished=hub.getSession(session.sessionId);
    expect(finished.phase).toBe('finished');
    expect(finished.status).toBe('finished');
    expect(finished.outcome).toMatchObject({totalIssues:1,byStatus:{resolved:1}});
    expect(typeOf('phase_changed').map(event=>event.payload.to)).toEqual(['collecting','consolidating','responding','adjudicating','finished']);
  });

  it('reopens on reject, opens the next round, and pins a fresh baseline',async()=>{
    const {session,r1,r2,impl}=await setup();
    const {accepted}=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const issueId=accepted[0].issueId;
    commit='commit-2';
    await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'rejected',rationale:'The gateway already validates the signature at the edge proxy, so this path cannot be reached.'}]});
    await hub.submitVerdicts(r1,{clientRequestId:rid(),verdicts:[{issueId,verdict:'reject',rationale:'The edge proxy is bypassed for internal retries, so the callback path is still reachable.'}]});

    const session2=hub.getSession(session.sessionId);
    expect(session2).toMatchObject({phase:'collecting',round:2,status:'active'});
    expect(store.getIssue(issueId)).toMatchObject({status:'open',round:2});
    expect(store.getBaselineForRound(session.sessionId,2)?.commit).toBe('commit-2');
    expect(store.getBaselineForRound(session.sessionId,1)?.commit).toBe('commit-1');
  });

  it('rejects findings written against an outdated baseline and reports the current one',async()=>{
    const {r1}=await setup();
    await expect(fileFindings(r1,[finding()],true,'b-stale')).rejects.toMatchObject({code:'STALE_BASELINE'});
  });

  it('rejects a claimed fix that did not touch the code',async()=>{
    const {session,r1,r2,impl}=await setup();
    const {accepted}=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const result=await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId:accepted[0].issueId,responseType:'fixed',changes:[{path:'src/pay/callback.ts',summary:'claimed fix'}],codeRef:{commit:'commit-1'}}]});
    expect(result.rejected).toEqual([expect.objectContaining({code:'NO_CODE_CHANGE'})]);
    expect(hub.getSession(session.sessionId).phase).toBe('responding');
  });

  it('demands a rationale before a disagreement is accepted',async()=>{
    const {r1,r2,impl}=await setup();
    const {accepted}=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const issueId=accepted[0].issueId;
    await expect(hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'rejected',rationale:'nope'}]}))
      .rejects.toMatchObject({code:'VALIDATION_FAILED'});
    await expect(hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'fixed',changes:[]}]}))
      .rejects.toBeInstanceOf(ValidationError);
    await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'rejected',rationale:'The signature is validated by the gateway before this handler ever runs.'}]});
    await expect(hub.submitVerdicts(r1,{clientRequestId:rid(),verdicts:[{issueId,verdict:'reject',rationale:'no'}]}))
      .rejects.toMatchObject({code:'VALIDATION_FAILED'});
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

  it('routes a dispute to a human, parks the session, and applies the final ruling',async()=>{
    const {session,r1,r2,impl}=await setup();
    const {accepted}=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const issueId=accepted[0].issueId;
    commit='commit-2';
    await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'rejected',rationale:'This code path is unreachable in production because the proxy terminates it.'}]});
    await hub.submitVerdicts(r1,{clientRequestId:rid(),verdicts:[{issueId,verdict:'escalate',rationale:'We disagree on whether the proxy can be bypassed; a human should decide this.'}]});

    expect(hub.getSession(session.sessionId).phase).toBe('awaiting_human');
    const [escalation]=hub.listEscalations({status:'pending'});
    expect(escalation).toMatchObject({kind:'issue_dispute',refId:issueId,urgency:'high'});
    expect(hub.digest(impl).task).toBe('wait');

    await hub.resolveEscalation(escalation.escalationId,{decision:'fix in this round',rationale:'Internal retries bypass the proxy, so the callback must verify the signature itself.',issueDecision:'resolved'});
    expect(store.getIssue(issueId).status).toBe('human_ruled');
    expect(hub.getSession(session.sessionId)).toMatchObject({phase:'finished',status:'finished'});
    await expect(hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId,responseType:'fixed',changes:[{path:'a.ts',summary:'placeholder change'}],codeRef:{commit:'c3'}}]}))
      .rejects.toMatchObject({code:'COLLAB_WRONG_PHASE'});
  });

  it('lets a participant hand a dispute to a human directly',async()=>{
    const {session,r1,r2,impl}=await setup();
    const {accepted}=await fileFindings(r1,[finding()]);
    await fileFindings(r2,[]);
    const escalation=await hub.raiseEscalation(impl,{clientRequestId:rid(),kind:'issue_dispute',refId:accepted[0].issueId,
      summary:'We cannot agree on whether the callback path is reachable in production at all.',
      question:'Is the unauthenticated callback path reachable?',options:['yes','no'],urgency:'high'});
    expect(escalation.status).toBe('pending');
    expect(store.getIssue(accepted[0].issueId).status).toBe('escalated');
    expect(hub.getSession(session.sessionId).phase).toBe('awaiting_human');
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
    expect(hub.getSession(session.sessionId).phase).toBe('responding');
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

  it('supports reverse review: an implementer files an issue against a reviewer',async()=>{
    const {session,r1,r2,impl}=await setup();
    const {accepted}=await hub.submitFindings(impl,{clientRequestId:rid(),baselineId:store.getBaselineForRound(session.sessionId,1)!.baselineId,
      findings:[finding({title:'Finding sec-1 cites a line that does not exist',targetParticipantId:r1.participantId,category:'process',severity:'minor'})],reviewComplete:false});
    await fileFindings(r1,[]);
    await fileFindings(r2,[]);
    expect(hub.getSession(session.sessionId).phase).toBe('responding');
    expect(hub.digest(r1)).toMatchObject({task:'respond_to_issues'});
    await hub.submitResponses(r1,{clientRequestId:rid(),responses:[{issueId:accepted[0].issueId,responseType:'fixed',changes:[{path:'review.md',summary:'corrected the line reference'}],codeRef:{dirtyHash:'sha256:abc'}}]});
    expect(hub.getSession(session.sessionId).phase).toBe('adjudicating');
    await hub.submitVerdicts(impl,{clientRequestId:rid(),verdicts:[{issueId:accepted[0].issueId,verdict:'accept'}]});
    expect(hub.getSession(session.sessionId).phase).toBe('finished');
  });

  it('refuses cross-session issue ids and self-addressed findings',async()=>{
    const {session,r1,r2,impl}=await setup();
    const other=await setup();
    const {accepted}=await fileFindings(other.r1,[finding()]);
    const mixed=await fileFindings(r1,[finding({targetParticipantId:r1.participantId}),finding()]);
    expect(mixed.rejected).toEqual([expect.objectContaining({code:'SELF_TARGET'})]);
    expect(mixed.accepted).toHaveLength(1);
    await fileFindings(r2,[]);
    const leak=await hub.submitResponses(impl,{clientRequestId:rid(),responses:[{issueId:accepted[0].issueId,responseType:'fixed',changes:[{path:'a.ts',summary:'placeholder change'}],codeRef:{commit:'c9'}}]});
    expect(leak.rejected).toEqual([expect.objectContaining({code:'COLLAB_ISSUE_NOT_FOUND'})]);
    expect(hub.getSession(session.sessionId).phase).toBe('responding');
  });

  it('refuses to seat the same agent twice and requires an agentId for managed participants',async()=>{
    const session=await newSession();
    hub.addParticipant(session.sessionId,{role:'reviewer',displayName:'r1',binding:{type:'managed',agentId:'agent-1'}});
    expect(()=>hub.addParticipant(session.sessionId,{role:'reviewer',displayName:'r2',binding:{type:'managed',agentId:'agent-1'}})).toThrow(/already registered/);
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

  it('flags likely duplicates without merging them',async()=>{
    const {session,r1,r2}=await setup();
    await fileFindings(r1,[finding()],false);
    const second=await hub.submitFindings(r2,{clientRequestId:rid(),baselineId:store.getBaselineForRound(session.sessionId,1)!.baselineId,
      findings:[finding({title:'Callback signature is never verified in handler'})],reviewComplete:false});
    expect(second.possibleDuplicates[0]).toMatchObject({score:expect.any(Number)});
    expect(store.listIssues(session.sessionId)).toHaveLength(2);
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

  it('gives a late participant the current task and refuses a seat the phase cannot assign',async()=>{
    const {session,r1,r2,impl}=await setup();
    const late=addParticipant(session.sessionId,'reviewer','reviewer-late').participant;
    expect(store.listInbox(late.participantId).map(item=>item.type)).toEqual(['file_findings']);
    expect(hub.progress(session.sessionId).waitingOn).toContain(late.participantId);
    for(const reviewer of [r1,r2,late])await fileFindings(reviewer,[finding()],true);
    expect(hub.getSession(session.sessionId).phase).toBe('responding');
    expect(()=>addParticipant(session.sessionId,'reviewer','reviewer-too-late')).toThrow(/can only be registered in phase/);
    expect(hub.digest(impl)).toMatchObject({task:'respond_to_issues'});
  });

  it('applies the structured action of a non-issue escalation instead of only recording it',async()=>{
    const session=await newSession();
    const reviewer=addParticipant(session.sessionId,'reviewer','reviewer-security',{tokenBudget:100}).participant;
    addParticipant(session.sessionId,'implementer','implementer');
    await hub.openRound(session.sessionId);
    await fileFindings(reviewer,[finding()],false);
    const escalation=hub.listEscalations({status:'pending'})[0];
    await hub.resolveEscalation(escalation.escalationId,{decision:'raise budget',rationale:'The review is worth another 50k tokens.',extra:{tokenBudget:50_000}});
    const restored=store.getParticipant(reviewer.participantId);
    expect(restored).toMatchObject({state:'active',tokenBudget:50_000});
    expect(typeOf('budget_raised')).toHaveLength(1);
    await expect(fileFindings(restored,[finding()],true)).resolves.toMatchObject({round:1});
  });
});

describe('response cross-field rules',()=>{
  it('demands proof for a claimed fix and a reason for a refusal',()=>{
    expect(responseFieldErrors({responseType:'fixed',changes:[]} as any,0).map(error=>error.path)).toEqual(['responses[0].changes','responses[0].codeRef']);
    expect(responseFieldErrors({responseType:'rejected',changes:[],rationale:'no'} as any,1)).toEqual([expect.objectContaining({path:'responses[1].rationale'})]);
    expect(responseFieldErrors({responseType:'needs_info',changes:[]} as any,2)).toEqual([expect.objectContaining({path:'responses[2].question'})]);
    expect(responseFieldErrors({responseType:'fixed',changes:[{path:'a.ts',summary:'done'}],codeRef:{commit:'abc'}} as any,0)).toEqual([]);
  });
});
