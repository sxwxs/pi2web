import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

export type VoiceConfig={
  speechBaseUrl:string;
  speechApiKey?:string;
  sttModel?:string;
  ttsModel:string;
  ttsVoice:string;
  summaryBaseUrl:string;
  summaryApiKey?:string;
  summaryModel:string;
  language?:string;
  maxInputChars?:number;
  maxOutputTokens?:number;
  sampleRate?:number;
};
export type VoiceEvent={type:string,[key:string]:unknown};
type Fetcher=typeof fetch;
const punctuation=new Set(['。','！','？','!','?','.']);
const closing=new Set(['”','’','"','\'','）',')','】',']']);

const endpoint=(base:string,path:string)=>`${base.replace(/\/$/,'')}${base.replace(/\/$/,'').endsWith('/v1')?'':'/v1'}${path}`;
const authHeaders=(key?:string):Record<string,string>=>key?{authorization:`Bearer ${key}`}:{ };
const abortError=(error:unknown)=>error instanceof Error&&error.name==='AbortError';

export function assistantText(message:unknown):string|undefined{
  if(typeof message==='string')return message.trim()||undefined;
  if(!message||typeof message!=='object')return;
  const value=message as any;
  if(value.role&&value.role!=='assistant')return;
  if(typeof value.content==='string')return value.content.trim()||undefined;
  if(Array.isArray(value.content)){
    const text=value.content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string').map((part:any)=>part.text).join('\n').trim();
    return text||undefined;
  }
}

