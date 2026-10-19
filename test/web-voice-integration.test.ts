import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const slots=source.slice(source.indexOf('  // Slot numbers belong to a backend'),source.indexOf('  const sessionKeyboard = new'));
const draft=source.slice(source.indexOf('  const handledDrafts = new Set()'),source.indexOf('  function handleAgentEvent('));
const splitResourceKey=(key:string)=>{const index=key.indexOf(':');return {backendId:key.slice(0,index),remoteId:key.slice(index+1)}};

function slotHarness(remote:any[]){
  const backend={id:'a',status:'connected'},other={id:'b',status:'connected'};
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
    await h.syncSessionSlots(h.backend);
    expect(h.sessionKeyboard.getBindings().map((b:any)=>[b.slot,b.agentId])).toEqual([[0,'b:other'],[1,'a:remote-ok']]);
    h.pushSessionSlots();
    expect(h.writes).toEqual([{id:'a',bindings:[{slot:2,agentId:'remote-ok',color:'#abcdef'}]},
      {id:'b',bindings:[{slot:1,agentId:'other',color:'#ff0000'}]}]);
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
});
