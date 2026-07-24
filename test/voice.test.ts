import {describe,it,expect} from 'vitest';
import {SentenceChunker,VoiceManager,assistantText,parseSummaryResult,prepareSummaryContext,prepareSummaryInput} from '../src/voice.js';

const stream=(chunks:(string|Uint8Array)[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(typeof chunk==='string'?new TextEncoder().encode(chunk):chunk);controller.close()}});

describe('voice helpers',()=>{
  it('extracts assistant text and removes content unsuitable for a summary',()=>{
    expect(assistantText({role:'assistant',content:[{type:'text',text:'done'},{type:'thinking',thinking:'hidden'}]})).toBe('done');
    const prepared=prepareSummaryInput('结果如下\n```ts\nconst secret = 1\n```\n访问 https://example.com/x');
    expect(prepared).toContain('[代码已省略]');expect(prepared).toContain('链接');expect(prepared).not.toContain('secret');
  });
  it('builds labeled prompt/output context and parses strict JSON results',()=>{
    const context=JSON.parse(prepareSummaryContext({userPrompt:'修复登录问题',finalOutput:'已修复并通过测试'},100));
    expect(context).toEqual({userPrompt:'修复登录问题',piFinalOutput:'已修复并通过测试',sessionNeedsName:true});
    expect(parseSummaryResult('{"summary":"登录问题已修复。","sessionName":"修复登录问题"}')).toEqual({summary:'登录问题已修复。',sessionName:'修复登录问题'});
  });
  it('chunks complete sentences and flushes the tail',()=>{
    const chunker=new SentenceChunker(20);
    expect(chunker.add('任务已经完成。接下来')).toEqual(['任务已经完成。']);
    expect(chunker.add('请确认数据库迁移！')).toEqual(['接下来请确认数据库迁移！']);
    expect(chunker.close()).toEqual([]);
  });
});

describe('voice manager',()=>{
  it('reports TTS-only capability when no transcription model is configured',()=>{
    const manager=new VoiceManager({speechBaseUrl:'http://speech',ttsModel:'tts',ttsVoice:'voice',summaryBaseUrl:'http://llm',summaryModel:'summary'});
    expect(manager.capabilities()).toEqual({tts:true,stt:false});
  });
  it('sends the user prompt and final Pi output, names an unnamed session, and speaks the JSON summary',async()=>{
    const spoken:string[]=[],names:string[]=[];let summaryRequest:any;
    const fetcher:typeof fetch=async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/chat/completions')){summaryRequest=JSON.parse(String(init?.body));return new Response(stream([
        'data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"任务已完成。"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"测试全部通过。\\",\\"sessionName\\":\\"修复登录测试\\"}"}}]}\n\ndata: [DONE]\n\n'
      ]),{status:200,headers:{'content-type':'text/event-stream'}})}
      if(url.endsWith('/audio/speech')){const body=JSON.parse(String(init?.body));spoken.push(body.input);return new Response(stream([new Uint8Array([1,2,3]),new Uint8Array([4])]),{status:200,headers:{'content-type':'audio/pcm'}})}
      throw new Error(`unexpected URL ${url}`);
    };
    const manager=new VoiceManager({speechBaseUrl:'http://speech/v1',sttModel:'stt',ttsModel:'tts',ttsVoice:'voice',summaryBaseUrl:'http://llm/v1',summaryModel:'summary'},fetcher);
    const events:any[]=[];manager.subscribe((_agent,event)=>events.push(event));
    await manager.announce('agent-1',{userPrompt:'Fix the login tests.',finalOutput:'Changed files and tests passed.',setSessionName:name=>{names.push(name)}});
    const llmInput=JSON.parse(summaryRequest.messages[1].content);
    expect(llmInput).toMatchObject({userPrompt:'Fix the login tests.',piFinalOutput:'Changed files and tests passed.',sessionNeedsName:true});
    expect(summaryRequest.messages[0].content).toContain('只输出一个合法 JSON 对象');
    expect(names).toEqual(['修复登录测试']);expect(spoken).toEqual(['任务已完成。','测试全部通过。']);
    expect(events[0].type).toBe('voice_start');expect(events.at(-1).type).toBe('voice_end');
    expect(events.filter(event=>event.type==='voice_summary_delta')).toHaveLength(1);
    const audioEvents=events.filter(event=>event.type==='voice_audio_chunk');expect(audioEvents).toHaveLength(4);
    expect(audioEvents.every(event=>event.sampleRate===24000&&Buffer.from(event.audio,'base64').length%2===0)).toBe(true);
    expect([...Buffer.concat(audioEvents.map(event=>Buffer.from(event.audio,'base64')))]).toEqual([1,2,3,4,1,2,3,4]);
  });
  it('accepts complete MP3 responses from an Edge TTS backend',async()=>{
    let speechRequest:any;
    const fetcher:typeof fetch=async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/chat/completions'))return new Response(stream(['data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"已完成。\\",\\"sessionName\\":null}"}}]}\n\ndata: [DONE]\n\n']),{status:200});
      if(url.endsWith('/audio/speech')){speechRequest=JSON.parse(String(init?.body));return new Response(new Uint8Array([0x49,0x44,0x33,1,2,3]),{headers:{'content-type':'audio/mpeg'}})}
      throw new Error(`unexpected URL ${url}`);
    };
    const manager=new VoiceManager({speechBaseUrl:'http://edge',ttsModel:'edge-tts',ttsVoice:'zh-CN-XiaoxiaoNeural',ttsFormat:'mp3',summaryBaseUrl:'http://llm',summaryModel:'summary'},fetcher);
    const events:any[]=[];manager.subscribe((_agent,event)=>events.push(event));await manager.announce('agent-1','done');
    expect(speechRequest.response_format).toBe('mp3');expect(events[0]).toMatchObject({type:'voice_start',encoding:'mp3'});
    expect(events.find(event=>event.type==='voice_audio_chunk')).toMatchObject({encoding:'mp3',audio:Buffer.from([0x49,0x44,0x33,1,2,3]).toString('base64')});
  });
  it('forwards recordings to an OpenAI-compatible transcription endpoint',async()=>{
    let requestBody:FormData|undefined;
    const fetcher:typeof fetch=async(_input,init)=>{requestBody=init?.body as FormData;return Response.json({text:'你好，Pi',language:'zh'})};
    const manager=new VoiceManager({speechBaseUrl:'http://speech',sttModel:'sensevoice',ttsModel:'tts',ttsVoice:'voice',summaryBaseUrl:'http://llm',summaryModel:'summary'},fetcher);
    await expect(manager.transcribe(new Uint8Array([1,2]),'audio/webm','recording.webm')).resolves.toEqual({text:'你好，Pi',language:'zh'});
    expect(requestBody?.get('model')).toBe('sensevoice');
  });
});
