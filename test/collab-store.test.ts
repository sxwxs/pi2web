import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MetadataStore} from '../src/metadata-store.js';
import {CollabStore,hashToken,mergePolicy} from '../src/collab/store.js';
import {arr,bool,num,obj,oneOf,optional,parse,str,ValidationError,withDefault} from '../src/collab/validate.js';
import {CAPABILITIES,DEFAULT_POLICY,can,COLLAB_ERRORS} from '../src/collab/types.js';

const temp=()=>mkdtemp(path.join(tmpdir(),'collab-'));
const errorsOf=(fn:()=>unknown)=>{try{fn()}catch(error){if(error instanceof ValidationError)return error.fieldErrors;throw error}throw new Error('Expected a ValidationError')};

describe('collab validator',()=>{
  const finding=obj({
    title:str({min:5,max:200}),
    severity:oneOf(['blocker','critical','major','minor','nit'] as const),
    confidence:optional(num({min:0,max:1})),
    reviewComplete:withDefault(bool(),()=>false),
    location:obj({path:str({max:400}),startLine:optional(num({integer:true,min:1}))}),
    tags:withDefault(arr(str({max:20}),{max:3}),()=>[] as string[])
  });

  it('accepts a valid payload and applies defaults',()=>{
    expect(parse(finding,{title:'Missing signature check',severity:'critical',location:{path:'src/pay.ts',startLine:42}}))
      .toEqual({title:'Missing signature check',severity:'critical',reviewComplete:false,location:{path:'src/pay.ts',startLine:42},tags:[]});
  });

  it('reports every field error at once with a machine-readable path and code',()=>{
    const errors=errorsOf(()=>parse(finding,{title:'x',severity:'urgent',confidence:2,location:{path:'a.ts',startLine:0}}));
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'title',code:'TOO_SHORT'}),
      expect.objectContaining({path:'severity',code:'NOT_ALLOWED',expected:'blocker|critical|major|minor|nit'}),
      expect.objectContaining({path:'confidence',code:'TOO_LARGE'}),
      expect.objectContaining({path:'location.startLine',code:'TOO_SMALL'})
    ]));
  });

  it('rejects unknown fields so a typo cannot be silently dropped',()=>{
    const errors=errorsOf(()=>parse(finding,{title:'Missing check',serverity:'critical',location:{path:'a.ts'}}));
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'serverity',code:'UNKNOWN_FIELD'}),
      expect.objectContaining({path:'severity',code:'REQUIRED'})
    ]));
  });

  it('reports missing required fields and array item paths',()=>{
    const errors=errorsOf(()=>parse(finding,{severity:'nit',location:{path:'a.ts'},tags:['ok','way-too-long-tag-value']}));
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'title',code:'REQUIRED'}),
      expect.objectContaining({path:'tags[1]',code:'TOO_LONG'})
    ]));
  });

  it('validates numeric steps without floating point drift',()=>{
    const score=obj({value:num({min:0,max:10,step:0.5})});
    expect(parse(score,{value:6.5}).value).toBe(6.5);
    expect(errorsOf(()=>parse(score,{value:6.3}))).toEqual([expect.objectContaining({code:'NOT_A_MULTIPLE'})]);
  });

  it('rejects wrong container types instead of coercing them',()=>{
    expect(errorsOf(()=>parse(finding,'not an object'))).toEqual([expect.objectContaining({path:'(root)',code:'NOT_AN_OBJECT'})]);
    expect(errorsOf(()=>parse(obj({items:arr(str())}),{items:'a,b'}))).toEqual([expect.objectContaining({path:'items',code:'NOT_AN_ARRAY'})]);
  });
});

describe('collab capabilities',()=>{
  it('lets any role file findings but reserves implementation readiness for developers',()=>{
    for(const role of ['implementer','reviewer','moderator'] as const)expect(can(role,'file_finding')).toBe(true);
    expect(can('implementer','ready')).toBe(true);
    expect(can('reviewer','ready')).toBe(false);
    expect(can('moderator','ready')).toBe(false);
  });
  it('recuses the implementer from scoring but keeps clarification open',()=>{
    expect(can('implementer','score')).toBe(false);
    expect(can('implementer','vote')).toBe(false);
    expect(can('implementer','nominate')).toBe(false);
    expect(can('implementer','debate')).toBe(false);
    expect(can('implementer','clarify')).toBe(true);
    expect(CAPABILITIES.reviewer).toContain('score');
  });
});

