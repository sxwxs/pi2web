import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

export type VoiceConfig={
  speechBaseUrl:string;
  speechApiKey?:string;
  sttModel?:string;
  ttsModel:string;
  ttsVoice:string;
  ttsFormat?:'pcm'|'mp3';
  summaryBaseUrl:string;
  summaryApiKey?:string;
  summaryModel:string;
  language?:string;
  maxInputChars?:number;
  maxOutputTokens?:number;
  sampleRate?:number;
};
export type VoiceEvent={type:string,[key:string]:unknown};
export type VoiceSummaryInput={userPrompt:string;finalOutput:string;sessionName?:string;setSessionName?:(name:string)=>Promise<void>|void};
export type VoiceAgentContext={sessionName?:string;setSessionName?:(name:string)=>Promise<void>|void};
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

function clipSummaryField(text:string,maxChars:number):string{
  const normalized=text.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();if(normalized.length<=maxChars)return normalized;
  const head=Math.floor(maxChars*0.375),tail=maxChars-head;return `${normalized.slice(0,head)}\n\n[中间内容已省略]\n\n${normalized.slice(-tail)}`;
}

export function prepareSummaryContext(input:VoiceSummaryInput,maxChars=32000):string{
  const promptBudget=Math.max(1,Math.floor(maxChars*0.4)),outputBudget=Math.max(1,maxChars-promptBudget);
  return JSON.stringify({
    userPrompt:clipSummaryField(input.userPrompt,promptBudget),
    piFinalOutput:prepareSummaryInput(input.finalOutput,outputBudget),
    sessionNeedsName:!input.sessionName?.trim()
  });
}

