import {createAgentSession,SessionManager,type AgentSession,type ExtensionUIContext} from '@earendil-works/pi-coding-agent';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {AgentBackend,AgentEvent,AgentState} from './agents.js';

/** Real in-process Pi SDK backend with session/model/extension controls exposed to remote clients. */
export class SdkBackend implements AgentBackend {
  private disposed=false;
  private events=new EventEmitter();
  private pendingUi=new Map<string,{resolve:(value:unknown)=>void,timer:ReturnType<typeof setTimeout>}>();
  private constructor(private readonly session:AgentSession,private readonly agentId:string,private readonly cwd:string){}
  static async create(agentId:string,cwd:string,sessionFile?:string):Promise<SdkBackend>{
    const sessionManager=sessionFile?SessionManager.open(sessionFile):SessionManager.create(cwd);
    const {session,modelFallbackMessage}=await createAgentSession({cwd,sessionManager});
    if(modelFallbackMessage&&!session.state.model){session.dispose();throw Object.assign(new Error(modelFallbackMessage),{code:'PI_MODEL_UNAVAILABLE'})}
    const backend=new SdkBackend(session,agentId,cwd);
    await session.bindExtensions({uiContext:backend.extensionUi()});
    return backend;
  }
  prompt(message:string){return this.session.prompt(message)}
  steer(message:string){return this.session.steer(message)}
  followUp(message:string){return this.session.followUp(message)}
  abort(){return this.session.abort()}
  async getState():Promise<AgentState>{return {agentId:this.agentId,sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,sessionName:this.session.sessionName,cwd:this.cwd,status:this.disposed?'stopped':this.session.isStreaming?'streaming':'idle'}}
  async getMessages():Promise<unknown[]>{return [...this.session.state.messages]}
  async getCapabilities(){
    const current=this.session.model as any;
    const available=await this.session.modelRuntime.getAvailable();
    return {model:current?this.modelInfo(current):null,models:available.map(model=>this.modelInfo(model)),thinkingLevel:this.session.thinkingLevel,thinkingLevels:this.session.getAvailableThinkingLevels(),supportsThinking:this.session.supportsThinking()};
  }
  async getSession(){return {sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,sessionName:this.session.sessionName,leafId:this.session.sessionManager.getLeafId(),entries:this.session.sessionManager.getEntries(),tree:this.session.sessionManager.getTree(),userMessages:this.session.getUserMessagesForForking(),stats:this.session.getSessionStats()}}
  compact(instructions?:string){return this.session.compact(instructions)}
  async setModel(provider:string,modelId:string){const model=this.session.modelRuntime.getModel(provider,modelId);if(!model)throw Object.assign(new Error('Model not found'),{code:'MODEL_NOT_FOUND'});await this.session.setModel(model)}
  async setThinkingLevel(level:string){if(!['off','minimal','low','medium','high','xhigh'].includes(level))throw Object.assign(new Error('Invalid thinking level'),{code:'INVALID_THINKING_LEVEL'});this.session.setThinkingLevel(level as any)}
  async setSessionName(name:string){const value=name.trim();if(!value||value.length>200)throw Object.assign(new Error('Session name must be 1-200 characters'),{code:'INVALID_SESSION_NAME'});this.session.setSessionName(value)}
  navigate(entryId:string){return this.session.navigateTree(entryId)}
  async fork(entryId:string){const entry:any=this.session.sessionManager.getEntry(entryId);if(!entry||entry.type!=='message'||entry.message?.role!=='user')throw Object.assign(new Error('A user message entry is required'),{code:'SESSION_ENTRY_NOT_FOUND'});const content=entry.message.content;const selectedText=typeof content==='string'?content:Array.isArray(content)?content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n'):'';let sessionFile:string|undefined;if(entry.parentId){sessionFile=this.session.sessionManager.createBranchedSession(entry.parentId)}else{const current=this.session.sessionFile;if(!current)throw Object.assign(new Error('Session persistence is disabled'),{code:'SESSION_NOT_PERSISTED'});sessionFile=SessionManager.create(this.cwd,this.session.sessionManager.getSessionDir(),{parentSession:current}).getSessionFile()}return {sessionFile,selectedText}}
  async extensionResponse(requestId:string,value:unknown){const pending=this.pendingUi.get(requestId);if(!pending)throw Object.assign(new Error('Extension UI request not found'),{code:'EXTENSION_REQUEST_NOT_FOUND'});clearTimeout(pending.timer);this.pendingUi.delete(requestId);pending.resolve(value)}
  subscribe(listener:(event:AgentEvent)=>void){const fromSession=(event:unknown)=>listener(event as AgentEvent);const unsubscribe=this.session.subscribe(fromSession);this.events.on('event',listener);return()=>{unsubscribe();this.events.off('event',listener)}}
  async dispose(){if(this.disposed)return;for(const [id,pending] of this.pendingUi){clearTimeout(pending.timer);pending.resolve(undefined);this.pendingUi.delete(id)}await this.session.abort();this.session.dispose();this.disposed=true}
  private modelInfo(model:any){return {provider:model.provider,id:model.id,name:model.name,reasoning:!!model.reasoning,contextWindow:model.contextWindow,maxTokens:model.maxTokens}}
  private request(kind:string,payload:Record<string,unknown>):Promise<unknown>{const requestId=randomUUID();return new Promise(resolve=>{const timer=setTimeout(()=>{this.pendingUi.delete(requestId);resolve(undefined)},5*60_000);this.pendingUi.set(requestId,{resolve,timer});this.events.emit('event',{type:'extension_ui_request',requestId,kind,...payload})})}
  private extensionUi():ExtensionUIContext{return {
    select:async(title:string,options:string[],opts:unknown)=>await this.request('select',{title,options,opts}) as string|undefined,
    confirm:async(title:string,message:string,opts:unknown)=>Boolean(await this.request('confirm',{title,message,opts})),
    input:async(title:string,placeholder:string|undefined,opts:unknown)=>await this.request('input',{title,placeholder,opts}) as string|undefined,
    editor:async(title:string,prefill:string|undefined)=>await this.request('editor',{title,prefill}) as string|undefined,
    notify:(message:string,type:string|undefined)=>this.events.emit('event',{type:'extension_ui_notify',message,notificationType:type??'info'}),
    setStatus:(key:string,text:string|undefined)=>this.events.emit('event',{type:'extension_ui_status',key,text}),
    setWidget:(key:string,content:unknown,options:unknown)=>this.events.emit('event',{type:'extension_ui_widget',key,content:Array.isArray(content)?content:undefined,options}),
    setTitle:(title:string)=>this.events.emit('event',{type:'extension_ui_title',title}),
    setWorkingMessage:(message:string|undefined)=>this.events.emit('event',{type:'extension_ui_working_message',message}),setWorkingVisible:()=>{},setWorkingIndicator:()=>{},setHiddenThinkingLabel:()=>{},
    onTerminalInput:()=>()=>{},setFooter:()=>{},setHeader:()=>{},pasteToEditor:()=>{},setEditorText:()=>{},getEditorText:()=>'',addAutocompleteProvider:()=>{},setEditorComponent:()=>{},custom:async()=>{throw Object.assign(new Error('Custom extension components are unsupported'),{code:'EXTENSION_CUSTOM_UI_UNSUPPORTED'})}
  } as unknown as ExtensionUIContext}
}
export const createSdkBackend=(agentId:string,cwd:string,sessionFile?:string)=>SdkBackend.create(agentId,cwd,sessionFile);
