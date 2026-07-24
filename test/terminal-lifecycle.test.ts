import {describe,expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceStore} from '../src/workspaces.js';
import {TerminalManager,type PtyProcess} from '../src/terminals.js';

class TrackedPty implements PtyProcess {
  private emitter=new EventEmitter();
  disposedData=0;disposedExit=0;
  write(){} resize(){} kill(){}
  onData(listener:(data:string)=>void){this.emitter.on('data',listener);return{dispose:()=>{this.disposedData++;this.emitter.off('data',listener)}}}
  onExit(listener:(event:{exitCode:number})=>void){this.emitter.on('exit',listener);return{dispose:()=>{this.disposedExit++;this.emitter.off('exit',listener)}}}
  exit(exitCode=0){this.emitter.emit('exit',{exitCode})}
}

describe('terminal lifecycle',()=>{
  it('disposes PTY listeners and bounds retained exited terminals',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'remote-pi-terminal-')),workspaces=new WorkspaceStore(),workspace=workspaces.add('x',root),ptys:TrackedPty[]=[];
    const terminals=new TerminalManager(workspaces,()=>{const pty=new TrackedPty();ptys.push(pty);return pty},8,1024,1);
    const first=await terminals.create(workspace.id);ptys[0].exit(0);
    expect(ptys[0]).toMatchObject({disposedData:1,disposedExit:1});
    const second=await terminals.create(workspace.id);ptys[1].exit(0);
    expect(terminals.list().map(item=>item.terminalId)).toEqual([second.terminalId]);
    expect(()=>terminals.get(first.terminalId)).toThrow('Terminal not found');
  });
});
