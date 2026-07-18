import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { relative as pathRelative } from 'node:path';
import type { WorkspaceStore } from './workspaces.js';
import { createSdkBackend } from './sdk-backend.js';
export type AgentState={status:'starting'|'idle'|'streaming'|'waiting_for_user'|'error'|'stopping'|'stopped',agentId:string,sessionId:string,sessionFile?:string,cwd:string};
export type AgentEvent={type:string,[key:string]:unknown};
export interface AgentBackend {prompt(message:string):Promise<void>;steer(message:string):Promise<void>;followUp(message:string):Promise<void>;abort():Promise<void>;getState():Promise<AgentState>;getMessages():Promise<unknown[]>;subscribe(listener:(e:AgentEvent)=>void):()=>void;dispose():Promise<void>}
/** Deterministic backend used by the server and tests. The SDK adapter can implement the same contract. */
export class MockBackend implements AgentBackend {
 private emitter=new EventEmitter(); private state:AgentState; private messages:unknown[]=[]; private timer?:ReturnType<typeof setTimeout>;
 constructor(agentId:string,cwd:string,sessionId:string=randomUUID()){this.state={agentId,sessionId,cwd,status:'idle'}}
 private emit(e:AgentEvent){this.emitter.emit('event',e)}
 async prompt(message:string){if(this.state.status==='streaming')throw Object.assign(new Error('Agent is busy'),{code:'AGENT_BUSY'});this.state.status='streaming';this.emit({type:'agent_start',message});await new Promise<void>(r=>{this.timer=setTimeout(r,0)});this.messages.push({role:'user',content:message});this.emit({type:'message_start',role:'assistant'});this.emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:`Mock response: ${message}`}});this.emit({type:'message_end',message:`Mock response: ${message}`});this.state.status='idle';this.emit({type:'agent_end'});}
 async steer(message:string){this.emit({type:'steer',message})} async followUp(message:string){this.emit({type:'follow_up',message})}
 async abort(){if(this.state.status==='streaming'){if(this.timer)clearTimeout(this.timer);this.state.status='idle';this.emit({type:'agent_end',aborted:true})}}
 async getState(){return {...this.state}} async getMessages(){return [...this.messages]}
 subscribe(listener:(e:AgentEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
 async dispose(){await this.abort();this.state.status='stopped';this.emitter.removeAllListeners()}
}
export type AgentRecord=AgentState&{workspaceId:string,createdAt:string,lastActiveAt:string};
export class AgentManager {
 private agents=new Map<string,{record:AgentRecord,backend:AgentBackend,events:{id:string,sequence:number,event:AgentEvent}[],nextSequence:number}>(); private listeners=new Map<string,Set<(e:{id:string,sequence:number,event:AgentEvent})=>void>>();
 constructor(private workspaces:WorkspaceStore,private factory:(id:string,cwd:string,sessionFile?:string)=>AgentBackend|Promise<AgentBackend>=createSdkBackend){}
 async create(workspaceId:string,relativeCwd='.') {const ws=this.workspaces.get(workspaceId);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});const cwd=await this.workspaces.resolve(ws,relativeCwd);if(!(await import('node:fs/promises')).stat(cwd).then(s=>s.isDirectory()))throw new Error('cwd is not a directory');const id=`agent-${randomUUID()}`,backend=await this.factory(id,cwd),now=new Date().toISOString();const record={...(await backend.getState()),workspaceId,createdAt:now,lastActiveAt:now};this.attach(id,record,backend);return {...record}}
 private attach(id:string,record:AgentRecord,backend:AgentBackend){const entry={record,backend,events:[] as {id:string,sequence:number,event:AgentEvent}[],nextSequence:1};backend.subscribe(event=>{record.status=event.type==='agent_start'?'streaming':event.type==='agent_end'?'idle':record.status;record.lastActiveAt=new Date().toISOString();const item={id:randomUUID(),sequence:entry.nextSequence++,event};entry.events.push(item);if(entry.events.length>1000)entry.events.shift();for(const listener of this.listeners.get(id)??[])listener(item)});this.agents.set(id,entry)}
 async restore(records:AgentRecord[]){for(const saved of records){try{const ws=this.workspaces.get(saved.workspaceId);if(!ws)continue;const cwd=await this.workspaces.resolve(ws,pathRelative(ws.rootPath,saved.cwd));const backend=await this.factory(saved.agentId,cwd,saved.sessionFile);const state=await backend.getState();this.attach(saved.agentId,{...saved,...state,status:'idle'},backend)}catch{/* Keep server startup resilient to deleted workspaces/session files. */}}}
 get(id:string){const x=this.agents.get(id);if(!x)throw Object.assign(new Error('Agent not found'),{code:'AGENT_NOT_FOUND'});return x}
 list(){return [...this.agents.values()].map(x=>({...x.record}))}
 async command(id:string,kind:'prompt'|'steer'|'follow-up'|'abort',message=''){const a=this.get(id);if(a.record.status==='stopped')throw Object.assign(new Error('Agent is not running'),{code:'AGENT_NOT_RUNNING'});if(kind==='abort')return a.backend.abort();return a.backend[kind==='follow-up'?'followUp':kind](message)}
 events(id:string,last=0){return this.get(id).events.filter(e=>e.sequence>last)}
 subscribe(id:string,listener:(e:{id:string,sequence:number,event:AgentEvent})=>void){if(!this.listeners.has(id))this.listeners.set(id,new Set());this.listeners.get(id)!.add(listener);return()=>this.listeners.get(id)?.delete(listener)}
 async dispose(id:string){const a=this.get(id);await a.backend.dispose();a.record.status='stopped';}
 async state(id:string){return this.get(id).backend.getState()} async messages(id:string){return this.get(id).backend.getMessages()}
}
