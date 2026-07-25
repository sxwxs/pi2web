import path from 'node:path';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WorkspaceStore } from './workspaces.js';

export type TerminalStatus='running'|'exited';
export type TerminalRecord={terminalId:string,workspaceId:string,cwd:string,title:string,status:TerminalStatus,createdAt:string,lastActiveAt:string,exitCode?:number};
export type TerminalEvent={type:'output',data:string}|{type:'exit',exitCode:number};
export interface PtyProcess {write(data:string):void;resize(cols:number,rows:number):void;kill():void;onData(listener:(data:string)=>void):{dispose():void};onExit(listener:(event:{exitCode:number})=>void):{dispose():void}}
type Disposable={dispose():void};
type TerminalEntry={record:TerminalRecord,process:PtyProcess,emitter:EventEmitter,buffer:string,dataSubscription?:Disposable,exitSubscription?:Disposable};
export type TerminalFactory=(cwd:string,cols:number,rows:number)=>PtyProcess;

const defaultFactory:TerminalFactory=(cwd,cols,rows)=>{
  const windows=process.platform==='win32';
  const shell=windows?(process.env.COMSPEC||'cmd.exe'):(process.env.SHELL||'/bin/sh');
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  return pty.spawn(shell,[],{name:'xterm-256color',cwd,cols,rows,env,useConpty:windows}) as IPty;
};

export class TerminalManager {
  private terminals=new Map<string,TerminalEntry>();
  constructor(private workspaces:WorkspaceStore,private factory:TerminalFactory=defaultFactory,private maxRunning=8,private maxBuffer=512*1024,private maxRetained=50){}
  list(){return [...this.terminals.values()].map(x=>({...x.record})).sort((a,b)=>b.lastActiveAt.localeCompare(a.lastActiveAt))}
  get(id:string){const entry=this.terminals.get(id);if(!entry)throw Object.assign(new Error('Terminal not found'),{code:'TERMINAL_NOT_FOUND'});return entry}
  async create(workspaceId:string,relativeCwd='.',cols=80,rows=24){
    this.pruneExited();
    if(this.list().filter(x=>x.status==='running').length>=this.maxRunning)throw Object.assign(new Error(`At most ${this.maxRunning} terminals may run at once`),{code:'TERMINAL_LIMIT'});
    const workspace=this.workspaces.get(workspaceId);if(!workspace)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});
    const cwd=await this.workspaces.resolve(workspace,relativeCwd);
    if(!(await stat(cwd)).isDirectory())throw Object.assign(new Error('cwd is not a directory'),{code:'NOT_A_DIRECTORY'});
    const terminalId=`terminal-${randomUUID()}`,now=new Date().toISOString(),process=this.factory(cwd,this.dimension(cols,80),this.dimension(rows,24));
    const record:TerminalRecord={terminalId,workspaceId,cwd,title:path.basename(cwd)||cwd,status:'running',createdAt:now,lastActiveAt:now};
    const entry:TerminalEntry={record,process,emitter:new EventEmitter(),buffer:''};this.terminals.set(terminalId,entry);
    entry.dataSubscription=process.onData(data=>{entry.buffer=(entry.buffer+data).slice(-this.maxBuffer);entry.record.lastActiveAt=new Date().toISOString();entry.emitter.emit('event',{type:'output',data} satisfies TerminalEvent)});
    const exitSubscription=process.onExit(event=>{entry.record.status='exited';entry.record.exitCode=event.exitCode;entry.record.lastActiveAt=new Date().toISOString();entry.emitter.emit('event',{type:'exit',exitCode:event.exitCode} satisfies TerminalEvent);this.disposeProcessListeners(entry);this.pruneExited()});
    if(entry.record.status==='exited')exitSubscription.dispose();else entry.exitSubscription=exitSubscription;
    return {...record};
  }
  snapshot(id:string){const entry=this.get(id);return {record:{...entry.record},data:entry.buffer}}
  write(id:string,data:string){const entry=this.get(id);if(entry.record.status!=='running')throw Object.assign(new Error('Terminal has exited'),{code:'TERMINAL_EXITED'});if(typeof data!=='string'||data.length>64*1024)throw Object.assign(new Error('Invalid terminal input'),{code:'INVALID_REQUEST'});entry.process.write(data);entry.record.lastActiveAt=new Date().toISOString()}
  resize(id:string,cols:number,rows:number){const entry=this.get(id);if(entry.record.status==='running')entry.process.resize(this.dimension(cols,80),this.dimension(rows,24))}
  subscribe(id:string,listener:(event:TerminalEvent)=>void){const entry=this.get(id);entry.emitter.on('event',listener);return()=>entry.emitter.off('event',listener)}
  close(id:string){const entry=this.get(id);this.terminals.delete(id);if(entry.record.status==='running')entry.emitter.emit('event',{type:'exit',exitCode:-1} satisfies TerminalEvent);this.disposeProcessListeners(entry);if(entry.record.status==='running')try{entry.process.kill()}catch{}entry.emitter.removeAllListeners()}
  closeAll(){for(const id of [...this.terminals.keys()])this.close(id)}
  private disposeProcessListeners(entry:TerminalEntry){entry.dataSubscription?.dispose();entry.exitSubscription?.dispose();entry.dataSubscription=undefined;entry.exitSubscription=undefined}
  private pruneExited(){const exited=[...this.terminals.entries()].reverse().filter(([,entry])=>entry.record.status==='exited').sort((a,b)=>b[1].record.lastActiveAt.localeCompare(a[1].record.lastActiveAt));for(const [id] of exited.slice(this.maxRetained))this.close(id)}
  private dimension(value:number,fallback:number){return Number.isInteger(value)&&value>0&&value<=1000?value:fallback}
}
