import {describe,it,expect} from 'vitest';
import {SentenceChunker,VoiceManager,assistantText,prepareSummaryInput} from '../src/voice.js';

const stream=(chunks:(string|Uint8Array)[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(typeof chunk==='string'?new TextEncoder().encode(chunk):chunk);controller.close()}});

describe('voice helpers',()=>{
  it('extracts assistant text and removes content unsuitable for a summary',()=>{
    expect(assistantText({role:'assistant',content:[{type:'text',text:'done'},{type:'thinking',thinking:'hidden'}]})).toBe('done');
    const prepared=prepareSummaryInput('结果如下\n```ts\nconst secret = 1\n```\n访问 https://example.com/x');
    expect(prepared).toContain('[代码已省略]');expect(prepared).toContain('链接');expect(prepared).not.toContain('secret');
  });
  it('chunks complete sentences and flushes the tail',()=>{
    const chunker=new SentenceChunker(20);
    expect(chunker.add('任务已经完成。接下来')).toEqual(['任务已经完成。']);
    expect(chunker.add('请确认数据库迁移！')).toEqual(['接下来请确认数据库迁移！']);
    expect(chunker.close()).toEqual([]);
  });
});

describe('voice manager',()=>{
  it('streams an LLM summary into ordered TTS requests and audio events',async()=>{
    const spoken:string[]=[];
    const fetcher:typeof fetch=async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/chat/completions'))return new Response(stream([
        'data: {"choices":[{"delta":{"content":"任务已完成。"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"测试全部通过。"}}]}\n\ndata: [DONE]\n\n'
      ]),{status:200,headers:{'content-type':'text/event-stream'}});
      if(url.endsWith('/audio/speech')){const body=JSON.parse(String(init?.body));spoken.push(body.input);return new Response(stream([new Uint8Array([1,2,3,4])]),{status:200,headers:{'content-type':'audio/pcm'}})}
      throw new Error(`unexpected URL ${url}`);
    };
    const manager=new VoiceManager({speechBaseUrl:'http://speech/v1',sttModel:'stt',ttsModel:'tts',ttsVoice:'voice',summaryBaseUrl:'http://llm/v1',summaryModel:'summary'},fetcher);
    const events:any[]=[];manager.subscribe((_agent,event)=>events.push(event));
    await manager.announce('agent-1','Changed files and tests passed.');
    expect(spoken).toEqual(['任务已完成。','测试全部通过。']);
    expect(events[0].type).toBe('voice_start');expect(events.at(-1).type).toBe('voice_end');
    expect(events.filter(event=>event.type==='voice_summary_delta')).toHaveLength(2);expect(events.filter(event=>event.type==='voice_audio_chunk')).toHaveLength(2);
    expect(events.filter(event=>event.type==='voice_audio_chunk').every(event=>event.sampleRate===24000)).toBe(true);
  });
  it('forwards recordings to an OpenAI-compatible transcription endpoint',async()=>{
    let requestBody:FormData|undefined;
    const fetcher:typeof fetch=async(_input,init)=>{requestBody=init?.body as FormData;return Response.json({text:'你好，Pi',language:'zh'})};
    const manager=new VoiceManager({speechBaseUrl:'http://speech',sttModel:'sensevoice',ttsModel:'tts',ttsVoice:'voice',summaryBaseUrl:'http://llm',summaryModel:'summary'},fetcher);
    await expect(manager.transcribe(new Uint8Array([1,2]),'audio/webm','recording.webm')).resolves.toEqual({text:'你好，Pi',language:'zh'});
    expect(requestBody?.get('model')).toBe('sensevoice');
  });
});
