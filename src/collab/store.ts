import type Database from 'better-sqlite3';
import {randomUUID,createHash} from 'node:crypto';
import {COLLAB_ERRORS,DEFAULT_POLICY,type Baseline,type Criterion,type CriterionState,type Debate,type DebateStance,type Score,type Vote,type VoteStance,type CollabEvent,type CollabPolicy,type CollabSession,type CollabSubject,type Escalation,type EscalationKind,type EscalationStatus,type InboxItem,type Issue,type IssueMessage,type IssueMessageKind,type IssueStatus,type Participant,type Role,type Urgency} from './types.js';

const now=()=>Date.now();
const iso=(value:number)=>new Date(value).toISOString();
const asTime=(value:string|number|undefined)=>{const time=typeof value==='number'?value:Date.parse(value??'');return Number.isFinite(time)?time:now()};
const json=<T>(value:string|null,fallback:T):T=>{if(value===null||value===undefined)return fallback;try{return JSON.parse(value) as T}catch{return fallback}};
export const hashToken=(token:string)=>createHash('sha256').update(token).digest('hex');
const notFound=(code:string,message:string)=>Object.assign(new Error(message),{code});

export type CreateSessionInput={kind:CollabSession['kind'],title:string,workspaceId:string,cwd:string,subject:CollabSubject,policy?:Partial<CollabPolicy>};
export type CreateParticipantInput={sessionId:string,role:Role,displayName:string,model?:string,bindingType:'managed'|'external',agentId?:string,tokenBudget?:number};
export type CreateIssueInput=Omit<Issue,'issueId'|'status'|'version'|'createdAt'|'updatedAt'|'mergedInto'>&{status?:IssueStatus};
export type CreateEscalationInput={sessionId:string,kind:EscalationKind,refId?:string,raisedBy:string,summary:string,positions:Escalation['positions'],question:string,options:string[],urgency:Urgency};

/**
 * SQLite persistence for the collaboration hub. Shares the Remote Pi metadata database so a single
 * backup covers agents, sessions, and collaboration state. All tables are additive; existing tables are untouched.
 */
export class CollabStore {
  /** Takes an accessor, not a handle: the shared database is only opened when the server starts. */
  constructor(private readonly connection:()=>Database.Database){}
  private get db(){return this.connection()}

