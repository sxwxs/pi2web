import {EventEmitter} from 'node:events';
import {assistantText} from './voice.js';

export type AttentionKind='agent_settled'|'needs_input'|'collab_escalation';
export type AttentionPriority='low'|'normal'|'high';
export type AttentionItem={
  id:string;seq:number;kind:AttentionKind;priority:AttentionPriority;
  /** True when the human has to answer something (dialog, escalation) rather than merely be told. */
  requiresResponse:boolean;
  agentId?:string;sessionName?:string;createdAt:string;
  /** Set when the underlying request no longer needs anything (dialog answered / timed out). */
  resolvedAt?:string;ackedAt?:string;ackedBy?:string;
  data:Record<string,unknown>;
};
export type AttentionInput=Omit<AttentionItem,'id'|'seq'|'createdAt'|'resolvedAt'|'ackedAt'|'ackedBy'>&{dedupeKey?:string};
export type AttentionChange='new'|'updated';
export type LastResult={text:string;userPrompt:string;settledAt:string};

const clip=(value:string,max:number)=>value.length>max?value.slice(0,max-1)+'…':value;

/**
 * Normalizes "something needs the human" signals from every agent into one bounded, ack-able feed
 * (finished tasks, pending extension dialogs, collab escalations). In memory only, like activity snapshots.
 */
export class AttentionFeed {
  private items:AttentionItem[]=[];private nextSeq=1;private readonly max=200;
  private byKey=new Map<string,string>();
  private lastAssistant=new Map<string,string>();private lastPrompt=new Map<string,string>();private results=new Map<string,LastResult>();
  private emitter=new EventEmitter();
  constructor(){this.emitter.setMaxListeners(0)}

  add(input:AttentionInput):AttentionItem{
    const {dedupeKey,...rest}=input;
    if(dedupeKey){const existing=this.get(this.byKey.get(dedupeKey)??'');if(existing&&!existing.resolvedAt)return existing}
    const seq=this.nextSeq++,item:AttentionItem={...rest,id:`att-${seq}`,seq,createdAt:new Date().toISOString()};
    this.items.push(item);if(dedupeKey)this.byKey.set(dedupeKey,item.id);
    while(this.items.length>this.max){const old=this.items.shift()!;for(const [key,id] of this.byKey)if(id===old.id)this.byKey.delete(key)}
    this.emitter.emit('change','new' satisfies AttentionChange,item);
    return item;
  }
  get(id:string){return this.items.find(item=>item.id===id)}
  list(options:{sinceSeq?:number,pendingOnly?:boolean}={}){
    const since=options.sinceSeq??0;
    return this.items.filter(item=>item.seq>since&&(!options.pendingOnly||(!item.ackedAt&&!item.resolvedAt)));
  }
  lastSeq(){return this.nextSeq-1}
  /** Idempotent: the first acknowledgement wins so several clients do not all keep ringing. */
  ack(id:string,by='client'):AttentionItem|undefined{
    const item=this.get(id);if(!item)return;
    if(!item.ackedAt){item.ackedAt=new Date().toISOString();item.ackedBy=clip(by,64);this.emitter.emit('change','updated' satisfies AttentionChange,item)}
    return item;
  }
  resolveByKey(dedupeKey:string){
    const item=this.get(this.byKey.get(dedupeKey)??'');if(!item||item.resolvedAt)return;
    item.resolvedAt=new Date().toISOString();this.emitter.emit('change','updated' satisfies AttentionChange,item);
  }
  subscribe(listener:(change:AttentionChange,item:AttentionItem)=>void){this.emitter.on('change',listener);return()=>this.emitter.off('change',listener)}
  lastResult(agentId:string){return this.results.get(agentId)}
  forget(agentId:string){this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);this.results.delete(agentId)}

  /** Feed every agent event through here (server wires it to `agents.subscribeAll`). */
  ingestAgentEvent(agentId:string,event:{type:string,[key:string]:unknown},context:{sessionName?:string}={}){
    switch(event.type){
      case 'before_agent_start':if(typeof event.prompt==='string')this.lastPrompt.set(agentId,event.prompt);return;
      case 'agent_start':if(typeof event.message==='string')this.lastPrompt.set(agentId,event.message);return;
      case 'message_end':{const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);return}
      case 'agent_settled':{
        const text=this.lastAssistant.get(agentId);if(!text)return;
        const userPrompt=this.lastPrompt.get(agentId)??'';
        this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);
        const settledAt=new Date().toISOString();this.results.set(agentId,{text,userPrompt,settledAt});
        this.add({kind:'agent_settled',priority:'normal',requiresResponse:false,agentId,sessionName:context.sessionName,
          data:{userPrompt:clip(userPrompt,500),text:clip(text,4000),textLength:text.length,truncated:text.length>4000}});
        return;
      }
      case 'extension_ui_request':{
        if(typeof event.requestId!=='string')return;
        const {type:_type,...request}=event;
        const safe=JSON.stringify(request).length>8000?{requestId:event.requestId,kind:event.kind,title:event.title,truncated:true}:request;
        this.add({kind:'needs_input',priority:'high',requiresResponse:true,agentId,sessionName:context.sessionName,dedupeKey:`dialog:${event.requestId}`,
          data:{requestId:event.requestId,request:safe}});
        return;
      }
      case 'extension_ui_response':if(typeof event.requestId==='string')this.resolveByKey(`dialog:${event.requestId}`);return;
    }
  }
}