describe('collab store',()=>{
  let dir:string,metadata:MetadataStore,store:CollabStore;
  beforeEach(async()=>{dir=await temp();metadata=new MetadataStore(dir);metadata.init();store=new CollabStore(()=>metadata.connection);store.init()});
  afterEach(()=>metadata.close());

  const newSession=()=>store.createSession({kind:'review',title:'Pay refactor',workspaceId:'ws-1',cwd:dir,subject:{type:'commit_range',value:'HEAD~3..HEAD'}});
  const newIssue=(sessionId:string,reporterId:string,targetParticipantId:string,baselineId:string)=>store.createIssue({
    sessionId,reporterId,targetParticipantId,title:'Callback signature is never verified',severity:'critical',category:'security',
    requiredAction:'must_fix',location:{path:'src/pay/callback.ts',startLine:42,endLine:58},baselineId,round:1
  });

  it('creates sessions with merged policy defaults and keeps the schema version at 3',()=>{
    const session=store.createSession({kind:'review',title:'x',workspaceId:'ws-1',cwd:dir,subject:{type:'free',value:'x'},policy:{maxIssueRounds:5,scoring:{convergenceRange:1.5} as any}});
    expect(session.phase).toBe('draft');
    expect(session.policy.maxIssueRounds).toBe(5);
    expect(session.policy.tokenBudgetPerParticipant).toBe(600_000);
    expect(session.policy.scoring.convergenceRange).toBe(1.5);
    expect(session.policy.scoring.maxDebateRounds).toBe(DEFAULT_POLICY.scoring.maxDebateRounds);
    expect(store.createSession({kind:'scoring',title:'y',workspaceId:'ws-1',cwd:dir,subject:{type:'free',value:'y'}}).phase).toBe('nominating');
    expect(Number(metadata.connection.pragma('user_version',{simple:true}))).toBe(4);
  });

  it('stores only the hash of a participant token and resolves it back',()=>{
    const session=newSession();
    const {participant,token}=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'reviewer-security',agentId:'agent-reviewer-security'});
    expect(participant.tokenBudget).toBe(600_000);
    expect(store.findParticipantByToken(token)?.participantId).toBe(participant.participantId);
    expect(store.findParticipantByToken('cpt_wrong')).toBeUndefined();
    const stored=metadata.connection.prepare('SELECT token_hash FROM collab_participants WHERE id=?').get(participant.participantId) as any;
    expect(stored.token_hash).toBe(hashToken(token));
    expect(stored.token_hash).not.toContain(token);
  });

  it('locks writes once the token budget is spent but keeps the record readable',()=>{
    const session=newSession();
    const {participant}=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-r1',tokenBudget:1000});
    expect(store.addTokenUsage(participant.participantId,400,false).state).toBe('active');
    const exhausted=store.addTokenUsage(participant.participantId,700,true);
    expect(exhausted.state).toBe('budget_exhausted');
    expect(exhausted.tokensUsed).toBe(1100);
    expect(exhausted.tokensEstimated).toBe(true);
    expect(store.getParticipant(participant.participantId).state).toBe('budget_exhausted');
  });

  it('appends events with a gapless per-session sequence and replays from a cursor',()=>{
    const first=newSession(),second=newSession();
    store.appendEvent(first.sessionId,'session_created',{title:'a'});
    store.appendEvent(first.sessionId,'round_opened',{round:1},'p-1');
    store.appendEvent(second.sessionId,'session_created',{title:'b'});
    expect(store.listEvents(first.sessionId).map(event=>event.sequence)).toEqual([1,2]);
    expect(store.listEvents(second.sessionId).map(event=>event.sequence)).toEqual([1]);
    const tail=store.listEvents(first.sessionId,1);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({type:'round_opened',actorId:'p-1',payload:{round:1}});
  });

  it('tracks issues with optimistic locking and an append-only message trail',()=>{
    const session=newSession();
    const reporter=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-r1'}).participant;
    const target=store.createParticipant({sessionId:session.sessionId,role:'implementer',displayName:'impl',agentId:'agent-1'}).participant;
    const baseline=store.saveBaseline({sessionId:session.sessionId,round:1,vcs:'git',commit:'9f2c1ab',paths:['src/pay']});
    const issue=newIssue(session.sessionId,reporter.participantId,target.participantId,baseline.baselineId);
    expect(issue.status).toBe('open');
    expect(issue.version).toBe(1);

    store.addIssueMessage(issue.issueId,1,target.participantId,'response',{responseType:'fixed',changes:[{path:'src/pay/callback.ts'}]});
    const answered=store.updateIssue(issue.issueId,{status:'answered'},1);
    expect(answered.version).toBe(2);
    expect(()=>store.updateIssue(issue.issueId,{status:'resolved'},1)).toThrow(/modified concurrently/);
    expect(store.getIssue(issue.issueId).status).toBe('answered');
    expect(store.updateIssue(issue.issueId,{status:'resolved'},2).status).toBe('resolved');

    store.addIssueMessage(issue.issueId,1,reporter.participantId,'verdict',{verdict:'accept'});
    expect(store.listIssueMessages(issue.issueId).map(message=>message.kind)).toEqual(['response','verdict']);
    expect(store.listIssues(session.sessionId,{status:['open']})).toHaveLength(0);
    expect(store.listIssues(session.sessionId,{reporterId:reporter.participantId})).toHaveLength(1);
  });

  it('keeps one baseline per round and rewrites it in place',()=>{
    const session=newSession();
    const first=store.saveBaseline({sessionId:session.sessionId,round:1,vcs:'git',commit:'aaa',paths:[]});
    const rewritten=store.saveBaseline({sessionId:session.sessionId,round:1,vcs:'git',commit:'bbb',dirtyHash:'sha256:1',paths:['src']});
    expect(rewritten.baselineId).toBe(first.baselineId);
    expect(store.getBaselineForRound(session.sessionId,1)).toMatchObject({commit:'bbb',dirtyHash:'sha256:1',paths:['src']});
    expect(store.getBaseline(first.baselineId)?.commit).toBe('bbb');
    expect(store.getBaselineForRound(session.sessionId,2)).toBeUndefined();
  });

  it('queues escalations for humans and records the final ruling',()=>{
    const session=newSession();
    const raiser=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-r1'}).participant;
    const escalation=store.createEscalation({sessionId:session.sessionId,kind:'issue_dispute',refId:'i-7',raisedBy:raiser.participantId,
      summary:'Signature check disagreement',positions:[{participantId:raiser.participantId,stance:'must_fix',rationale:'Forgeable callback'}],
      question:'Must the signature check land this round?',options:['fix now','defer'],urgency:'high'});
    expect(store.listEscalations({status:'pending'})).toHaveLength(1);
    expect(store.findPendingEscalation(session.sessionId,'issue_dispute','i-7')?.escalationId).toBe(escalation.escalationId);
    expect(store.findPendingEscalation(session.sessionId,'budget_exhausted')).toBeUndefined();
    const resolved=store.resolveEscalation(escalation.escalationId,{decision:'fix now'},'human');
    expect(resolved).toMatchObject({status:'resolved',resolvedBy:'human',decision:{decision:'fix now'}});
    expect(resolved.resolvedAt).toBeTruthy();
    expect(store.listEscalations({status:'pending'})).toHaveLength(0);
  });

  it('keeps queued wake-ups pending until they are acknowledged',()=>{
    const session=newSession();
    const participant=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-r1'}).participant;
    const first=store.pushInbox(session.sessionId,participant.participantId,'review_task',{round:1});
    store.pushInbox(session.sessionId,participant.participantId,'verdict_task',{round:1});
    expect(store.listInbox(participant.participantId)).toHaveLength(2);
    // The dispatcher acks an item once the agent has been told about it; a pending item means "not delivered yet".
    store.ackInbox(participant.participantId,[first.itemId]);
    expect(store.listInbox(participant.participantId).map(item=>item.type)).toEqual(['verdict_task']);
    expect(store.listInbox(participant.participantId,true)).toHaveLength(2);
  });

  it('replays an idempotent response instead of duplicating work',()=>{
    const session=newSession();
    const participant=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-r1'}).participant;
    expect(store.getIdempotent('key-1')).toBeUndefined();
    store.saveIdempotent('key-1',session.sessionId,participant.participantId,{accepted:[{issueId:'i-1'}]});
    expect(store.getIdempotent<{accepted:{issueId:string}[]}>('key-1')?.accepted[0].issueId).toBe('i-1');
    store.pruneIdempotency(-1);
    expect(store.getIdempotent('key-1')).toBeUndefined();
  });

  it('reports stable not-found codes instead of leaking other sessions',()=>{
    expect(()=>store.getSession('collab-missing')).toThrow(expect.objectContaining({code:COLLAB_ERRORS.sessionNotFound}));
    expect(()=>store.getIssue('i-missing')).toThrow(expect.objectContaining({code:COLLAB_ERRORS.issueNotFound}));
    expect(()=>store.getParticipant('p-missing')).toThrow(expect.objectContaining({code:COLLAB_ERRORS.participantNotFound}));
    expect(()=>store.getEscalation('esc-missing')).toThrow(expect.objectContaining({code:COLLAB_ERRORS.escalationNotFound}));
    expect(store.findSession('collab-missing')).toBeUndefined();
  });

  it('survives a restart with the same database file',()=>{
    const session=newSession();
    store.appendEvent(session.sessionId,'session_created',{});
    metadata.close();
    const reopened=new MetadataStore(dir);reopened.init();
    const restored=new CollabStore(()=>reopened.connection);restored.init();
    expect(restored.getSession(session.sessionId).title).toBe('Pay refactor');
    expect(restored.listEvents(session.sessionId)).toHaveLength(1);
    reopened.close();
    metadata=new MetadataStore(dir);metadata.init();
  });

  it('stores only the hash of a seat token and drops a legacy plaintext column',()=>{
    const session=newSession();
    const {participant,token}=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-1',tokenBudget:1000});
    const columns=(metadata.connection.prepare('PRAGMA table_info(collab_participants)').all() as {name:string}[]).map(column=>column.name);
    expect(columns).not.toContain('dispatch_token');
    const row=metadata.connection.prepare('SELECT * FROM collab_participants WHERE id=?').get(participant.participantId) as Record<string,unknown>;
    expect(Object.values(row)).not.toContain(token);
    expect(row.token_hash).toBe(hashToken(token));
    expect(store.findParticipantByToken(token)?.participantId).toBe(participant.participantId);
    // Rotating (recheck) and rebinding must not write the new plaintext anywhere either.
    const rotated=store.rotateParticipantToken(participant.participantId);
    const rebound=store.rebindParticipant(participant.participantId,'agent-2');
    const after=metadata.connection.prepare('SELECT * FROM collab_participants WHERE id=?').get(participant.participantId) as Record<string,unknown>;
    expect(Object.values(after)).not.toContain(rotated);
    expect(Object.values(after)).not.toContain(rebound.token);
    expect(store.findParticipantByToken(rebound.token)?.agentId).toBe('agent-2');
  });

  it('wipes a legacy plaintext token column on the next start',()=>{
    const session=newSession();
    const {participant,token}=store.createParticipant({sessionId:session.sessionId,role:'reviewer',displayName:'r1',agentId:'agent-1',tokenBudget:1000});
    // Simulate a database written by the version that kept the seat's bearer token in clear text.
    metadata.connection.exec('ALTER TABLE collab_participants ADD COLUMN dispatch_token TEXT');
    metadata.connection.prepare('UPDATE collab_participants SET dispatch_token=? WHERE id=?').run(token,participant.participantId);

    store.init();

    const columns=(metadata.connection.prepare('PRAGMA table_info(collab_participants)').all() as {name:string}[]).map(column=>column.name);
    const row=metadata.connection.prepare('SELECT * FROM collab_participants WHERE id=?').get(participant.participantId) as Record<string,unknown>;
    expect(columns.includes('dispatch_token')?row.dispatch_token:undefined).toBeFalsy();   // dropped, or at least emptied
    expect(Object.values(row)).not.toContain(token);
    expect(store.findParticipantByToken(token)?.participantId).toBe(participant.participantId);
  });

  it('keeps mergePolicy pure so defaults are never mutated',()=>{
    const merged=mergePolicy({maxTotalRounds:9,scoring:{scale:{min:0,max:100,step:1}} as any});
    expect(merged.maxTotalRounds).toBe(9);
    expect(merged.scoring.scale).toEqual({min:0,max:100,step:1});
    expect(DEFAULT_POLICY.maxTotalRounds).toBe(6);
    expect(DEFAULT_POLICY.scoring.scale).toEqual({min:0,max:10,step:0.5});
  });
});