  init(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_sessions (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, workspace_id TEXT NOT NULL,
        cwd TEXT NOT NULL, subject_json TEXT NOT NULL, phase TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1,
        policy_json TEXT NOT NULL, status TEXT NOT NULL, stalled_json TEXT, outcome_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_participants (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, display_name TEXT NOT NULL,
        model TEXT, binding_type TEXT NOT NULL, agent_id TEXT, token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, token_budget INTEGER NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
        tokens_estimated INTEGER NOT NULL DEFAULT 0, token_baseline INTEGER,
        created_at INTEGER NOT NULL, last_seen_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_events (
        session_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
        actor_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence),
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_baselines (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, round INTEGER NOT NULL, vcs TEXT NOT NULL,
        commit_sha TEXT, range_expr TEXT, dirty_hash TEXT, paths_json TEXT NOT NULL, captured_at INTEGER NOT NULL,
        UNIQUE(session_id, round),
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_issues (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, external_id TEXT, reporter_id TEXT NOT NULL,
        target_participant_id TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL,
        required_action TEXT NOT NULL, confidence REAL, location_json TEXT NOT NULL, evidence TEXT, impact TEXT,
        suggestion TEXT, baseline_id TEXT NOT NULL, status TEXT NOT NULL, round INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, merged_into TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_issue_messages (
        id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, round INTEGER NOT NULL, author_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES collab_issues(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_criteria (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, name TEXT NOT NULL,
        definition TEXT NOT NULL, anchors_json TEXT, weight REAL, source_json TEXT, round INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_votes (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, criterion_id TEXT NOT NULL, participant_id TEXT NOT NULL,
        round INTEGER NOT NULL, stance TEXT NOT NULL, weight REAL, amendment TEXT, rationale TEXT,
        created_at INTEGER NOT NULL, UNIQUE(criterion_id, participant_id, round),
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_scores (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, criterion_id TEXT NOT NULL, participant_id TEXT NOT NULL,
        round INTEGER NOT NULL, score REAL NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL,
        confidence REAL, change_reason TEXT, created_at INTEGER NOT NULL,
        UNIQUE(criterion_id, participant_id, round),
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_debates (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, criterion_id TEXT NOT NULL, round INTEGER NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_debate_arguments (
        id TEXT PRIMARY KEY, debate_id TEXT NOT NULL, participant_id TEXT NOT NULL, stance TEXT NOT NULL,
        argument TEXT NOT NULL, evidence_json TEXT, responding_to TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY(debate_id) REFERENCES collab_debates(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_escalations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, raised_by TEXT NOT NULL,
        summary TEXT NOT NULL, positions_json TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL,
        urgency TEXT NOT NULL, status TEXT NOT NULL, decision_json TEXT, resolved_by TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_inbox (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, participant_id TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_phase_completions (
        session_id TEXT NOT NULL, round INTEGER NOT NULL, phase TEXT NOT NULL, participant_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, round, phase, participant_id),
        FOREIGN KEY(session_id) REFERENCES collab_sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS collab_idempotency (
        key TEXT PRIMARY KEY, session_id TEXT NOT NULL, participant_id TEXT NOT NULL,
        response_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collab_sessions_recent ON collab_sessions(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS collab_participants_session ON collab_participants(session_id);
      CREATE INDEX IF NOT EXISTS collab_issues_session ON collab_issues(session_id, status);
      CREATE INDEX IF NOT EXISTS collab_issue_messages_issue ON collab_issue_messages(issue_id, created_at);
      CREATE INDEX IF NOT EXISTS collab_escalations_pending ON collab_escalations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS collab_inbox_pending ON collab_inbox(participant_id, acked_at, created_at);
      CREATE INDEX IF NOT EXISTS collab_scores_criterion ON collab_scores(session_id, criterion_id, round);
    `);
    // Additive migration: scoring sessions need a debate counter independent of the voting round.
    const columns=this.db.prepare('PRAGMA table_info(collab_sessions)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='debate_round'))this.db.exec('ALTER TABLE collab_sessions ADD COLUMN debate_round INTEGER NOT NULL DEFAULT 0');
    // Additive migration: a managed participant keeps its token in clear text so the hub can hand it to the agent it wakes.
    const participantColumns=this.db.prepare('PRAGMA table_info(collab_participants)').all() as {name:string}[];
    if(!participantColumns.some(column=>column.name==='dispatch_token'))this.db.exec('ALTER TABLE collab_participants ADD COLUMN dispatch_token TEXT');
    if(Number(this.db.pragma('user_version',{simple:true}))<3)this.db.pragma('user_version = 3');
  }

  transaction<T>(work:()=>T):T{return this.db.transaction(work)()}

  // ---- sessions ----
  createSession(input:CreateSessionInput):CollabSession{
    const sessionId=`collab-${randomUUID()}`,timestamp=now();
    const policy=mergePolicy(input.policy);
    const phase=input.kind==='review'?'draft':'nominating';
    this.db.prepare(`INSERT INTO collab_sessions(id,kind,title,workspace_id,cwd,subject_json,phase,round,policy_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,'active',?,?)`)
      .run(sessionId,input.kind,input.title,input.workspaceId,input.cwd,JSON.stringify(input.subject),phase,JSON.stringify(policy),timestamp,timestamp);
    return this.getSession(sessionId);
  }
  getSession(sessionId:string):CollabSession{
    const row=this.db.prepare('SELECT * FROM collab_sessions WHERE id=?').get(sessionId) as any;
    if(!row)throw notFound(COLLAB_ERRORS.sessionNotFound,'Collaboration session not found');
    return sessionFrom(row);
  }
  findSession(sessionId:string):CollabSession|undefined{const row=this.db.prepare('SELECT * FROM collab_sessions WHERE id=?').get(sessionId) as any;return row?sessionFrom(row):undefined}
  listSessions(filter:{status?:string,kind?:string,limit?:number,offset?:number}={}):CollabSession[]{
    const where:string[]=[],params:unknown[]=[];
    if(filter.status){where.push('status=?');params.push(filter.status)}
    if(filter.kind){where.push('kind=?');params.push(filter.kind)}
    const limit=Math.min(200,Math.max(1,Math.trunc(filter.limit??50))),offset=Math.max(0,Math.trunc(filter.offset??0));
    const sql=`SELECT * FROM collab_sessions ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params,limit,offset) as any[]).map(sessionFrom);
  }
  updateSession(sessionId:string,patch:Partial<Pick<CollabSession,'phase'|'round'|'debateRound'|'status'|'stalled'|'outcome'|'policy'|'title'>>):CollabSession{
    const current=this.getSession(sessionId);
    this.db.prepare('UPDATE collab_sessions SET phase=?,round=?,debate_round=?,status=?,stalled_json=?,outcome_json=?,policy_json=?,title=?,updated_at=? WHERE id=?').run(
      patch.phase??current.phase,patch.round??current.round,patch.debateRound??current.debateRound,patch.status??current.status,
      'stalled' in patch?(patch.stalled?JSON.stringify(patch.stalled):null):(current.stalled?JSON.stringify(current.stalled):null),
      'outcome' in patch?(patch.outcome?JSON.stringify(patch.outcome):null):(current.outcome?JSON.stringify(current.outcome):null),
      JSON.stringify(patch.policy??current.policy),patch.title??current.title,now(),sessionId);
    return this.getSession(sessionId);
  }

  // ---- participants ----
  /** Returns the plaintext token exactly once; only its sha256 is stored. */
  createParticipant(input:CreateParticipantInput):{participant:Participant,token:string}{
    const participantId=`p-${randomUUID()}`,token=`cpt_${randomUUID().replace(/-/g,'')}${randomUUID().replace(/-/g,'')}`,timestamp=now();
    const session=this.getSession(input.sessionId);
    this.db.prepare(`INSERT INTO collab_participants(id,session_id,role,display_name,model,binding_type,agent_id,token_hash,state,token_budget,tokens_used,tokens_estimated,created_at) VALUES(?,?,?,?,?,?,?,?,'active',?,0,0,?)`)
      .run(participantId,input.sessionId,input.role,input.displayName,input.model??null,input.bindingType,input.agentId??null,hashToken(token),input.tokenBudget??session.policy.tokenBudgetPerParticipant,timestamp);
    return {participant:this.getParticipant(participantId),token};
  }
  getParticipant(participantId:string):Participant{
    const row=this.db.prepare('SELECT * FROM collab_participants WHERE id=?').get(participantId) as any;
    if(!row)throw notFound(COLLAB_ERRORS.participantNotFound,'Participant not found');
    return participantFrom(row);
  }
  findParticipantByToken(token:string):Participant|undefined{
    const row=this.db.prepare('SELECT * FROM collab_participants WHERE token_hash=?').get(hashToken(token)) as any;
    return row?participantFrom(row):undefined;
  }
  listParticipants(sessionId:string):Participant[]{return (this.db.prepare('SELECT * FROM collab_participants WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as any[]).map(participantFrom)}
  updateParticipant(participantId:string,patch:Partial<Pick<Participant,'state'|'tokensUsed'|'tokenBudget'|'tokensEstimated'|'lastSeenAt'|'model'>>):Participant{
    const current=this.getParticipant(participantId);
    this.db.prepare('UPDATE collab_participants SET state=?,tokens_used=?,token_budget=?,tokens_estimated=?,last_seen_at=?,model=? WHERE id=?').run(
      patch.state??current.state,Math.max(0,Math.round(patch.tokensUsed??current.tokensUsed)),Math.max(0,Math.round(patch.tokenBudget??current.tokenBudget)),
      (patch.tokensEstimated??current.tokensEstimated)?1:0,patch.lastSeenAt?asTime(patch.lastSeenAt):(current.lastSeenAt?asTime(current.lastSeenAt):null),
      patch.model??current.model??null,participantId);
    return this.getParticipant(participantId);
  }
  /** Adds usage and flips the participant to `budget_exhausted` once the budget is spent. Returns the updated row. */
  addTokenUsage(participantId:string,tokens:number,estimated:boolean):Participant{
    const current=this.getParticipant(participantId),used=current.tokensUsed+Math.max(0,Math.round(tokens));
    return this.updateParticipant(participantId,{tokensUsed:used,tokensEstimated:current.tokensEstimated||estimated,state:current.state==='left'?'left':used>=current.tokenBudget?'budget_exhausted':'active'});
  }
  /**
   * Stores the plaintext token of a *managed* participant. The hub must be able to give the token to the agent
   * it wakes, and there is nobody to type it in. External participants keep hash-only storage.
   */
  setDispatchToken(participantId:string,token:string){this.db.prepare('UPDATE collab_participants SET dispatch_token=? WHERE id=?').run(token,participantId)}
  getDispatchToken(participantId:string):string|undefined{const row=this.db.prepare('SELECT dispatch_token FROM collab_participants WHERE id=?').get(participantId) as any;return row?.dispatch_token??undefined}
  clearDispatchToken(participantId:string){this.db.prepare('UPDATE collab_participants SET dispatch_token=NULL WHERE id=?').run(participantId)}
  getTokenBaseline(participantId:string):number|undefined{const row=this.db.prepare('SELECT token_baseline FROM collab_participants WHERE id=?').get(participantId) as any;return row?.token_baseline??undefined}
  setTokenBaseline(participantId:string,value:number){this.db.prepare('UPDATE collab_participants SET token_baseline=? WHERE id=?').run(Math.max(0,Math.round(value)),participantId)}

  // ---- events ----
  appendEvent(sessionId:string,type:string,payload:Record<string,unknown>={},actorId?:string):CollabEvent{
    const row=this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS last FROM collab_events WHERE session_id=?').get(sessionId) as any;
    const sequence=Number(row?.last??0)+1,eventId=`e-${randomUUID()}`,timestamp=now();
    this.db.prepare('INSERT INTO collab_events(session_id,sequence,id,type,actor_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(sessionId,sequence,eventId,type,actorId??null,JSON.stringify(payload),timestamp);
    return {sessionId,sequence,eventId,type,actorId,payload,createdAt:iso(timestamp)};
  }
  listEvents(sessionId:string,since=0,limit=500):CollabEvent[]{
    const rows=this.db.prepare('SELECT * FROM collab_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId,Math.max(0,Math.trunc(since)),Math.min(2000,Math.max(1,Math.trunc(limit)))) as any[];
    return rows.map(row=>({sessionId:row.session_id,sequence:row.sequence,eventId:row.id,type:row.type,actorId:row.actor_id??undefined,payload:json(row.payload_json,{}),createdAt:iso(row.created_at)}));
  }

  // ---- baselines ----
  saveBaseline(input:Omit<Baseline,'baselineId'|'capturedAt'>&{baselineId?:string}):Baseline{
    const baselineId=input.baselineId??`b-${randomUUID()}`,timestamp=now();
    this.db.prepare(`INSERT INTO collab_baselines(id,session_id,round,vcs,commit_sha,range_expr,dirty_hash,paths_json,captured_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,round) DO UPDATE SET vcs=excluded.vcs,commit_sha=excluded.commit_sha,range_expr=excluded.range_expr,dirty_hash=excluded.dirty_hash,paths_json=excluded.paths_json,captured_at=excluded.captured_at`)
      .run(baselineId,input.sessionId,input.round,input.vcs,input.commit??null,input.range??null,input.dirtyHash??null,JSON.stringify(input.paths??[]),timestamp);
    return this.getBaselineForRound(input.sessionId,input.round)!;
  }
  getBaseline(baselineId:string):Baseline|undefined{const row=this.db.prepare('SELECT * FROM collab_baselines WHERE id=?').get(baselineId) as any;return row?baselineFrom(row):undefined}
  getBaselineForRound(sessionId:string,round:number):Baseline|undefined{const row=this.db.prepare('SELECT * FROM collab_baselines WHERE session_id=? AND round=?').get(sessionId,round) as any;return row?baselineFrom(row):undefined}

  // ---- issues ----
  createIssue(input:CreateIssueInput):Issue{
    const issueId=`i-${randomUUID()}`,timestamp=now();
    this.db.prepare(`INSERT INTO collab_issues(id,session_id,external_id,reporter_id,target_participant_id,title,severity,category,required_action,confidence,location_json,evidence,impact,suggestion,baseline_id,status,round,version,merged_into,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`)
      .run(issueId,input.sessionId,input.externalId??null,input.reporterId,input.targetParticipantId,input.title,input.severity,input.category,input.requiredAction,input.confidence??null,
        JSON.stringify(input.location),input.evidence??null,input.impact??null,input.suggestion??null,input.baselineId,input.status??'open',input.round,timestamp,timestamp);
    return this.getIssue(issueId);
  }
  getIssue(issueId:string):Issue{
    const row=this.db.prepare('SELECT * FROM collab_issues WHERE id=?').get(issueId) as any;
    if(!row)throw notFound(COLLAB_ERRORS.issueNotFound,'Issue not found');
    return issueFrom(row);
  }
  /** Scoped lookup: an issue id from another session must read as "not found", never leak across sessions. */
  findIssueInSession(sessionId:string,issueId:string):Issue|undefined{
    const row=this.db.prepare('SELECT * FROM collab_issues WHERE id=? AND session_id=?').get(issueId,sessionId) as any;
    return row?issueFrom(row):undefined;
  }
  listIssues(sessionId:string,filter:{status?:IssueStatus[],reporterId?:string,targetParticipantId?:string,round?:number}={}):Issue[]{
    const where=['session_id=?'],params:unknown[]=[sessionId];
    if(filter.status?.length){where.push(`status IN (${filter.status.map(()=>'?').join(',')})`);params.push(...filter.status)}
    if(filter.reporterId){where.push('reporter_id=?');params.push(filter.reporterId)}
    if(filter.targetParticipantId){where.push('target_participant_id=?');params.push(filter.targetParticipantId)}
    if(filter.round!==undefined){where.push('round=?');params.push(filter.round)}
    return (this.db.prepare(`SELECT * FROM collab_issues WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`).all(...params) as any[]).map(issueFrom);
  }
  /** Optimistic locking: a stale `expectedVersion` means someone else already moved the issue. */
  updateIssue(issueId:string,patch:Partial<Pick<Issue,'status'|'round'|'mergedInto'|'severity'|'requiredAction'>>,expectedVersion?:number):Issue{
    const current=this.getIssue(issueId);
    if(expectedVersion!==undefined&&expectedVersion!==current.version)throw Object.assign(new Error(`Issue was modified concurrently (expected version ${expectedVersion}, current ${current.version})`),{code:COLLAB_ERRORS.conflict,currentVersion:current.version});
    this.db.prepare('UPDATE collab_issues SET status=?,round=?,merged_into=?,severity=?,required_action=?,version=version+1,updated_at=? WHERE id=?').run(
      patch.status??current.status,patch.round??current.round,'mergedInto' in patch?(patch.mergedInto??null):(current.mergedInto??null),
      patch.severity??current.severity,patch.requiredAction??current.requiredAction,now(),issueId);
    return this.getIssue(issueId);
  }
  addIssueMessage(issueId:string,round:number,authorId:string,kind:IssueMessageKind,payload:Record<string,unknown>):IssueMessage{
    const messageId=`im-${randomUUID()}`,timestamp=now();
    this.db.prepare('INSERT INTO collab_issue_messages(id,issue_id,round,author_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(messageId,issueId,round,authorId,kind,JSON.stringify(payload),timestamp);
    return {messageId,issueId,round,authorId,kind,payload,createdAt:iso(timestamp)};
  }
  listIssueMessages(issueId:string):IssueMessage[]{
    return (this.db.prepare('SELECT * FROM collab_issue_messages WHERE issue_id=? ORDER BY created_at, rowid').all(issueId) as any[])
      .map(row=>({messageId:row.id,issueId:row.issue_id,round:row.round,authorId:row.author_id,kind:row.kind as IssueMessageKind,payload:json(row.payload_json,{}),createdAt:iso(row.created_at)}));
  }

  // ---- escalations ----
  createEscalation(input:CreateEscalationInput):Escalation{
    const escalationId=`esc-${randomUUID()}`,timestamp=now();
    this.db.prepare(`INSERT INTO collab_escalations(id,session_id,kind,ref_id,raised_by,summary,positions_json,question,options_json,urgency,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run(escalationId,input.sessionId,input.kind,input.refId??null,input.raisedBy,input.summary,JSON.stringify(input.positions),input.question,JSON.stringify(input.options),input.urgency,timestamp);
    return this.getEscalation(escalationId);
  }
  getEscalation(escalationId:string):Escalation{
    const row=this.db.prepare('SELECT * FROM collab_escalations WHERE id=?').get(escalationId) as any;
    if(!row)throw notFound(COLLAB_ERRORS.escalationNotFound,'Escalation not found');
    return escalationFrom(row);
  }
  listEscalations(filter:{sessionId?:string,status?:EscalationStatus,limit?:number}={}):Escalation[]{
    const where:string[]=[],params:unknown[]=[];
    if(filter.sessionId){where.push('session_id=?');params.push(filter.sessionId)}
    if(filter.status){where.push('status=?');params.push(filter.status)}
    const limit=Math.min(200,Math.max(1,Math.trunc(filter.limit??100)));
    return (this.db.prepare(`SELECT * FROM collab_escalations ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params,limit) as any[]).map(escalationFrom);
  }
  findPendingEscalation(sessionId:string,kind:EscalationKind,refId?:string):Escalation|undefined{
    const row=this.db.prepare(`SELECT * FROM collab_escalations WHERE session_id=? AND kind=? AND status='pending' AND ${refId?'ref_id=?':'ref_id IS NULL'}`).get(...(refId?[sessionId,kind,refId]:[sessionId,kind])) as any;
    return row?escalationFrom(row):undefined;
  }
  resolveEscalation(escalationId:string,decision:Record<string,unknown>,resolvedBy:string,status:EscalationStatus='resolved'):Escalation{
    this.getEscalation(escalationId);
    this.db.prepare('UPDATE collab_escalations SET status=?,decision_json=?,resolved_by=?,resolved_at=? WHERE id=?').run(status,JSON.stringify(decision),resolvedBy,now(),escalationId);
    return this.getEscalation(escalationId);
  }

  // ---- inbox (external agents poll this; managed agents are woken directly) ----
  pushInbox(sessionId:string,participantId:string,type:string,payload:Record<string,unknown>):InboxItem{
    const itemId=`in-${randomUUID()}`,timestamp=now();
    this.db.prepare('INSERT INTO collab_inbox(id,session_id,participant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(itemId,sessionId,participantId,type,JSON.stringify(payload),timestamp);
    return {itemId,sessionId,participantId,type,payload,createdAt:iso(timestamp)};
  }
  listInbox(participantId:string,includeAcked=false,limit=50):InboxItem[]{
    const rows=this.db.prepare(`SELECT * FROM collab_inbox WHERE participant_id=?${includeAcked?'':' AND acked_at IS NULL'} ORDER BY created_at, rowid LIMIT ?`).all(participantId,Math.min(200,Math.max(1,limit))) as any[];
    return rows.map(row=>({itemId:row.id,sessionId:row.session_id,participantId:row.participant_id,type:row.type,payload:json(row.payload_json,{}),createdAt:iso(row.created_at),deliveredAt:row.delivered_at?iso(row.delivered_at):undefined,ackedAt:row.acked_at?iso(row.acked_at):undefined}));
  }
  markDelivered(itemIds:string[]){if(!itemIds.length)return;const timestamp=now(),update=this.db.prepare('UPDATE collab_inbox SET delivered_at=COALESCE(delivered_at,?) WHERE id=?');this.db.transaction(()=>{for(const id of itemIds)update.run(timestamp,id)})()}
  ackInbox(participantId:string,itemIds:string[]){if(!itemIds.length)return;const timestamp=now(),update=this.db.prepare('UPDATE collab_inbox SET acked_at=? WHERE id=? AND participant_id=?');this.db.transaction(()=>{for(const id of itemIds)update.run(timestamp,id,participantId)})()}

  // ---- scoring: criteria, votes, scores, debates ----
  createCriterion(input:{sessionId:string,name:string,definition:string,anchors?:Record<string,string>,weight?:number,source?:Record<string,unknown>,round:number,state?:CriterionState}):Criterion{
    const criterionId=`cr-${randomUUID()}`;
    this.db.prepare('INSERT INTO collab_criteria(id,session_id,state,name,definition,anchors_json,weight,source_json,round,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(criterionId,input.sessionId,input.state??'candidate',input.name,input.definition,input.anchors?JSON.stringify(input.anchors):null,input.weight??null,input.source?JSON.stringify(input.source):null,input.round,now());
    return this.getCriterion(criterionId);
  }
  getCriterion(criterionId:string):Criterion{
    const row=this.db.prepare('SELECT * FROM collab_criteria WHERE id=?').get(criterionId) as any;
    if(!row)throw notFound('COLLAB_CRITERION_NOT_FOUND','Criterion not found');
    return criterionFrom(row);
  }
  findCriterionInSession(sessionId:string,criterionId:string):Criterion|undefined{
    const row=this.db.prepare('SELECT * FROM collab_criteria WHERE id=? AND session_id=?').get(criterionId,sessionId) as any;
    return row?criterionFrom(row):undefined;
  }
  listCriteria(sessionId:string):Criterion[]{return (this.db.prepare('SELECT * FROM collab_criteria WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as any[]).map(criterionFrom)}
  updateCriterion(criterionId:string,patch:{state?:CriterionState,weight?:number,definition?:string,name?:string}){
    const current=this.getCriterion(criterionId);
    this.db.prepare('UPDATE collab_criteria SET state=?,weight=?,definition=?,name=? WHERE id=?')
      .run(patch.state??current.state,patch.weight??current.weight??null,patch.definition??current.definition,patch.name??current.name,criterionId);
    return this.getCriterion(criterionId);
  }
  saveVote(input:{sessionId:string,criterionId:string,participantId:string,round:number,stance:VoteStance,weight?:number,amendment?:string,rationale?:string}):Vote{
    this.db.prepare(`INSERT INTO collab_votes(id,session_id,criterion_id,participant_id,round,stance,weight,amendment,rationale,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(criterion_id,participant_id,round) DO UPDATE SET stance=excluded.stance,weight=excluded.weight,amendment=excluded.amendment,rationale=excluded.rationale,created_at=excluded.created_at`)
      .run(`v-${randomUUID()}`,input.sessionId,input.criterionId,input.participantId,input.round,input.stance,input.weight??null,input.amendment??null,input.rationale??null,now());
    return this.listVotes(input.sessionId).find(vote=>vote.criterionId===input.criterionId&&vote.participantId===input.participantId&&vote.round===input.round)!;
  }
  listVotes(sessionId:string):Vote[]{
    return (this.db.prepare('SELECT * FROM collab_votes WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as any[])
      .map(row=>({voteId:row.id,sessionId:row.session_id,criterionId:row.criterion_id,participantId:row.participant_id,round:row.round,stance:row.stance,weight:row.weight??undefined,amendment:row.amendment??undefined,rationale:row.rationale??undefined,createdAt:iso(row.created_at)}));
  }
  saveScore(input:{sessionId:string,criterionId:string,participantId:string,round:number,score:number,rationale:string,evidence:unknown[],confidence?:number,changeReason?:string}):Score{
    this.db.prepare(`INSERT INTO collab_scores(id,session_id,criterion_id,participant_id,round,score,rationale,evidence_json,confidence,change_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(criterion_id,participant_id,round) DO UPDATE SET score=excluded.score,rationale=excluded.rationale,evidence_json=excluded.evidence_json,confidence=excluded.confidence,change_reason=excluded.change_reason,created_at=excluded.created_at`)
      .run(`s-${randomUUID()}`,input.sessionId,input.criterionId,input.participantId,input.round,input.score,input.rationale,JSON.stringify(input.evidence),input.confidence??null,input.changeReason??null,now());
    return this.listScores(input.sessionId).find(score=>score.criterionId===input.criterionId&&score.participantId===input.participantId&&score.round===input.round)!;
  }
  listScores(sessionId:string):Score[]{
    return (this.db.prepare('SELECT * FROM collab_scores WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as any[])
      .map(row=>({scoreId:row.id,sessionId:row.session_id,criterionId:row.criterion_id,participantId:row.participant_id,round:row.round,score:row.score,rationale:row.rationale,evidence:json(row.evidence_json,[] as unknown[]),confidence:row.confidence??undefined,changeReason:row.change_reason??undefined,createdAt:iso(row.created_at)}));
  }
  createDebate(sessionId:string,criterionId:string,round:number):Debate{
    const debateId=`d-${randomUUID()}`;
    this.db.prepare(`INSERT INTO collab_debates(id,session_id,criterion_id,round,status,created_at) VALUES(?,?,?,?,'open',?)`).run(debateId,sessionId,criterionId,round,now());
    return this.listDebates(sessionId).find(debate=>debate.debateId===debateId)!;
  }
  listDebates(sessionId:string):Debate[]{
    const rows=this.db.prepare('SELECT * FROM collab_debates WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as any[];
    return rows.map(row=>({debateId:row.id,sessionId:row.session_id,criterionId:row.criterion_id,round:row.round,status:row.status,createdAt:iso(row.created_at),
      arguments:(this.db.prepare('SELECT * FROM collab_debate_arguments WHERE debate_id=? ORDER BY created_at, rowid').all(row.id) as any[])
        .map(entry=>({argumentId:entry.id,debateId:entry.debate_id,participantId:entry.participant_id,stance:entry.stance,argument:entry.argument,evidence:json(entry.evidence_json,[] as unknown[]),respondingTo:entry.responding_to??undefined,createdAt:iso(entry.created_at)}))}));
  }
  findDebateInSession(sessionId:string,debateId:string){return this.listDebates(sessionId).find(debate=>debate.debateId===debateId)}
  addDebateArgument(debateId:string,input:{participantId:string,stance:DebateStance,argument:string,evidence?:unknown[],respondingTo?:string}){
    const argumentId=`arg-${randomUUID()}`;
    this.db.prepare('INSERT INTO collab_debate_arguments(id,debate_id,participant_id,stance,argument,evidence_json,responding_to,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(argumentId,debateId,input.participantId,input.stance,input.argument,JSON.stringify(input.evidence??[]),input.respondingTo??null,now());
    return argumentId;
  }
  closeDebates(sessionId:string,round:number){this.db.prepare(`UPDATE collab_debates SET status='closed' WHERE session_id=? AND round=?`).run(sessionId,round)}

  // ---- phase completions ("I am done for this phase and round") ----
  markPhaseComplete(sessionId:string,round:number,phase:string,participantId:string){
    this.db.prepare('INSERT OR IGNORE INTO collab_phase_completions(session_id,round,phase,participant_id,created_at) VALUES(?,?,?,?,?)').run(sessionId,round,phase,participantId,now());
  }
  listCompletions(sessionId:string):{sessionId:string,round:number,phase:string,participantId:string}[]{
    return (this.db.prepare('SELECT * FROM collab_phase_completions WHERE session_id=?').all(sessionId) as any[])
      .map(row=>({sessionId:row.session_id,round:row.round,phase:row.phase,participantId:row.participant_id}));
  }

  // ---- idempotency ----
  getIdempotent<T>(key:string):T|undefined{const row=this.db.prepare('SELECT response_json FROM collab_idempotency WHERE key=?').get(key) as any;return row?json<T|undefined>(row.response_json,undefined):undefined}
  saveIdempotent(key:string,sessionId:string,participantId:string,response:unknown){this.db.prepare('INSERT OR REPLACE INTO collab_idempotency(key,session_id,participant_id,response_json,created_at) VALUES(?,?,?,?,?)').run(key,sessionId,participantId,JSON.stringify(response),now())}
  /** Idempotency records are a replay guard, not history: drop them once replays are implausible. */
  pruneIdempotency(maxAgeMs=7*24*3600*1000){this.db.prepare('DELETE FROM collab_idempotency WHERE created_at<?').run(now()-maxAgeMs)}
}

export function mergePolicy(patch?:Partial<CollabPolicy>):CollabPolicy{
  return {...DEFAULT_POLICY,...patch,scoring:{...DEFAULT_POLICY.scoring,...patch?.scoring,scale:{...DEFAULT_POLICY.scoring.scale,...patch?.scoring?.scale}}};
}

const sessionFrom=(row:any):CollabSession=>({
  sessionId:row.id,kind:row.kind,title:row.title,workspaceId:row.workspace_id,cwd:row.cwd,
  subject:json(row.subject_json,{type:'free',value:''} as CollabSubject),phase:row.phase,round:row.round,debateRound:row.debate_round??0,
  policy:mergePolicy(json(row.policy_json,{} as Partial<CollabPolicy>)),status:row.status,
  stalled:json(row.stalled_json,undefined as CollabSession['stalled']),outcome:json(row.outcome_json,undefined as Record<string,unknown>|undefined),
  createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)
});
const participantFrom=(row:any):Participant=>({
  participantId:row.id,sessionId:row.session_id,role:row.role,displayName:row.display_name,model:row.model??undefined,
  binding:{type:row.binding_type,agentId:row.agent_id??undefined},state:row.state,
  tokenBudget:row.token_budget,tokensUsed:row.tokens_used,tokensEstimated:!!row.tokens_estimated,
  createdAt:iso(row.created_at),lastSeenAt:row.last_seen_at?iso(row.last_seen_at):undefined
});
const baselineFrom=(row:any):Baseline=>({baselineId:row.id,sessionId:row.session_id,round:row.round,vcs:row.vcs,commit:row.commit_sha??undefined,range:row.range_expr??undefined,dirtyHash:row.dirty_hash??undefined,paths:json(row.paths_json,[] as string[]),capturedAt:iso(row.captured_at)});
const issueFrom=(row:any):Issue=>({
  issueId:row.id,sessionId:row.session_id,externalId:row.external_id??undefined,reporterId:row.reporter_id,targetParticipantId:row.target_participant_id,
  title:row.title,severity:row.severity,category:row.category,requiredAction:row.required_action,confidence:row.confidence??undefined,
  location:json(row.location_json,{path:''}),evidence:row.evidence??undefined,impact:row.impact??undefined,suggestion:row.suggestion??undefined,
  baselineId:row.baseline_id,status:row.status,round:row.round,version:row.version,mergedInto:row.merged_into??undefined,
  createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)
});
const criterionFrom=(row:any):Criterion=>({criterionId:row.id,sessionId:row.session_id,state:row.state,name:row.name,definition:row.definition,
  anchors:json(row.anchors_json,undefined as Record<string,string>|undefined),weight:row.weight??undefined,source:json(row.source_json,undefined as Record<string,unknown>|undefined),
  round:row.round,createdAt:iso(row.created_at)});
const escalationFrom=(row:any):Escalation=>({
  escalationId:row.id,sessionId:row.session_id,kind:row.kind,refId:row.ref_id??undefined,raisedBy:row.raised_by,summary:row.summary,
  positions:json(row.positions_json,[] as Escalation['positions']),question:row.question,options:json(row.options_json,[] as string[]),
  urgency:row.urgency,status:row.status,decision:json(row.decision_json,undefined as Record<string,unknown>|undefined),resolvedBy:row.resolved_by??undefined,
  createdAt:iso(row.created_at),resolvedAt:row.resolved_at?iso(row.resolved_at):undefined
});
