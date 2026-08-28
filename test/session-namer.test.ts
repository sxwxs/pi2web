import {describe,expect,it} from 'vitest';
import {SessionNamer,parseSessionName} from '../src/session-namer.js';

const completion=(content:string)=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0))};

describe('parseSessionName',()=>{
  it('accepts JSON, fenced JSON, and bare text',()=>{
    expect(parseSessionName('{"sessionName":"修复登录超时"}')).toBe('修复登录超时');
    expect(parseSessionName('```json\n{"sessionName":"重构缓存层"}\n```')).toBe('重构缓存层');
    expect(parseSessionName(' "清理构建脚本" ')).toBe('清理构建脚本');
    expect(parseSessionName('   ')).toBeUndefined();
  });
});

describe('SessionNamer',()=>{
  it('names an unnamed session after it settles, without any voice service',async()=>{
    const calls:{url:string,body:any}[]=[];
    const namer=new SessionNamer({baseUrl:'http://localhost:8313/'},(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return completion('{"sessionName":"修复会话命名"}')}) as any);
    const applied:string[]=[];
    const context={setSessionName:(name:string)=>{applied.push(name)}};
    namer.handleAgentEvent('a1',{type:'agent_start',message:'修一下自动命名'},context);
    namer.handleAgentEvent('a1',{type:'message_end',message:{role:'assistant',content:'已修复并加了测试。'}},context);
    namer.handleAgentEvent('a1',{type:'agent_settled'},context);
    await settle();
    expect(applied).toEqual(['修复会话命名']);
    expect(calls[0].url).toBe('http://localhost:8313/v1/chat/completions');
    expect(calls[0].body.model).toBe('gpt-5-mini');
    expect(JSON.parse(calls[0].body.messages[1].content).userPrompt).toBe('修一下自动命名');
  });

  it('leaves an already named session alone',async()=>{
    let calls=0;
    const namer=new SessionNamer({},(async()=>{calls++;return completion('{"sessionName":"x"}')}) as any);
    const context={sessionName:'已有名字',setSessionName:()=>{throw new Error('must not be called')}};
    namer.handleAgentEvent('a1',{type:'agent_start',message:'hi'},context);
    namer.handleAgentEvent('a1',{type:'agent_settled'},context);
    await settle();
    expect(calls).toBe(0);
  });

  it('reports naming failures instead of throwing',async()=>{
    const events:any[]=[];
    const namer=new SessionNamer({},(async()=>new Response('boom',{status:500})) as any);
    namer.subscribe((_agentId,event)=>events.push(event));
    namer.handleAgentEvent('a1',{type:'agent_start',message:'hi'},{setSessionName:()=>{}});
    namer.handleAgentEvent('a1',{type:'agent_settled'},{setSessionName:()=>{}});
    await settle();
    expect(events[0].type).toBe('session_name_error');
  });
});
