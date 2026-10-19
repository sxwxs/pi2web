import {assistantText} from './voice.js';

/** Recent completed turns for polling voice clients; no replay of mutable acknowledgement state. */
export type AttentionItem={
  id:string;seq:number;kind:'agent_settled';agentId:string;sessionName?:string;createdAt:string;
  data:{userPrompt:string;text:string;textLength:number;truncated:boolean};
};
export type LastResult={text:string;userPrompt:string;settledAt:string};
const clip=(text:string,max:number)=>text.length>max?text.slice(0,max-1)+'…':text;

export class AttentionFeed {
  private items:AttentionItem[]=[];
  private nextSeq=1;
  private lastAssistant=new Map<string,string>();
  private lastPrompt=new Map<string,string>();
  private results=new Map<string,LastResult>();

  list(sinceSeq=0){return this.items.filter(item=>item.seq>sinceSeq)}
  lastSeq(){return this.nextSeq-1}
  lastResult(agentId:string){return this.results.get(agentId)}
  forget(agentId:string){this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);this.results.delete(agentId)}

  ingestAgentEvent(agentId:string,event:{type:string,[key:string]:unknown},context:{sessionName?:string}={}){
    if(event.type==='before_agent_start'||event.type==='agent_start'){
      this.lastAssistant.delete(agentId);
      const prompt=event.type==='before_agent_start'?event.prompt:event.message;
      if(typeof prompt==='string')this.lastPrompt.set(agentId,prompt);
      return;
    }
    if(event.type==='message_end'){
      const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);
      return;
    }
    if((event.type==='agent_end'&&event.aborted===true)||event.type==='agent_settled'&&event.aborted===true){
      this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);return;
    }
    if(event.type!=='agent_settled')return;
    const text=this.lastAssistant.get(agentId),userPrompt=this.lastPrompt.get(agentId)??'';
    this.lastAssistant.delete(agentId);this.lastPrompt.delete(agentId);
    if(!text)return;
    const settledAt=new Date().toISOString();this.results.set(agentId,{text,userPrompt,settledAt});
    const seq=this.nextSeq++;
    this.items.push({id:`att-${seq}`,seq,kind:'agent_settled',agentId,sessionName:context.sessionName,createdAt:settledAt,
      data:{userPrompt:clip(userPrompt,500),text:clip(text,4000),textLength:text.length,truncated:text.length>4000}});
    if(this.items.length>200)this.items.shift();
  }
}