export function prepareSummaryInput(text:string,maxChars=32000):string{
  let cleaned=text
    .replace(/```[\s\S]*?```/g,' [代码已省略] ')
    .replace(/<details[\s\S]*?<\/details>/gi,' [详细内容已省略] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,'链接')
    .replace(/^\s{0,3}#{1,6}\s+/gm,'')
    .replace(/^\s*[-*+]\s+/gm,'')
    .replace(/`([^`]+)`/g,'$1')
    .replace(/[ \t]+/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  if(cleaned.length<=maxChars)return cleaned;
  const head=Math.floor(maxChars*0.375),tail=maxChars-head;
  cleaned=`${cleaned.slice(0,head)}\n\n[中间内容已省略]\n\n${cleaned.slice(-tail)}`;
  return cleaned;
}

export class SentenceChunker{
  private buffer='';
  constructor(private maxChars=100){}
  add(delta:string){this.buffer+=delta;return this.consume(false)}
  close(){return this.consume(true)}
  private consume(final:boolean){
    const chunks:string[]=[];
    while(this.buffer){
      let cut=-1;
      for(let i=0;i<this.buffer.length;i++)if(punctuation.has(this.buffer[i])&&i>=3){cut=i+1;while(cut<this.buffer.length&&closing.has(this.buffer[cut]))cut++;break}
      if(cut<0&&this.buffer.length>=this.maxChars){const range=this.buffer.slice(0,this.maxChars+1),fallback=Math.max(range.lastIndexOf('，'),range.lastIndexOf(','),range.lastIndexOf(' '));cut=fallback>=8?fallback+1:this.maxChars}
      if(cut<0){if(!final)break;cut=this.buffer.length}
      const chunk=this.buffer.slice(0,cut).trim();this.buffer=this.buffer.slice(cut);
      if(chunk)chunks.push(chunk);
    }
    return chunks;
  }
}

async function* sseText(response:Response):AsyncGenerator<string>{
  if(!response.body)throw new Error('Summary endpoint returned no response body');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){
    const {done,value}=await reader.read();buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});
    const records=buffer.split(/\r?\n\r?\n/);buffer=records.pop()??'';
    for(const record of records){
      for(const line of record.split(/\r?\n/)){
        if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;
        let parsed:any;try{parsed=JSON.parse(data)}catch{continue}
        const content=parsed?.choices?.[0]?.delta?.content;
        if(typeof content==='string'&&content)yield content;
        else if(Array.isArray(content))for(const part of content)if(part?.type==='text'&&typeof part.text==='string')yield part.text;
      }
    }
    if(done)break;
  }
}

export class VoiceManager{
  private emitter=new EventEmitter();
  private lastAssistant=new Map<string,string>();
  private active=new Map<string,AbortController>();
  private readonly config:Required<Pick<VoiceConfig,'language'|'maxInputChars'|'maxOutputTokens'|'sampleRate'>>&VoiceConfig;
  constructor(config:VoiceConfig,private fetcher:Fetcher=fetch){this.config={language:'zh-CN',maxInputChars:32000,maxOutputTokens:160,sampleRate:24000,...config}}
  subscribe(listener:(agentId:string,event:VoiceEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
  private emit(agentId:string,event:VoiceEvent){this.emitter.emit('event',agentId,event)}
  handleAgentEvent(agentId:string,event:{type:string,[key:string]:unknown}){
    if(event.type==='message_end'){const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);return}
    if(event.type==='agent_start'){this.cancel(agentId);return}
    if(event.type==='agent_settled'){const text=this.lastAssistant.get(agentId);this.lastAssistant.delete(agentId);if(text)void this.announce(agentId,text)}
  }
  cancel(agentId:string){const controller=this.active.get(agentId);if(controller){controller.abort();this.active.delete(agentId);this.emit(agentId,{type:'voice_cancelled'})}}
  close(){for(const id of [...this.active.keys()])this.cancel(id);this.emitter.removeAllListeners()}
  async transcribe(audio:Uint8Array,mimeType='audio/webm',filename='recording.webm'){
    if(!this.config.sttModel)throw Object.assign(new Error('Voice STT model is not configured'),{code:'VOICE_STT_DISABLED'});
    const copy=new Uint8Array(audio.byteLength);copy.set(audio);const form=new FormData();form.append('file',new Blob([copy.buffer],{type:mimeType}),filename);form.append('model',this.config.sttModel);form.append('response_format','json');
    const response=await this.fetcher(endpoint(this.config.speechBaseUrl,'/audio/transcriptions'),{method:'POST',headers:authHeaders(this.config.speechApiKey),body:form});
    if(!response.ok)throw Object.assign(new Error(`Speech transcription failed (${response.status}): ${(await response.text()).slice(0,500)}`),{code:'VOICE_STT_FAILED'});
    const value:any=await response.json();const text=typeof value==='string'?value:value?.text;
    if(typeof text!=='string')throw Object.assign(new Error('Speech transcription returned no text'),{code:'VOICE_STT_FAILED'});
    return {text:text.trim(),language:value?.language};
  }
  async announce(agentId:string,rawText:string){
    this.cancel(agentId);const controller=new AbortController(),playbackId=randomUUID();this.active.set(agentId,controller);
    this.emit(agentId,{type:'voice_start',playbackId,encoding:'pcm_s16le',sampleRate:this.config.sampleRate,channels:1});
    let summary='',speechError:Error|undefined,speechChain=Promise.resolve();const chunker=new SentenceChunker();
    const queue=(sentence:string)=>{speechChain=speechChain.then(()=>this.speak(agentId,playbackId,sentence,controller.signal)).catch(error=>{if(!abortError(error)&&!speechError)speechError=error as Error})};
    try{
      const input=prepareSummaryInput(rawText,this.config.maxInputChars);
      const response=await this.fetcher(endpoint(this.config.summaryBaseUrl,'/chat/completions'),{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',...authHeaders(this.config.summaryApiKey)},body:JSON.stringify({model:this.config.summaryModel,stream:true,temperature:0.2,max_tokens:this.config.maxOutputTokens,messages:[{role:'system',content:this.summaryPrompt()},{role:'user',content:input}]})});
      if(!response.ok)throw new Error(`Summary request failed (${response.status}): ${(await response.text()).slice(0,500)}`);
      for await(const delta of sseText(response)){summary+=delta;this.emit(agentId,{type:'voice_summary_delta',playbackId,text:delta});for(const sentence of chunker.add(delta))queue(sentence)}
      for(const sentence of chunker.close())queue(sentence);
      if(!summary.trim())throw new Error('Summary endpoint returned no text');
      await speechChain;if(speechError)throw speechError;
      if(this.active.get(agentId)===controller)this.emit(agentId,{type:'voice_end',playbackId,summary:summary.trim()});
    }catch(error){
      if(!abortError(error)&&this.active.get(agentId)===controller){
        this.emit(agentId,{type:'voice_error',playbackId,message:(error as Error).message});
        if(!summary.trim()){
          const fallback=this.config.language.toLowerCase().startsWith('zh')?'Agent 已完成，等待输入。':'The agent has finished and is ready for input.';
          try{this.emit(agentId,{type:'voice_summary_delta',playbackId,text:fallback});await this.speak(agentId,playbackId,fallback,controller.signal);this.emit(agentId,{type:'voice_end',playbackId,summary:fallback})}catch{/* The text notification remains available when TTS also fails. */}
        }else this.emit(agentId,{type:'voice_end',playbackId,summary:summary.trim(),partial:true});
      }
    }finally{if(this.active.get(agentId)===controller)this.active.delete(agentId)}
  }
  private summaryPrompt(){return `你是开发任务完成通知的语音摘要器。请把 Agent 的最终输出转换为可直接朗读的简短${this.config.language.toLowerCase().startsWith('zh')?'中文':'文本'}。只输出纯文本，输出 2 到 4 个短句，最多 120 个中文字符或 70 个英文单词。优先说明任务是否完成、最重要的修改、测试结果或失败原因；如果用户需要采取行动必须说明。不要朗读代码、命令、URL、完整路径、哈希、日志和 Markdown，不要使用标题、列表或“总结如下”等开场白，不要猜测原文没有的信息。`}
  private async speak(agentId:string,playbackId:string,text:string,signal:AbortSignal){
    const response=await this.fetcher(endpoint(this.config.speechBaseUrl,'/audio/speech'),{method:'POST',signal,headers:{'content-type':'application/json',...authHeaders(this.config.speechApiKey)},body:JSON.stringify({model:this.config.ttsModel,voice:this.config.ttsVoice,input:text,response_format:'pcm',sample_rate:this.config.sampleRate,stream_format:'audio'})});
    if(!response.ok)throw new Error(`Speech synthesis failed (${response.status}): ${(await response.text()).slice(0,500)}`);
    if(!response.body)throw new Error('Speech synthesis returned no audio');const reader=response.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;if(value?.length)this.emit(agentId,{type:'voice_audio_chunk',playbackId,sampleRate:this.config.sampleRate,audio:Buffer.from(value).toString('base64')})}
  }
}
