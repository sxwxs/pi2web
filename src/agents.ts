import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { relative as pathRelative } from 'node:path';
import type { WorkspaceStore } from './workspaces.js';
import { createSdkBackend } from './sdk-backend.js';
export type AgentState={status:'unloaded'|'starting'|'idle'|'streaming'|'waiting_for_user'|'error'|'stopping'|'stopped',agentId:string,sessionId:string,sessionFile?:string,sessionName?:string,cwd:string};
export type AgentEvent={type:string,[key:string]:unknown};
export interface AgentBackend {prompt(message:string):Promise<void>;steer(message:string):Promise<void>;followUp(message:string):Promise<void>;abort():Promise<void>;getState():Promise<AgentState>;getMessages():Promise<unknown[]>;getCapabilities():Promise<Record<string,unknown>>;getSession():Promise<Record<string,unknown>>;compact(instructions?:string):Promise<unknown>;setModel(provider:string,modelId:string):Promise<void>;setThinkingLevel(level:string):Promise<void>;setSessionName(name:string):Promise<void>;navigate(entryId:string):Promise<unknown>;fork(entryId:string):Promise<{sessionFile?:string,selectedText?:string}>;extensionResponse(requestId:string,value:unknown):Promise<void>;subscribe(listener:(e:AgentEvent)=>void):()=>void;dispose():Promise<void>}
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
 async getSession(){return {sessionId:this.state.sessionId,sessionName:this.state.sessionName,entries:[],tree:[],stats:{totalMessages:this.messages.length,tokens:{total:0},cost:0},contextUsage:{tokens:null,contextWindow:0,percent:null}}}
 async compact(){return {summary:'mock'}} async setModel(_provider:string,_modelId:string){} async setThinkingLevel(_level:string){} async setSessionName(name:string){this.state.sessionName=name;this.emit({type:'session_info_changed',name})} async navigate(_entryId:string){return {cancelled:false}} async fork(_entryId:string):Promise<{sessionFile?:string,selectedText?:string}>{return {}} async extensionResponse(_requestId:string,_value:unknown){}
 subscribe(listener:(e:AgentEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
 async dispose(){await this.abort();this.state.status='stopped';this.emitter.removeAllListeners()}
}
export type AgentRecord=AgentState&{workspaceId:string,createdAt:string,lastActiveAt:string};
type StoredEvent={id:string,sequence:number,timestamp:number,event:AgentEvent};
type AgentEntry={record:AgentRecord,backend?:AgentBackend,loading?:Promise<AgentBackend>,events:StoredEvent[],nextSequence:number};
export class AgentManager {
 private agents=new Map<string,AgentEntry>(); private listeners=new Map<string,Set<(e:StoredEvent)=>void>>(); private globalListeners=new Set<(agentId:string,e:StoredEvent)=>void>();
 constructor(private workspaces:WorkspaceStore,private factory:(id:string,cwd:string,sessionFile?:string)=>AgentBackend|Promise<AgentBackend>=createSdkBackend){}
 async create(workspaceId:string,relativeCwd='.',sessionFile?:string) {const ws=this.workspaces.get(workspaceId);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});const cwd=await this.workspaces.resolve(ws,relativeCwd);if(!(await import('node:fs/promises')).stat(cwd).then(s=>s.isDirectory()))throw new Error('cwd is not a directory');const id=`agent-${randomUUID()}`,backend=await this.factory(id,cwd,sessionFile),now=new Date().toISOString();const record={...(await backend.getState()),workspaceId,createdAt:now,lastActiveAt:now};this.attach(id,record,backend);return {...record}}
 private connect(entry:AgentEntry,backend:AgentBackend){entry.backend=backend;backend.subscribe(event=>{const record=entry.record;record.status=event.type==='agent_start'||event.type==='auto_retry_start'||(event.type==='agent_end'&&event.willRetry===true)?'streaming':event.type==='agent_end'||event.type==='agent_settled'?'idle':record.status;if(event.type==='session_info_changed')record.sessionName=typeof event.name==='string'&&event.name.trim()?event.name.trim():undefined;record.lastActiveAt=new Date().toISOString();const item={id:randomUUID(),sequence:entry.nextSequence++,timestamp:Math.floor(Date.now()/1000),event};entry.events.push(item);if(entry.events.length>1000)entry.events.shift();for(const listener of this.listeners.get(record.agentId)??[])listener(item);for(const listener of this.globalListeners)listener(record.agentId,item)})}
 private attach(id:string,record:AgentRecord,backend:AgentBackend){const entry:AgentEntry={record,backend,events:[],nextSequence:1};this.connect(entry,backend);this.agents.set(id,entry)}
 async restore(records:AgentRecord[]){for(const saved of records){try{const ws=this.workspaces.get(saved.workspaceId);if(!ws)continue;const cwd=await this.workspaces.resolve(ws,pathRelative(ws.rootPath,saved.cwd));const record={...saved,cwd,status:'unloaded' as const};this.agents.set(saved.agentId,{record,events:[],nextSequence:1})}catch{/* Keep server startup resilient to deleted workspaces. */}}}
 get(id:string){const x=this.agents.get(id);if(!x)throw Object.assign(new Error('Agent not found'),{code:'AGENT_NOT_FOUND'});return x}
 list(){return [...this.agents.values()].map(x=>({...x.record}))}
 isLoaded(id:string){return !!this.get(id).backend}
 private async ensureLoaded(id:string){const entry=this.get(id);if(entry.backend)return entry.backend;if(entry.record.status==='stopped')throw Object.assign(new Error('Agent is not running'),{code:'AGENT_NOT_RUNNING'});if(entry.loading)return entry.loading;entry.record.status='starting';entry.loading=(async()=>{try{const backend=await this.factory(id,entry.record.cwd,entry.record.sessionFile);const state=await backend.getState();entry.record={...entry.record,...state,status:state.status==='stopped'?'idle':state.status};this.connect(entry,backend);return backend}catch(error){entry.record.status='error';throw error}finally{entry.loading=undefined}})();return entry.loading}
 async command(id:string,kind:'prompt'|'steer'|'follow-up'|'abort',message=''){const entry=this.get(id);if(kind==='abort'&&!entry.backend)return;if(entry.record.status==='stopped')throw Object.assign(new Error('Agent is not running'),{code:'AGENT_NOT_RUNNING'});const backend=await this.ensureLoaded(id);if(kind==='abort')return backend.abort();return backend[kind==='follow-up'?'followUp':kind](message)}
 events(id:string,last=0){return this.get(id).events.filter(e=>e.sequence>last)}
 currentSequence(id:string){return this.get(id).nextSequence-1}
 async snapshot(id:string){const a=this.get(id);return {state:a.backend?await a.backend.getState():{...a.record},messages:a.backend?await a.backend.getMessages():[],lastSequence:a.nextSequence-1}}
 hasReplayGap(id:string,last:number){const a=this.get(id);const current=a.nextSequence-1;return last>current||(last>0&&a.events.length>0&&last<a.events[0].sequence-1)}
 subscribe(id:string,listener:(e:StoredEvent)=>void){this.get(id);if(!this.listeners.has(id))this.listeners.set(id,new Set());this.listeners.get(id)!.add(listener);return()=>this.listeners.get(id)?.delete(listener)}
 subscribeAll(listener:(agentId:string,e:StoredEvent)=>void){this.globalListeners.add(listener);return()=>this.globalListeners.delete(listener)}
 async dispose(id:string){const a=this.get(id);if(a.loading)await a.loading.catch(()=>{});await a.backend?.dispose();a.backend=undefined;a.record.status='unloaded'}
 async remove(id:string){const a=this.get(id);if(a.loading)await a.loading.catch(()=>{});await a.backend?.dispose();this.agents.delete(id);this.listeners.delete(id)}
 async archive(id:string){const record={...this.get(id).record,status:'unloaded' as const};await this.remove(id);return record}
 async state(id:string){return (await this.ensureLoaded(id)).getState()} async messages(id:string){return (await this.ensureLoaded(id)).getMessages()}
 async capabilities(id:string){return (await this.ensureLoaded(id)).getCapabilities()} async session(id:string){return (await this.ensureLoaded(id)).getSession()}
 async compact(id:string,instructions?:string){return (await this.ensureLoaded(id)).compact(instructions)} async setModel(id:string,provider:string,modelId:string){return (await this.ensureLoaded(id)).setModel(provider,modelId)}
 async setThinkingLevel(id:string,level:string){return (await this.ensureLoaded(id)).setThinkingLevel(level)} async setSessionName(id:string,name:string){await (await this.ensureLoaded(id)).setSessionName(name);this.get(id).record.sessionName=name.trim()} async navigate(id:string,entryId:string){return (await this.ensureLoaded(id)).navigate(entryId)}
 async fork(id:string,entryId:string){const source=this.get(id),result=await (await this.ensureLoaded(id)).fork(entryId);if(!result.sessionFile)throw Object.assign(new Error('Session persistence is disabled'),{code:'SESSION_NOT_PERSISTED'});const ws=this.workspaces.get(source.record.workspaceId)!;const agent=await this.create(source.record.workspaceId,pathRelative(ws.rootPath,source.record.cwd),result.sessionFile);return {agent,selectedText:result.selectedText}}
 async extensionResponse(id:string,requestId:string,value:unknown){return (await this.ensureLoaded(id)).extensionResponse(requestId,value)}
}
