import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const draft=source.slice(source.indexOf('  const handledDrafts = new Set()'),source.indexOf('  function handleAgentEvent('));

describe('draft into the current Web UI input',()=>{
  it('never switches Agent and only inserts into the displayed backend',()=>{
    const sent:any[]=[],input={value:'hello',focus:vi.fn(),setSelectionRange:vi.fn(),scrollTop:0,scrollHeight:10};
    const backend={id:'a',ws:{readyState:1,send:(message:string)=>sent.push(JSON.parse(message))}};
    const state:any={selectedKind:'agent',agent:{agentId:'b:other',backendId:'b'}};
    const selectAgent=vi.fn();
    const {handleDraftEvent}=runInNewContext(`${draft}\n({handleDraftEvent})`,{
      state,backendOf:()=>backend,WebSocket:{OPEN:1},$:()=>input,toast:vi.fn(),selectAgent,
    });
    const message={backendId:'a',draft:{id:'one',text:'world',mode:'append'}};
    handleDraftEvent(message);
    expect(input.value).toBe('hello');expect(sent).toEqual([]);
    state.agent={agentId:'a:current',backendId:'a'};
    handleDraftEvent(message);
    expect(input.value).toBe('hello world');expect(sent).toEqual([{type:'draft_ack',id:'one'}]);
    handleDraftEvent(message);
    expect(input.value).toBe('hello world');expect(sent).toHaveLength(2); // replay: re-ack, never insert twice
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it('leaves text pending until the page has an Agent selected',()=>{
    const sent:any[]=[],input={value:'',focus:vi.fn(),setSelectionRange:vi.fn(),scrollTop:0,scrollHeight:0};
    const backend={id:'a',ws:{readyState:1,send:(message:string)=>sent.push(JSON.parse(message))}};
    const state:any={selectedKind:'agent',agent:null};
    const {handleDraftEvent}=runInNewContext(`${draft}\n({handleDraftEvent})`,{
      state,backendOf:()=>backend,WebSocket:{OPEN:1},$:()=>input,toast:vi.fn(),
    });
    const message={backendId:'a',draft:{id:'two',text:'memo',mode:'replace'}};
    handleDraftEvent(message);
    expect(input.value).toBe('');expect(sent).toEqual([]);
    state.agent={agentId:'a:current',backendId:'a'};
    handleDraftEvent(message);
    expect(input.value).toBe('memo');expect(sent).toEqual([{type:'draft_ack',id:'two'}]);
  });
});
