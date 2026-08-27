import {EventEmitter} from 'node:events';
import {assistantText,authHeaders,clipSummaryField,deadline,endpoint,prepareSummaryInput} from './voice.js';

/**
 * Automatic session naming. Deliberately independent from the voice announcer: naming only needs a
 * small text completion, so it stays on by default even when TTS is disabled. When voice IS enabled
 * the announcer just speaks the summary; the name still comes from here.
 */
export type SessionNamerConfig={
  baseUrl?:string;
  apiKey?:string;
  model?:string;
  language?:string;
  maxInputChars?:number;
  maxOutputTokens?:number;
  requestTimeoutMs?:number;
};
export type SessionNamerContext={sessionName?:string;setSessionName?:(name:string)=>Promise<void>|void};
export type SessionNamerEvent={type:string,[key:string]:unknown};
type Fetcher=typeof fetch;

export const DEFAULT_SESSION_NAMER:Required<Omit<SessionNamerConfig,'apiKey'>>={
  baseUrl:'http://localhost:8313/',model:'gpt-5-mini',language:'zh-CN',
  maxInputChars:8000,maxOutputTokens:64,requestTimeoutMs:60000
};

export function parseSessionName(text:string):string|undefined{
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let candidate=trimmed;
  const start=trimmed.indexOf('{'),end=trimmed.lastIndexOf('}');
  if(start>=0&&end>start){try{const value:any=JSON.parse(trimmed.slice(start,end+1));if(typeof value?.sessionName==='string')candidate=value.sessionName}catch{/* fall back to the raw text below */}}
  const name=candidate.replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').replace(/^["'“”‘’]|["'“”‘’]$/g,'').trim().slice(0,60).trim();
  return name||undefined;
}

export class SessionNamer{
  private emitter=new EventEmitter();
  private lastAssistant=new Map<string,string>();
  private lastPrompt=new Map<string,string>();
  private pending=new Set<string>();
  private closed=false;
  private readonly config:Required<SessionNamerConfig>;
  constructor(config:SessionNamerConfig={},private fetcher:Fetcher=fetch){this.config={apiKey:'',...DEFAULT_SESSION_NAMER,...strip(config)}}
  subscribe(listener:(agentId:string,event:SessionNamerEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
  close(){this.closed=true;this.emitter.removeAllListeners();this.lastAssistant.clear();this.lastPrompt.clear()}
  recordUserPrompt(agentId:string,prompt:string){const value=prompt.trim();if(value)this.lastPrompt.set(agentId,value)}
  private emit(agentId:string,event:SessionNamerEvent){this.emitter.emit('event',agentId,event)}
  handleAgentEvent(agentId:string,event:{type:string,[key:string]:unknown},context:SessionNamerContext={}){
    if(this.closed)return;
    if(event.type==='before_agent_start'&&typeof event.prompt==='string')return void this.recordUserPrompt(agentId,event.prompt);
    if(event.type==='agent_start'){if(typeof event.message==='string')this.recordUserPrompt(agentId,event.message);return}
    if(event.type==='message_end'){const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);return}
    if(event.type!=='agent_settled')return;
    const finalOutput=this.lastAssistant.get(agentId)??'',userPrompt=this.lastPrompt.get(agentId)??'';
    this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);
    if(context.sessionName?.trim()||!context.setSessionName)return;
    if(!userPrompt&&!finalOutput)return;
    void this.nameSession(agentId,userPrompt,finalOutput,context.setSessionName);
  }
  /** Generates and applies a name. Exposed so callers can trigger naming outside the event stream. */
  async nameSession(agentId:string,userPrompt:string,finalOutput:string,apply:(name:string)=>Promise<void>|void){
    if(this.pending.has(agentId))return;
    this.pending.add(agentId);
    try{
      const name=await this.requestName(userPrompt,finalOutput);
      if(!name)throw new Error('Naming endpoint returned no session name');
      await apply(name);
      this.emit(agentId,{type:'session_name_generated',name});
    }catch(error){
      this.emit(agentId,{type:'session_name_error',message:(error as Error).message});
    }finally{this.pending.delete(agentId)}
  }
  private async requestName(userPrompt:string,finalOutput:string){
    const promptBudget=Math.max(1,Math.floor(this.config.maxInputChars*0.6));
    const body=JSON.stringify({
      userPrompt:clipSummaryField(userPrompt,promptBudget),
      piFinalOutput:prepareSummaryInput(finalOutput,Math.max(1,this.config.maxInputChars-promptBudget))
    });
    const response=await this.fetcher(endpoint(this.config.baseUrl,'/chat/completions'),{
      method:'POST',signal:deadline(this.config.requestTimeoutMs),
      headers:{'content-type':'application/json',...authHeaders(this.config.apiKey||undefined)},
      body:JSON.stringify({model:this.config.model,stream:false,temperature:0.2,max_tokens:this.config.maxOutputTokens,
        messages:[{role:'system',content:this.prompt()},{role:'user',content:body}]})
    });
    if(!response.ok)throw new Error(`Session naming request failed (${response.status}): ${(await response.text()).slice(0,300)}`);
    const value:any=await response.json();
    const content=value?.choices?.[0]?.message?.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string').map((part:any)=>part.text).join(''):'';
    if(!text.trim())throw new Error('Naming endpoint returned no content');
    return parseSessionName(text);
  }
  private prompt(){
    const language=this.config.language.toLowerCase().startsWith('zh')?'简体中文':'与用户输入相同的主要语言';
    return `你负责为一次 Pi 编程会话生成标题。\n\n输入是一个 JSON 对象：\n- userPrompt：用户本轮真正想完成的任务。\n- piFinalOutput：Pi 最后一次回复。\n\n主要依据 userPrompt 概括任务主题，必要时参考 piFinalOutput。标题使用${language}：中文 6 到 18 个字，英文 3 到 8 个词；具体、便于检索，不写“新会话”“任务总结”等空泛名称，不带句号、引号、Emoji、代码或路径。\n\n只输出一个合法 JSON 对象：{"sessionName":"简短标题"}，不要输出 Markdown 代码块、解释或任何额外文字。`;
  }
}

const strip=<T extends object>(value:T):Partial<T>=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!=='')) as Partial<T>;
