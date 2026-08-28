import {randomUUID} from 'node:crypto';
import {assistantText} from './voice.js';

export type MailNotifierConfig={
  endpoint:string;
  apiKey:string;
  recipient:string;
  senderId?:string;
  priority?:number;
  timeoutMs?:number;
};
export type MailNotificationSettings={
  enabled:boolean;
  aggregationDelaySeconds:number;
  includeResponse:boolean;
  includeSessionDetails:boolean;
  /** Collaboration escalations and stalls are sent immediately; they are never aggregated. */
  collabEscalations:boolean;
};
export type MailNotificationContext={sessionName?:string;workspaceLabel?:string;cwd?:string};
type Fetcher=typeof fetch;
type PendingNotification={agentId:string;finalOutput:string;context:MailNotificationContext};

const defaultSettings:MailNotificationSettings={enabled:true,aggregationDelaySeconds:0,includeResponse:true,includeSessionDetails:true,collabEscalations:true};
const clip=(value:string,max:number)=>value.length<=max?value:`${value.slice(0,max)}\n\n[内容过长，已截断]`;
const oneLine=(value:string,max:number)=>value.replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim().slice(0,max);

export class MailNotifier{
  private lastAssistant=new Map<string,string>();
  private queue:PendingNotification[]=[];
  private timer?:ReturnType<typeof setTimeout>;
  private pending=new Set<Promise<void>>();
  private closed=false;
  private settings:MailNotificationSettings={...defaultSettings};
  private readonly config:Required<Pick<MailNotifierConfig,'priority'|'timeoutMs'>>&MailNotifierConfig;
  constructor(config:MailNotifierConfig,private fetcher:Fetcher=fetch){this.config={priority:100,timeoutMs:15_000,...config}}
  getSettings(){return {...this.settings}}
  updateSettings(value:Partial<MailNotificationSettings>){
    const next={...this.settings,...value};
    next.enabled=Boolean(next.enabled);next.includeResponse=Boolean(next.includeResponse);next.includeSessionDetails=Boolean(next.includeSessionDetails);next.collabEscalations=Boolean(next.collabEscalations);
    next.aggregationDelaySeconds=Math.trunc(Number(next.aggregationDelaySeconds));
    if(!Number.isFinite(next.aggregationDelaySeconds)||next.aggregationDelaySeconds<0||next.aggregationDelaySeconds>86400)throw Object.assign(new Error('aggregationDelaySeconds must be an integer between 0 and 86400'),{code:'INVALID_MAIL_NOTIFICATION_SETTINGS'});
    this.settings=next;
    if(!next.enabled){this.clearTimer();this.queue=[];return this.getSettings()}
    if(this.queue.length){this.clearTimer();this.scheduleFlush()}
    return this.getSettings();
  }
  handleAgentEvent(agentId:string,event:{type:string,[key:string]:unknown},context:MailNotificationContext={}){
    if(this.closed)return;
    if(event.type==='message_end'){const text=assistantText(event.message);if(text)this.lastAssistant.set(agentId,text);return}
    if(event.type!=='agent_settled')return;
    const finalOutput=this.lastAssistant.get(agentId)??'';this.lastAssistant.delete(agentId);
    if(!this.settings.enabled)return;
    this.queue.push({agentId,finalOutput,context});
    if(!this.timer)this.scheduleFlush();
  }
  /**
   * Fire-and-forget notification that bypasses the agent-completion queue. Used by the collaboration hub:
   * a pending human ruling blocks the whole session, so it must not wait for the aggregation window.
   */
  notifyCollab(input:{subject:string,text:string}){
    if(this.closed||!this.settings.enabled||!this.settings.collabEscalations)return;
    const job=this.sendMail(input.subject,clip(input.text,24_000),{kind:'collab'}).catch(error=>console.error(`MailDispatch collaboration notification failed: ${(error as Error).message}`));
    this.pending.add(job);void job.finally(()=>this.pending.delete(job));
    return job;
  }
  async close(){
    this.closed=true;this.clearTimer();
    if(this.queue.length)await this.flushQueue();
    await Promise.allSettled([...this.pending]);this.lastAssistant.clear();
  }
  private scheduleFlush(){
    const delay=this.settings.aggregationDelaySeconds*1000;
    if(delay<=0){this.startFlush();return}
    this.timer=setTimeout(()=>{this.timer=undefined;this.startFlush()},delay);this.timer.unref?.();
  }
  private startFlush(){
    const job=this.flushQueue().catch(error=>console.error(`MailDispatch notification failed: ${(error as Error).message}`));
    this.pending.add(job);void job.finally(()=>this.pending.delete(job));
  }
  private async flushQueue(){
    const items=this.queue.splice(0);if(!items.length)return;
    await this.sendBatch(items);
    if(this.queue.length&&!this.timer&&!this.closed)this.scheduleFlush();
  }
  private clearTimer(){if(this.timer){clearTimeout(this.timer);this.timer=undefined}}
  private async sendBatch(items:PendingNotification[]){
    const includeResponse=this.settings.includeResponse,includeSessionDetails=this.settings.includeSessionDetails,count=items.length;
    let subject=`[Remote Pi] ${count>1?`${count} 个 Agent 任务`:'Agent 任务'}已完成`;
    if(count===1&&includeSessionDetails){const label=oneLine(items[0].context.sessionName||'',80);if(label)subject=`[Remote Pi] ${label}已完成`}
    let text:string;
    if(!includeResponse&&!includeSessionDetails)text=count>1?`${count} 个 Agent 任务已完成。`:'有 Agent 任务完成。';
    else text=items.map((item,index)=>{
      const lines=count>1?[`任务 ${index+1}`]:[];
      if(includeSessionDetails){lines.push(`Session：${item.context.sessionName?.trim()||'未命名'}`);if(item.context.cwd)lines.push(`路径：${item.context.cwd}`)}
      if(includeResponse){if(lines.length)lines.push('');lines.push('Agent 回复：',clip(item.finalOutput.trim()||'（没有可用的最终文本回复）',24_000))}
      return lines.join('\n');
    }).join('\n\n--------------------\n\n');
    await this.sendMail(subject,text,{task_count:count});
  }
  private async sendMail(subject:string,text:string,metadata:Record<string,unknown>={}){
    const payload:Record<string,unknown>={
      to:[this.config.recipient],subject,text,priority:this.config.priority,purpose:'transactional',
      metadata:{source:'remote-pi',...metadata,notification_id:randomUUID()}
    };
    if(this.config.senderId)payload.sender_id=this.config.senderId;
    const response=await this.fetcher(this.config.endpoint,{method:'POST',signal:AbortSignal.timeout(this.config.timeoutMs),headers:{authorization:`Bearer ${this.config.apiKey}`,'content-type':'application/json; charset=utf-8',accept:'application/json','idempotency-key':randomUUID()},body:JSON.stringify(payload)});
    if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
    const result:any=await response.json().catch(()=>undefined);if(!result?.ok)throw new Error('MailDispatch returned an invalid response');
  }
}
