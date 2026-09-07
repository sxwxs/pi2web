import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { relative as pathRelative } from 'node:path';
import type { WorkspaceStore } from './workspaces.js';
import { createSdkBackend } from './sdk-backend.js';
export type AgentState={status:'unloaded'|'starting'|'idle'|'streaming'|'waiting_for_user'|'error'|'stopping'|'stopped',agentId:string,sessionId:string,sessionFile?:string,sessionName?:string,cwd:string};
export type AgentEvent={type:string,[key:string]:unknown};
export type AgentActivity={bashIds:string[],dialogIds:string[],dialogRequests:AgentEvent[]};
export type AgentSnapshotState=AgentState&{activity:AgentActivity};
export type SlashCommandSummary={name:string,description?:string,argumentHint?:string,source:'prompt'|'skill'};
export type BashRunResult={id:string,output:string,exitCode:number|undefined,cancelled:boolean,truncated:boolean};
export interface AgentBackend {prompt(message:string):Promise<void>;steer(message:string):Promise<void>;followUp(message:string):Promise<void>;abort():Promise<void>;getState():Promise<AgentState>;getMessages():Promise<unknown[]>;getCapabilities():Promise<Record<string,unknown>>;getSession():Promise<Record<string,unknown>>;getSessionInfo():Promise<Record<string,unknown>>;compact(instructions?:string):Promise<unknown>;setModel(provider:string,modelId:string):Promise<void>;setThinkingLevel(level:string):Promise<void>;setSessionName(name:string):Promise<void>;navigate(entryId:string):Promise<unknown>;fork(entryId:string):Promise<{sessionFile?:string,selectedText?:string}>;extensionResponse(requestId:string,value:unknown):Promise<void>;listCommands():Promise<SlashCommandSummary[]>;runBash(command:string,excludeFromContext?:boolean):Promise<BashRunResult>;abortBash():void;subscribe(listener:(e:AgentEvent)=>void):()=>void;dispose():Promise<void>}
/** Deterministic backend used by the server and tests. The SDK adapter can implement the same contract. */
export class MockBackend implements AgentBackend {
 private emitter=new EventEmitter(); private state:AgentState; private messages:unknown[]=[]; private timer?:ReturnType<typeof setTimeout>;
 constructor(agentId:string,cwd:string,sessionId:string=randomUUID()){this.state={agentId,sessionId,cwd,status:'idle'}}
 private emit(e:AgentEvent){this.emitter.emit('event',e)}
 async prompt(message:string){if(this.state.status==='streaming')throw Object.assign(new Error('Agent is busy'),{code:'AGENT_BUSY'});this.state.status='streaming';this.emit({type:'agent_start',message});await new Promise<void>(r=>{this.timer=setTimeout(r,0)});this.messages.push({role:'user',content:message});this.emit({type:'message_start',role:'assistant'});this.emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:`Mock response: ${message}`}});this.emit({type:'message_end',message:`Mock response: ${message}`});this.state.status='idle';this.emit({type:'agent_end'});}
 async steer(message:string){this.emit({type:'steer',message})} async followUp(message:string){this.emit({type:'follow_up',message})}
 async abort(){if(this.state.status==='streaming'){if(this.timer)clearTimeout(this.timer);this.state.status='idle';this.emit({type:'agent_end',aborted:true})}}
 async getState(){return {...this.state}} async getMessages(){return [...this.messages]}
 async getCapabilities(){return {model:null,models:[],thinkingLevel:'off',thinkingLevels:['off'],supportsThinking:false}}
 async getSession(){return {...await this.getSessionInfo(),entries:[],tree:[]}}
 async getSessionInfo(){return {sessionId:this.state.sessionId,sessionName:this.state.sessionName,stats:{totalMessages:this.messages.length,tokens:{total:0},cost:0},contextUsage:{tokens:null,contextWindow:0,percent:null}}}
 async compact(){return {summary:'mock'}} async setModel(_provider:string,_modelId:string){} async setThinkingLevel(_level:string){} async setSessionName(name:string){this.state.sessionName=name;this.emit({type:'session_info_changed',name})} async navigate(_entryId:string){return {cancelled:false}} async fork(_entryId:string):Promise<{sessionFile?:string,selectedText?:string}>{return {}} async extensionResponse(_requestId:string,_value:unknown){}
 async listCommands(){return [{name:'mock',description:'Mock prompt template',source:'prompt' as const}]}
 async runBash(command:string,excludeFromContext=false){const id=randomUUID(),output=`Mock bash: ${command}`;this.emit({type:'bash_execution_start',id,command});this.emit({type:'bash_execution_update',id,delta:`${output}\n`});const result={id,output,exitCode:0,cancelled:false,truncated:false};this.messages.push({role:'bashExecution',command,output,exitCode:0,cancelled:false,truncated:false,timestamp:Date.now(),excludeFromContext});this.emit({type:'bash_execution_end',command,...result});return result}
 abortBash(){}
 subscribe(listener:(e:AgentEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
 async dispose(){await this.abort();this.state.status='stopped';this.emitter.removeAllListeners()}
}
export type AgentProfile='default'|'collab';
export type AgentRecord=AgentState&{workspaceId:string,profile:AgentProfile,createdAt:string,lastActiveAt:string};
type StoredEvent={id:string,sequence:number,timestamp:number,event:AgentEvent};
type AgentEntry={record:AgentRecord,backend?:AgentBackend,loading?:Promise<AgentBackend>,events:StoredEvent[],nextSequence:number,bashIds:Set<string>,dialogRequests:Map<string,AgentEvent>};
export class AgentManager {
 private agents=new Map<string,AgentEntry>(); private listeners=new Map<string,Set<(e:StoredEvent)=>void>>(); private globalListeners=new Set<(agentId:string,e:StoredEvent)=>void>();
 constructor(private workspaces:WorkspaceStore,private factory:(id:string,cwd:string,sessionFile?:string,profile?:AgentProfile)=>AgentBackend|Promise<AgentBackend>=createSdkBackend){}
 private async resolveCwd(workspaceId:string,relativeCwd='.'){const ws=this.workspaces.get(workspaceId);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});const cwd=await this.workspaces.resolve(ws,relativeCwd);if(!(await import('node:fs/promises')).stat(cwd).then(s=>s.isDirectory()))throw new Error('cwd is not a directory');return cwd}
 async create(workspaceId:string,relativeCwd='.',sessionFile?:string,profile:AgentProfile='default') {const cwd=await this.resolveCwd(workspaceId,relativeCwd);const id=`agent-${randomUUID()}`,backend=await this.factory(id,cwd,sessionFile,profile),now=new Date().toISOString();const record={...(await backend.getState()),workspaceId,profile,createdAt:now,lastActiveAt:now};this.attach(id,record,backend);return {...record}}
 /** Build a disposable session so the UI sees the models actually available for this project and its extensions. */
 async capabilityPreview(workspaceId:string,relativeCwd='.') {const cwd=await this.resolveCwd(workspaceId,relativeCwd),backend=await this.factory(`preview-${randomUUID()}`,cwd);try{return await backend.getCapabilities()}finally{await backend.dispose()}}
 private connect(entry:AgentEntry,backend:AgentBackend){
  entry.backend=backend;
  backend.subscribe(event=>{
   if(entry.backend!==backend)return;
   const record=entry.record,type=event.type;
   if(type==='agent_start'||type==='auto_retry_start')record.status='streaming';
   else if(type==='agent_end')record.status=event.willRetry===true?'streaming':'idle';
   else if(type==='agent_settled')record.status='idle';
   // Standalone shell runs and dialogs outlive LLM turns. Track them with the
   // event cursor; keep dialog payloads so reconnecting clients can rebuild controls.
   if(typeof event.id==='string'){
    if(type==='bash_execution_start'||type==='bash_execution_update')entry.bashIds.add(event.id);
    else if(type==='bash_execution_end')entry.bashIds.delete(event.id);
   }
   if(typeof event.requestId==='string'){
    if(type==='extension_ui_request')entry.dialogRequests.set(event.requestId,event);
    else if(type==='extension_ui_response')entry.dialogRequests.delete(event.requestId);
   }
   if(type==='session_info_changed')record.sessionName=typeof event.name==='string'&&event.name.trim()?event.name.trim():undefined;
   record.lastActiveAt=new Date().toISOString();
   const item={id:randomUUID(),sequence:entry.nextSequence++,timestamp:Math.floor(Date.now()/1000),event};
   entry.events.push(item);if(entry.events.length>1000)entry.events.shift();
   for(const listener of this.listeners.get(record.agentId)??[])listener(item);
   for(const listener of this.globalListeners)listener(record.agentId,item);
  });
 }
 private attach(id:string,record:AgentRecord,backend:AgentBackend){const entry:AgentEntry={record,backend,events:[],nextSequence:1,bashIds:new Set(),dialogRequests:new Map()};this.connect(entry,backend);this.agents.set(id,entry)}
 async restore(records:AgentRecord[]){for(const saved of records){try{const ws=this.workspaces.get(saved.workspaceId);if(!ws)continue;const cwd=await this.workspaces.resolve(ws,pathRelative(ws.rootPath,saved.cwd));const sessionModified=saved.sessionFile?await import('node:fs/promises').then(fs=>fs.stat(saved.sessionFile!).then(value=>value.mtime.toISOString()).catch(()=>undefined)):undefined;const record={...saved,profile:saved.profile??'default',cwd,status:'unloaded' as const,lastActiveAt:sessionModified&&sessionModified>saved.lastActiveAt?sessionModified:saved.lastActiveAt};this.agents.set(saved.agentId,{record,events:[],nextSequence:1,bashIds:new Set(),dialogRequests:new Map()})}catch{/* Keep server startup resilient to deleted workspaces. */}}}
 get(id:string){const x=this.agents.get(id);if(!x)throw Object.assign(new Error('Agent not found'),{code:'AGENT_NOT_FOUND'});return x}
 list(){return [...this.agents.values()].map(x=>({...x.record}))}
 isLoaded(id:string){return !!this.get(id).backend}
 private async ensureLoaded(id:string){const entry=this.get(id);if(entry.backend)return entry.backend;if(entry.record.status==='stopped')throw Object.assign(new Error('Agent is not running'),{code:'AGENT_NOT_RUNNING'});if(entry.loading)return entry.loading;entry.record.status='starting';entry.loading=(async()=>{try{const backend=await this.factory(id,entry.record.cwd,entry.record.sessionFile,entry.record.profile);const state=await backend.getState();entry.record={...entry.record,...state,sessionName:state.sessionName?.trim()||entry.record.sessionName,status:state.status==='stopped'?'idle':state.status};this.connect(entry,backend);return backend}catch(error){entry.record.status='error';throw error}finally{entry.loading=undefined}})();return entry.loading}
 async command(id:string,kind:'prompt'|'steer'|'follow-up'|'abort',message=''){const entry=this.get(id);if(kind==='abort'&&!entry.backend)return;if(entry.record.status==='stopped')throw Object.assign(new Error('Agent is not running'),{code:'AGENT_NOT_RUNNING'});const backend=await this.ensureLoaded(id);if(kind==='abort')return backend.abort();return backend[kind==='follow-up'?'followUp':kind](message)}
 events(id:string,last=0){return this.get(id).events.filter(e=>e.sequence>last)}
 currentSequence(id:string){return this.get(id).nextSequence-1}
 snapshotState(id:string):AgentSnapshotState{
  const a=this.get(id);
  return {...a.record,activity:{bashIds:[...a.bashIds],dialogIds:[...a.dialogRequests.keys()],dialogRequests:[...a.dialogRequests.values()]}};
 }
 async snapshot(id:string,messageLimit?:number){
  // Capture state and its cursor before yielding. Events emitted while messages
  // are being read must be delivered after, not swallowed by, this snapshot.
  const a=this.get(id),state=this.snapshotState(id),lastSequence=a.nextSequence-1;
  const messages=a.backend?await a.backend.getMessages():[];
  if(messageLimit===undefined)return {state,messages,lastSequence};
  const page=this.paginateMessages(messages,messageLimit);
  return {state,messages:page.items,messagePage:page,lastSequence};
 }
 hasReplayGap(id:string,last:number){const a=this.get(id);const current=a.nextSequence-1;return last>current||(last>0&&a.events.length>0&&last<a.events[0].sequence-1)}
 subscribe(id:string,listener:(e:StoredEvent)=>void){this.get(id);if(!this.listeners.has(id))this.listeners.set(id,new Set());this.listeners.get(id)!.add(listener);return()=>this.listeners.get(id)?.delete(listener)}
 subscribeAll(listener:(agentId:string,e:StoredEvent)=>void){this.globalListeners.add(listener);return()=>this.globalListeners.delete(listener)}
 async dispose(id:string){
  const a=this.get(id);if(a.loading)await a.loading.catch(()=>{});
  await a.backend?.dispose();a.backend=undefined;a.record.status='unloaded';
  a.bashIds.clear();a.dialogRequests.clear();
 }
 async remove(id:string){await this.dispose(id);this.agents.delete(id);this.listeners.delete(id)}
 async archive(id:string){const current=this.get(id).record;if(['starting','streaming','waiting_for_user','stopping'].includes(current.status))throw Object.assign(new Error('Active Agent cannot be archived'),{code:'AGENT_ACTIVE'});const record={...current,status:'unloaded' as const};await this.remove(id);return record}
 async state(id:string){const state=await (await this.ensureLoaded(id)).getState();return {...state,sessionName:state.sessionName?.trim()||this.get(id).record.sessionName}} async messages(id:string){return (await this.ensureLoaded(id)).getMessages()}
 async messagePage(id:string,limit=25,before?:number){return this.paginateMessages(await (await this.ensureLoaded(id)).getMessages(),limit,before)}
 private paginateMessages(messages:unknown[],limit:number,before?:number){const safeLimit=Math.min(200,Math.max(1,Math.trunc(Number(limit)||25))),total=messages.length,end=Math.min(total,Math.max(0,before===undefined?total:Math.trunc(Number(before)||0))),start=Math.max(0,end-safeLimit);return {items:messages.slice(start,end),total,start,end,limit:safeLimit,hasMore:start>0}}
 async capabilities(id:string){return (await this.ensureLoaded(id)).getCapabilities()} async session(id:string){const info=await (await this.ensureLoaded(id)).getSession(),name=typeof info.sessionName==='string'&&info.sessionName.trim()?info.sessionName:this.get(id).record.sessionName;return {...info,sessionName:name}} async sessionInfo(id:string){const info=await (await this.ensureLoaded(id)).getSessionInfo(),name=typeof info.sessionName==='string'&&info.sessionName.trim()?info.sessionName:this.get(id).record.sessionName;return {...info,sessionName:name}}
 async compact(id:string,instructions?:string){return (await this.ensureLoaded(id)).compact(instructions)} async setModel(id:string,provider:string,modelId:string){return (await this.ensureLoaded(id)).setModel(provider,modelId)}
 async setThinkingLevel(id:string,level:string){return (await this.ensureLoaded(id)).setThinkingLevel(level)} async setSessionName(id:string,name:string){await (await this.ensureLoaded(id)).setSessionName(name);this.get(id).record.sessionName=name.trim()} async navigate(id:string,entryId:string){return (await this.ensureLoaded(id)).navigate(entryId)}
 async fork(id:string,entryId:string){const source=this.get(id),result=await (await this.ensureLoaded(id)).fork(entryId);if(!result.sessionFile)throw Object.assign(new Error('Session persistence is disabled'),{code:'SESSION_NOT_PERSISTED'});const ws=this.workspaces.get(source.record.workspaceId)!;const agent=await this.create(source.record.workspaceId,pathRelative(ws.rootPath,source.record.cwd),result.sessionFile,source.record.profile);return {agent,selectedText:result.selectedText}}
 async extensionResponse(id:string,requestId:string,value:unknown){return (await this.ensureLoaded(id)).extensionResponse(requestId,value)}
 async listCommands(id:string){return (await this.ensureLoaded(id)).listCommands()}
 /** Session-scoped bash. Output is streamed as `bash_execution_update` events and recorded in the Session. */
 async runBash(id:string,command:string,excludeFromContext=false){return (await this.ensureLoaded(id)).runBash(command,excludeFromContext)}
 async abortBash(id:string){const entry=this.get(id);if(entry.loading)await entry.loading;entry.backend?.abortBash()}
}
