import Database from 'better-sqlite3';
import {chmodSync,mkdirSync,statSync} from 'node:fs';
import path from 'node:path';
import type {AgentRecord} from './agents.js';
import type {Workspace} from './workspaces.js';

type SessionListItem={path:string,id:string,cwd:string,name?:string,parentSessionPath?:string,created:Date,modified:Date,messageCount:number,firstMessage:string,allMessagesText:string};
type SessionSummary={sessionId?:unknown,sessionFile?:unknown,sessionName?:unknown,stats?:{totalMessages?:unknown}};
const asTime=(value:string|Date|number|undefined)=>{const time=value instanceof Date?value.getTime():typeof value==='number'?value:Date.parse(value??'');return Number.isFinite(time)?time:Date.now()};

/** SQLite-backed Remote Pi metadata. Pi conversation JSONL files remain the source of truth. */
export class MetadataStore {
  private db?:Database.Database;
  private pendingAgents=new Map<string,AgentRecord>();
  private archivedAgents=new Set<string>();
  private flushTimer?:ReturnType<typeof setTimeout>;
  constructor(private readonly dataDir:string){}
  get file(){return path.join(this.dataDir,'remote-pi.db')}
  init(){
    if(this.db)return;
    mkdirSync(this.dataDir,{recursive:true});try{chmodSync(this.dataDir,0o700)}catch{}
    const db=this.db=new Database(this.file);try{chmodSync(this.file,0o600)}catch{}
    db.pragma('journal_mode = WAL');db.pragma('synchronous = NORMAL');db.pragma('busy_timeout = 5000');db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_file TEXT,
        session_name TEXT,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        archived_at INTEGER,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL UNIQUE,
        workspace_id TEXT,
        cwd TEXT NOT NULL,
        name TEXT,
        parent_session_path TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_message TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS agents_active_recent ON agents(last_active_at DESC,id DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS agents_workspace_active_recent ON agents(workspace_id,last_active_at DESC,id DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS sessions_active_recent ON sessions(last_active_at DESC,session_id DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS sessions_workspace_active_recent ON sessions(workspace_id,last_active_at DESC,session_id DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS sessions_cwd_active_recent ON sessions(cwd,last_active_at DESC,session_id DESC) WHERE archived_at IS NULL;
    `);
    db.pragma('user_version = 1');
    this.archivedAgents=new Set((db.prepare('SELECT id FROM agents WHERE archived_at IS NOT NULL').all() as {id:string}[]).map(row=>row.id));
  }
  private get database(){if(!this.db)throw new Error('Metadata store is not initialized');return this.db}
  listWorkspaces():Workspace[]{return (this.database.prepare('SELECT id,label,root_path,created_at FROM workspaces ORDER BY created_at,id').all() as any[]).map(row=>({id:row.id,label:row.label,rootPath:row.root_path,createdAt:new Date(row.created_at).toISOString()}))}
  saveWorkspace(workspace:Workspace){this.database.prepare(`INSERT INTO workspaces(id,label,root_path,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,root_path=excluded.root_path`).run(workspace.id,workspace.label,workspace.rootPath,asTime(workspace.createdAt))}
  listAgents():AgentRecord[]{return (this.database.prepare('SELECT * FROM agents WHERE archived_at IS NULL ORDER BY last_active_at DESC,id DESC').all() as any[]).map(row=>({agentId:row.id,workspaceId:row.workspace_id,sessionId:row.session_id,sessionFile:row.session_file??undefined,sessionName:row.session_name??undefined,cwd:row.cwd,status:row.status,createdAt:new Date(row.created_at).toISOString(),lastActiveAt:new Date(row.last_active_at).toISOString()}))}
  private writeAgent(record:AgentRecord,archivedAt:number|null){this.database.prepare(`INSERT INTO agents(id,workspace_id,session_id,session_file,session_name,cwd,status,created_at,last_active_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,session_id=excluded.session_id,session_file=excluded.session_file,session_name=excluded.session_name,cwd=excluded.cwd,status=excluded.status,last_active_at=excluded.last_active_at,archived_at=excluded.archived_at`).run(record.agentId,record.workspaceId,record.sessionId,record.sessionFile??null,record.sessionName??null,record.cwd,record.status,asTime(record.createdAt),asTime(record.lastActiveAt),archivedAt)}
  saveAgent(record:AgentRecord){if(this.archivedAgents.has(record.agentId))return;this.pendingAgents.delete(record.agentId);this.writeAgent(record,null)}
  scheduleAgent(record:AgentRecord){if(this.archivedAgents.has(record.agentId))return;this.pendingAgents.set(record.agentId,{...record});if(!this.flushTimer)this.flushTimer=setTimeout(()=>this.flush(),1000)}
  archiveAgent(record:AgentRecord){this.archivedAgents.add(record.agentId);this.pendingAgents.delete(record.agentId);this.writeAgent(record,Date.now())}
  flush(){if(this.flushTimer){clearTimeout(this.flushTimer);this.flushTimer=undefined}if(!this.pendingAgents.size)return;const records=[...this.pendingAgents.values()];this.pendingAgents.clear();this.database.transaction((items:AgentRecord[])=>{for(const item of items)this.writeAgent(item,null)})(records)}
  syncSessions(workspaceId:string,cwd:string,sessions:SessionListItem[]){
    const db=this.database,upsert=db.prepare(`INSERT INTO sessions(session_id,session_file,workspace_id,cwd,name,parent_session_path,created_at,last_active_at,message_count,first_message,file_size,file_mtime,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET session_file=excluded.session_file,workspace_id=excluded.workspace_id,cwd=excluded.cwd,name=excluded.name,parent_session_path=excluded.parent_session_path,last_active_at=excluded.last_active_at,message_count=excluded.message_count,first_message=excluded.first_message,file_size=excluded.file_size,file_mtime=excluded.file_mtime,archived_at=NULL`);
    const remove=db.prepare('DELETE FROM sessions WHERE session_file=?');db.transaction(()=>{const paths=new Set<string>();for(const session of sessions){paths.add(session.path);let size=0,mtime=asTime(session.modified);try{const stat=statSync(session.path);size=stat.size;mtime=stat.mtimeMs}catch{}upsert.run(session.id,session.path,workspaceId,cwd,session.name??null,session.parentSessionPath??null,asTime(session.created),asTime(session.modified),session.messageCount,session.firstMessage,size,mtime)}for(const row of db.prepare('SELECT session_file FROM sessions WHERE cwd=? AND archived_at IS NULL').all(cwd) as any[])if(!paths.has(row.session_file))remove.run(row.session_file)})();
  }
  upsertSessionFromAgent(record:AgentRecord,summary:SessionSummary){const sessionFile=typeof summary.sessionFile==='string'?summary.sessionFile:record.sessionFile;if(!sessionFile)return;let size=0,mtime=asTime(record.lastActiveAt);try{const stat=statSync(sessionFile);size=stat.size;mtime=stat.mtimeMs}catch{return}const sessionId=typeof summary.sessionId==='string'?summary.sessionId:record.sessionId,name=typeof summary.sessionName==='string'?summary.sessionName:record.sessionName,messageCount=Number(summary.stats?.totalMessages)||0;this.database.prepare(`INSERT INTO sessions(session_id,session_file,workspace_id,cwd,name,created_at,last_active_at,message_count,first_message,file_size,file_mtime,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET session_file=excluded.session_file,workspace_id=excluded.workspace_id,cwd=excluded.cwd,name=excluded.name,last_active_at=excluded.last_active_at,message_count=excluded.message_count,file_size=excluded.file_size,file_mtime=excluded.file_mtime,archived_at=NULL`).run(sessionId,sessionFile,record.workspaceId,record.cwd,name??null,asTime(record.createdAt),Math.max(asTime(record.lastActiveAt),mtime),messageCount,'',size,mtime)}
  listSessions(cwd:string,limit?:number,offset=0){const bounded=limit===undefined?undefined:Math.min(200,Math.max(1,Math.trunc(limit)));const sql=`SELECT session_file AS path,session_id AS id,cwd,name,parent_session_path AS parentSessionPath,created_at,last_active_at,message_count AS messageCount,first_message AS firstMessage FROM sessions WHERE cwd=? AND archived_at IS NULL ORDER BY last_active_at DESC,session_id DESC${bounded===undefined?'':' LIMIT ? OFFSET ?'}`;const rows=(bounded===undefined?this.database.prepare(sql).all(cwd):this.database.prepare(sql).all(cwd,bounded,Math.max(0,Math.trunc(offset)))) as any[];return rows.map(row=>({...row,created:new Date(row.created_at).toISOString(),modified:new Date(row.last_active_at).toISOString(),allMessagesText:''}))}
  hasSession(cwd:string,sessionFile:string){return !!this.database.prepare('SELECT 1 FROM sessions WHERE cwd=? AND session_file=? AND archived_at IS NULL').get(cwd,sessionFile)}
  close(){if(!this.db)return;this.flush();this.db.pragma('wal_checkpoint(TRUNCATE)');this.db.close();this.db=undefined}
}
