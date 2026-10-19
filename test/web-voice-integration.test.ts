import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const slots=source.slice(source.indexOf('  // Slot numbers belong to a backend'),source.indexOf('  const sessionKeyboard = new'));
const draft=source.slice(source.indexOf('  const handledDrafts = new Set()'),source.indexOf('  function handleAgentEvent('));
const dispatch=source.slice(source.indexOf('  function handleAgentEvent('),source.indexOf("    if(message.type==='voice_event')"));
const splitResourceKey=(key:string)=>{const index=key.indexOf(':');return {backendId:key.slice(0,index),remoteId:key.slice(index+1)}};

function slotHarness(remote:any[]){
  const backend={id:'a',status:'connected',slotSyncReady:false},other={id:'b',status:'connected',slotSyncReady:true};
  const state={backends:[backend,other]};
  let bindings=[{slot:0,agentId:'b:other',color:'#ff0000'}];
  const writes:any[]=[];
  const sessionKeyboard={getBindings:()=>bindings,replaceBindings:(next:any[])=>{bindings=next}};
  const context={state,sessionKeyboard,splitResourceKey,resourceKey:(b:string,id:string)=>`${b}:${id}`,
    requestBackend:async(id:string,_url:string,options?:any)=>{if(options)writes.push({id,bindings:JSON.parse(options.body).bindings});return remote},
    setTimeout:(callback:()=>void)=>{callback();return 1},clearTimeout:()=>{},console};
  const api=runInNewContext(`${slots}\n({pushSessionSlots,syncSessionSlots})`,context);
  return {...api,backend,sessionKeyboard,writes,replace:(next:any[])=>{bindings=next}};
}

describe('multi-backend voice integration',()=>{
  it('syncs only a backend’s remote IDs and never silently overwrites another backend’s physical slot',async()=>{
    const h=slotHarness([{slot:1,agentId:'remote-conflict'},{slot:2,agentId:'remote-ok',color:'#abcdef'}]);
    h.pushSessionSlots();
    expect(h.writes).toEqual([{id:'b',bindings:[{slot:1,agentId:'other',color:'#ff0000'}]}]);
    h.writes.length=0;
    await h.syncSessionSlots(h.backend);
    expect(h.sessionKeyboard.getBindings().map((b:any)=>[b.slot,b.agentId])).toEqual([[0,'b:other'],[1,'a:remote-ok']]);
    h.pushSessionSlots();
    expect(h.writes).toEqual([{id:'a',bindings:[{slot:2,agentId:'remote-ok',color:'#abcdef'}]},
      {id:'b',bindings:[{slot:1,agentId:'other',color:'#ff0000'}]}]);
  });

  it('treats an empty server slot list as authoritative instead of re-uploading stale local bindings',async()=>{
    const h=slotHarness([]);
    h.replace([{slot:0,agentId:'b:other',color:'#ff0000'},{slot:2,agentId:'a:stale',color:'#eeeeee'}]);
    await h.syncSessionSlots(h.backend);
    expect(h.sessionKeyboard.getBindings().map((b:any)=>b.agentId)).toEqual(['b:other']);
    expect(h.writes).toEqual([]);
  });

  it('never places an untargeted draft in another backend’s composer',async()=>{
    const sent:any[]=[],input={value:'hello',focus:vi.fn(),setSelectionRange:vi.fn(),scrollTop:0,scrollHeight:10};
    const backend={id:'a',ws:{readyState:1,send:(message:string)=>sent.push(JSON.parse(message))}};
    const state:any={selectedKind:'agent',agent:{agentId:'b:other',backendId:'b'},agents:[]};
    const context={state,backendOf:()=>backend,resourceKey:(b:string,id:string)=>`${b}:${id}`,
      WebSocket:{OPEN:1},$:()=>input,toast:vi.fn(),selectAgent:vi.fn(),refreshAgents:vi.fn()};
    const {handleDraftEvent}=runInNewContext(`${draft}\n({handleDraftEvent})`,context);
    const message={backendId:'a',draft:{id:'d1',text:'world',mode:'append'}};
    await handleDraftEvent(message);
    expect(input.value).toBe('hello');expect(sent).toEqual([]);
    state.agent={agentId:'a:some',backendId:'a'};
    await handleDraftEvent(message);
    expect(input.value).toBe('hello world');expect(sent).toEqual([{type:'draft_ack',id:'d1'}]);
    await handleDraftEvent(message);
    expect(input.value).toBe('hello world');expect(sent).toHaveLength(2); // replay re-acks without inserting twice
  });

  it('does not acknowledge a draft if selecting its target ends in a different Agent',async()=>{
    const sent:any[]=[],input={value:'',focus:vi.fn(),setSelectionRange:vi.fn(),scrollTop:0,scrollHeight:0};
    const backend={id:'a',ws:{readyState:1,send:(m:string)=>sent.push(JSON.parse(m))}};
    const state:any={selectedKind:'agent',agent:{agentId:'a:other',backendId:'a'},agents:[{agentId:'a:target'}]};
    const context={state,backendOf:()=>backend,resourceKey:(b:string,id:string)=>`${b}:${id}`,
      WebSocket:{OPEN:1},$:()=>input,toast:vi.fn(),refreshAgents:vi.fn(),
      selectAgent:async()=>{state.agent={agentId:'a:wrong',backendId:'a'}}};
    const {handleDraftEvent}=runInNewContext(`${draft}\n({handleDraftEvent})`,context);
    await handleDraftEvent({backendId:'a',draft:{id:'d2',agentId:'target',text:'wrong',mode:'append'}});
    expect(input.value).toBe('');expect(sent).toEqual([]);
  });

  it('processes targeted drafts in arrival order even if selecting an Agent yields',async()=>{
    const sent:any[]=[],input={value:'',focus:vi.fn(),setSelectionRange:vi.fn(),scrollTop:0,scrollHeight:0};
    const backend={id:'a',ws:{readyState:1,send:(m:string)=>sent.push(JSON.parse(m))}};
    const state:any={selectedKind:'agent',agent:{agentId:'a:other',backendId:'a'},agents:[{agentId:'a:first'},{agentId:'a:second'}]};
    let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve});
    const selected:string[]=[];
    const context={state,backendOf:()=>backend,resourceKey:(b:string,id:string)=>`${b}:${id}`,
      WebSocket:{OPEN:1},$:()=>input,toast:vi.fn(),refreshAgents:vi.fn(),
      selectAgent:async(agent:any)=>{selected.push(agent.agentId);if(agent.agentId==='a:first')await barrier;state.agent={...agent,backendId:'a'}}};
    const {handleAgentEvent,getQueue}=runInNewContext(`${draft}\n${dispatch}\n  }\n({handleAgentEvent,getQueue:()=>draftQueue})`,context);
    handleAgentEvent({backendId:'a',type:'draft_event',draft:{id:'one',agentId:'first',text:'one',mode:'append'}});
    handleAgentEvent({backendId:'a',type:'draft_event',draft:{id:'two',agentId:'second',text:'two',mode:'append'}});
    await Promise.resolve();
    expect(selected).toEqual(['a:first']);
    release();await getQueue();
    expect(selected).toEqual(['a:first','a:second']);
    expect(input.value).toBe('one two');
    expect(sent).toEqual([{type:'draft_ack',id:'one'},{type:'draft_ack',id:'two'}]);
  });
});