export function parseSummaryResult(text:string):{summary:string;sessionName?:string}{
  const trimmed=text.trim(),candidate=trimmed.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let value:any;try{value=JSON.parse(candidate)}catch{const start=candidate.indexOf('{'),end=candidate.lastIndexOf('}');if(start<0||end<=start)throw new Error('Summary endpoint returned invalid JSON');try{value=JSON.parse(candidate.slice(start,end+1))}catch{throw new Error('Summary endpoint returned invalid JSON')}}
  const summary=typeof value?.summary==='string'?value.summary.trim():'';
  if(!summary)throw new Error('Summary endpoint returned no summary');
  const rawName=typeof value?.sessionName==='string'?value.sessionName.trim():'';
  const sessionName=rawName.replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').slice(0,60).trim();
  return {summary,...(sessionName?{sessionName}:{})};
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
  private lastPrompt=new Map<string,string>();
  private active=new Map<string,AbortController>();
  private readonly config:Required<Pick<VoiceConfig,'language'|'maxInputChars'|'maxOutputTokens'|'sampleRate'|'ttsFormat'>>&VoiceConfig;
  constructor(config:VoiceConfig,private fetcher:Fetcher=fetch){this.config={language:'zh-CN',maxInputChars:32000,maxOutputTokens:160,sampleRate:24000,ttsFormat:'pcm',...config}}
  subscribe(listener:(agentId:string,event:VoiceEvent)=>void){this.emitter.on('event',listener);return()=>this.emitter.off('event',listener)}
  capabilities(){return {tts:true,stt:!!this.config.sttModel}}
  recordUserPrompt(agentId:string,prompt:string){const value=prompt.trim();if(value)this.lastPrompt.set(agentId,value)}
  private emit(agentId:string,event:VoiceEvent){this.emitter.emit('event',agentId,event)}
  handleAgentEvent(agentId:string,event:{type:string,[key:string]:unknown},context:VoiceAgentContext={}){
    if(event.type==='before_agent_start'&&typeof event.prompt==='string'){this.lastPrompt.set(agentId,event.prompt);return}
    if(event.type==='message_end'){const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);return}
    if(event.type==='agent_start'){if(typeof event.message==='string')this.recordUserPrompt(agentId,event.message);this.cancel(agentId);return}
    if(event.type==='agent_settled'){
      const finalOutput=this.lastAssistant.get(agentId),userPrompt=this.lastPrompt.get(agentId)??'';this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);
      if(finalOutput)void this.announce(agentId,{userPrompt,finalOutput,...context});
    }
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
  async announce(agentId:string,value:VoiceSummaryInput|string){
    const input:VoiceSummaryInput=typeof value==='string'?{userPrompt:'',finalOutput:value}:value;
    this.cancel(agentId);const controller=new AbortController(),playbackId=randomUUID();this.active.set(agentId,controller);
    this.emit(agentId,{type:'voice_start',playbackId,encoding:this.config.ttsFormat==='mp3'?'mp3':'pcm_s16le',sampleRate:this.config.sampleRate,channels:1});
    let rawResult='',spokenSummary='';
    try{
      const summaryInput=prepareSummaryContext(input,this.config.maxInputChars);
      const response=await this.fetcher(endpoint(this.config.summaryBaseUrl,'/chat/completions'),{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',...authHeaders(this.config.summaryApiKey)},body:JSON.stringify({model:this.config.summaryModel,stream:true,temperature:0.2,max_tokens:this.config.maxOutputTokens,messages:[{role:'system',content:this.summaryPrompt()},{role:'user',content:summaryInput}]})});
      if(!response.ok)throw new Error(`Summary request failed (${response.status}): ${(await response.text()).slice(0,500)}`);
      for await(const delta of sseText(response))rawResult+=delta;
      const result=parseSummaryResult(rawResult);spokenSummary=result.summary;
      this.emit(agentId,{type:'voice_summary_delta',playbackId,text:spokenSummary});
      if(!input.sessionName?.trim()&&result.sessionName&&input.setSessionName){try{await input.setSessionName(result.sessionName)}catch(error){this.emit(agentId,{type:'voice_session_name_error',playbackId,message:(error as Error).message})}}
      const chunker=new SentenceChunker();for(const sentence of [...chunker.add(spokenSummary),...chunker.close()])await this.speak(agentId,playbackId,sentence,controller.signal);
      if(this.active.get(agentId)===controller)this.emit(agentId,{type:'voice_end',playbackId,summary:spokenSummary,sessionName:result.sessionName});
    }catch(error){
      if(!abortError(error)&&this.active.get(agentId)===controller){
        this.emit(agentId,{type:'voice_error',playbackId,message:(error as Error).message});
        const fallback=this.config.language.toLowerCase().startsWith('zh')?'Agent 已完成，等待输入。':'The agent has finished and is ready for input.';
        if(!spokenSummary)try{this.emit(agentId,{type:'voice_summary_delta',playbackId,text:fallback});await this.speak(agentId,playbackId,fallback,controller.signal);this.emit(agentId,{type:'voice_end',playbackId,summary:fallback})}catch{/* The text notification remains available when TTS also fails. */}
        else this.emit(agentId,{type:'voice_end',playbackId,summary:spokenSummary,partial:true});
      }
    }finally{if(this.active.get(agentId)===controller)this.active.delete(agentId)}
  }
  private summaryPrompt(){const language=this.config.language.toLowerCase().startsWith('zh')?'简体中文':'与用户输入相同的主要语言';return `你负责把一次 Pi 编程任务压缩成准确、自然、可直接朗读的完成通知，并在需要时为 Session 命名。\n\n输入是一个 JSON 对象：\n- userPrompt：用户本轮真正想完成的任务。\n- piFinalOutput：Pi 最后一次回复，包含完成情况、改动、验证结果和后续事项。\n- sessionNeedsName：只有为 true 时才需要生成 Session 名称。\n\n先结合 userPrompt 判断目标，再以 piFinalOutput 为事实依据总结。不要把用户的要求误说成已经完成；没有明确证据时不要声称测试通过或任务成功。摘要使用${language}，写 2 到 4 个短句，最多 120 个中文字符或 70 个英文单词。优先交代：是否完成、最重要的结果或修改、测试/验证结果、失败原因，以及用户必须采取的下一步。省略代码、命令、URL、完整路径、哈希、冗长文件清单、日志和 Markdown；不要使用标题、列表、“总结如下”等套话。\n\n如果 sessionNeedsName 为 true，请根据 userPrompt 生成一个具体、简短、便于检索的名称：中文建议 6 到 18 个字，英文建议 3 到 8 个词；使用任务主题或目标，不写“新会话”“任务总结”等空泛名称，不带句号、引号、Emoji 或路径。如果 sessionNeedsName 为 false，sessionName 必须为 null。\n\n只输出一个合法 JSON 对象，不要输出 Markdown 代码块、解释或任何额外文字。有名称时使用 {"summary":"适合直接朗读的摘要","sessionName":"简短名称"}；无需命名时使用 {"summary":"适合直接朗读的摘要","sessionName":null}。summary 必须是 JSON 字符串，sessionName 必须是 JSON 字符串或 null。`}
  private async speak(agentId:string,playbackId:string,text:string,signal:AbortSignal){
    const response=await this.fetcher(endpoint(this.config.speechBaseUrl,'/audio/speech'),{method:'POST',signal,headers:{'content-type':'application/json',...authHeaders(this.config.speechApiKey)},body:JSON.stringify({model:this.config.ttsModel,voice:this.config.ttsVoice,input:text,response_format:this.config.ttsFormat,sample_rate:this.config.sampleRate,stream_format:'audio'})});
    if(!response.ok)throw new Error(`Speech synthesis failed (${response.status}): ${(await response.text()).slice(0,500)}`);
    if(this.config.ttsFormat==='mp3'){
      const audio=Buffer.from(await response.arrayBuffer());if(!audio.length)throw new Error('Speech synthesis returned no audio');
      this.emit(agentId,{type:'voice_audio_chunk',playbackId,encoding:'mp3',audio:audio.toString('base64')});return;
    }
    if(!response.body)throw new Error('Speech synthesis returned no audio');const reader=response.body.getReader();let pending:Buffer|undefined;
    while(true){
      const {done,value}=await reader.read();if(done)break;if(!value?.length)continue;
      const bytes=pending?Buffer.concat([pending,Buffer.from(value)]):Buffer.from(value);const evenLength=bytes.length&~1;
      if(evenLength)this.emit(agentId,{type:'voice_audio_chunk',playbackId,sampleRate:this.config.sampleRate,audio:bytes.subarray(0,evenLength).toString('base64')});
      pending=evenLength<bytes.length?Buffer.from(bytes.subarray(evenLength)):undefined;
    }
    if(pending)throw new Error('Speech synthesis returned an incomplete PCM16 sample');
  }
}
