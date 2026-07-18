import {createAgentSession,SessionManager,type AgentSession} from '@earendil-works/pi-coding-agent';
import type {AgentBackend,AgentEvent,AgentState} from './agents.js';

/** Real in-process Pi SDK backend. It uses the same ~/.pi/agent auth, model and settings as the Pi CLI. */
export class SdkBackend implements AgentBackend {
  private disposed=false;
  private constructor(private readonly session:AgentSession,private readonly agentId:string,private readonly cwd:string){}
  static async create(agentId:string,cwd:string,sessionFile?:string):Promise<SdkBackend>{
    const sessionManager=sessionFile?SessionManager.open(sessionFile):SessionManager.create(cwd);
    const {session,modelFallbackMessage}=await createAgentSession({cwd,sessionManager});
    if(modelFallbackMessage&&!session.state.model){session.dispose();throw Object.assign(new Error(modelFallbackMessage),{code:'PI_MODEL_UNAVAILABLE'})}
    return new SdkBackend(session,agentId,cwd);
  }
  prompt(message:string){return this.session.prompt(message)}
  steer(message:string){return this.session.steer(message)}
  followUp(message:string){return this.session.followUp(message)}
  abort(){return this.session.abort()}
  async getState():Promise<AgentState>{return {agentId:this.agentId,sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,cwd:this.cwd,status:this.disposed?'stopped':this.session.isStreaming?'streaming':'idle'}}
  async getMessages():Promise<unknown[]>{return [...this.session.state.messages]}
  subscribe(listener:(event:AgentEvent)=>void){return this.session.subscribe(event=>listener(event as AgentEvent))}
  async dispose(){if(this.disposed)return;await this.session.abort();this.session.dispose();this.disposed=true}
}
export const createSdkBackend=(agentId:string,cwd:string,sessionFile?:string)=>SdkBackend.create(agentId,cwd,sessionFile);
