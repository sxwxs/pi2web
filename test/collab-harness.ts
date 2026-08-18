import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend,type AgentBackend} from '../src/agents.js';
import type {MailNotifier} from '../src/mail-notifier.js';

export type CollabCall=(method:string,url:string,body?:unknown,token?:string)=>Promise<{status:number,data:any,error:any}>;

/**
 * A local server whose Agent backends are mocked, plus the two things every collaboration test needs: an
 * authenticated `call`, and `collabAgent()` for the dedicated `profile=collab` Agent a seat must be bound to
 * (the hub refuses a seat it could never wake). The caller owns `server` and stops it.
 */
export async function bootCollabServer(prefix:string,options:{factory?:(id:string,cwd:string,sessionFile?:string)=>AgentBackend,mailNotifier?:MailNotifier}={}){
  const dataDir=await mkdtemp(path.join(tmpdir(),`${prefix}-`)),root=await mkdtemp(path.join(tmpdir(),`${prefix}-ws-`));
  const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,options.factory??((id,cwd,sessionFile)=>new MockBackend(id,cwd,sessionFile)));
  const server=new RemotePiServer({port:0,dataDir,workspaces,agents,mailNotifier:options.mailNotifier});
  const auth=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
  const call:CollabCall=async(method,url,body,token=human)=>{
    const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload:any=await response.json().catch(()=>({}));
    return {status:response.status,data:payload.data,error:payload.error};
  };
  const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
  const collabAgent=async():Promise<string>=>(await call('POST','/api/v1/agents',{workspaceId:workspace.id,profile:'collab'})).data.agentId;
  return {server,agents,workspaces,base,human,dataDir,root,call,workspace,collabAgent};
}
