import {AttentionFeed} from './attention.js';
import type {AgentManager} from './agents.js';
import type {MetadataStore} from './metadata-store.js';

/**
 * HTTP surface for voice clients (e.g. Sotto): stable "session slots", prompt-by-slot, last result, attention feed,
 * plus the allow-list that confines the restricted `voice` token. Everything here is additive.
 */
export const SESSION_SLOTS=6;
export type SessionAlias={slot:number;agentId:string;color?:string;alias?:string};
export type PromptKind='prompt'|'steer'|'follow-up';
type Ctx={method:string;url:URL;parts:string[];body:()=>Promise<any>;role:'full'|'voice'};
export type ApiResult={status:number;payload:unknown};
const SETTING='sessionAliases';
const ok=(data:unknown,status=200):ApiResult=>({status,payload:{data}});
const fail=(status:number,code:string,message:string):ApiResult=>({status,payload:{error:{code,message}}});
const invalid=(message:string)=>Object.assign(new Error(message),{code:'INVALID_REQUEST'});

/** Paths the restricted voice token may call. Deliberately excludes terminals, bash, workspaces, files and collab. */
export function voiceAllowed(method:string,pathname:string){
  const p=pathname;
  if(method==='GET')return p==='/api/v1/system/status'||p==='/api/v1/agents'||p==='/api/v1/session-aliases'||p==='/api/v1/attention'||
    /^\/api\/v1\/agents\/[^/]+\/(state|last-result)$/.test(p)||/^\/api\/v1\/session-aliases\/[^/]+$/.test(p);
  if(method==='POST')return /^\/api\/v1\/agents\/[^/]+\/(prompt|steer|follow-up|abort|extension-response)$/.test(p)||
    /^\/api\/v1\/session-aliases\/[^/]+\/prompt$/.test(p)||/^\/api\/v1\/attention\/[^/]+\/ack$/.test(p);
  return false;
}
/** WebSocket message types a voice token may send. */
export const VOICE_WS_TYPES=new Set(['subscribe','subscribe_all','subscribe_attention','prompt','steer','follow-up','abort']);

export class VoiceApi {
  private idempotent=new Map<string,{at:number;result:unknown}>();
  private readonly idempotencyTtlMs=10*60_000;
  constructor(private readonly deps:{
    metadata:MetadataStore;agents:AgentManager;feed:AttentionFeed;
    /** Sends a command the same way the REST/WS prompt endpoints do (naming, voice bookkeeping, indexing). */
    send:(agentId:string,kind:PromptKind,message:string)=>Promise<void>;
  }){}

  list():SessionAlias[]{
    const raw=this.deps.metadata.getSetting<SessionAlias[]>(SETTING);
    if(!Array.isArray(raw))return [];
    return raw.filter(a=>a&&Number.isInteger(a.slot)&&a.slot>=1&&a.slot<=SESSION_SLOTS&&typeof a.agentId==='string').sort((a,b)=>a.slot-b.slot);
  }
  private describe(alias:SessionAlias){
    let agent:unknown=null;
    try{const r=this.deps.agents.get(alias.agentId).record;agent={status:r.status,sessionName:r.sessionName,workspaceId:r.workspaceId,cwd:r.cwd}}catch{/* agent archived or removed */}
    return {...alias,agent};
  }
  private resolve(ref:string):SessionAlias|undefined{
    const aliases=this.list(),n=Number(ref);
    if(Number.isInteger(n))return aliases.find(a=>a.slot===n);
    const name=decodeURIComponent(ref).trim().toLowerCase();
    return aliases.find(a=>a.alias?.trim().toLowerCase()===name);
  }
  private validate(input:unknown):SessionAlias[]{
    if(!Array.isArray(input))throw invalid('bindings must be an array');
    const slots=new Set<number>(),agents=new Set<string>(),out:SessionAlias[]=[];
    for(const item of input as any[]){
      const slot=Number(item?.slot),agentId=String(item?.agentId??'');
      if(!Number.isInteger(slot)||slot<1||slot>SESSION_SLOTS)throw invalid(`slot must be an integer from 1 to ${SESSION_SLOTS}`);
      if(!agentId)throw invalid('agentId is required');
      if(slots.has(slot))throw invalid(`duplicate slot ${slot}`);
      if(agents.has(agentId))throw invalid('an agent can only occupy one slot');
      slots.add(slot);agents.add(agentId);
      const entry:SessionAlias={slot,agentId};
      if(typeof item.color==='string'&&item.color.length<=32)entry.color=item.color;
      if(typeof item.alias==='string'&&item.alias.trim())entry.alias=item.alias.trim().slice(0,64);
      out.push(entry);
    }
    return out.sort((a,b)=>a.slot-b.slot);
  }
  private gc(){
    const now=Date.now();
    for(const [k,v] of this.idempotent)if(now-v.at>this.idempotencyTtlMs)this.idempotent.delete(k);
    while(this.idempotent.size>500)this.idempotent.delete(this.idempotent.keys().next().value as string);
  }

  async handle(ctx:Ctx):Promise<ApiResult|undefined>{
    const {method,parts,url}=ctx;
    if(parts[0]!=='api'||parts[1]!=='v1')return;
    if(parts[2]==='session-aliases')return this.handleAliases(ctx);
    if(parts[2]==='agents'&&parts[4]==='last-result'&&method==='GET'&&parts.length===5){
      let record;try{record=this.deps.agents.get(parts[3]).record}catch{return fail(404,'AGENT_NOT_FOUND','Agent not found')}
      const r=this.deps.feed.lastResult(parts[3]);
      if(!r)return fail(404,'NO_RESULT','This agent has not finished a task since the server started');
      return ok({...r,sessionName:record.sessionName,status:record.status});
    }
    if(parts[2]==='attention'){
      if(parts.length===3&&method==='GET'){
        const since=Number(url.searchParams.get('since')??0)||0,pending=url.searchParams.get('pending')==='true';
        return ok({items:this.deps.feed.list({sinceSeq:since,pendingOnly:pending}),lastSeq:this.deps.feed.lastSeq()});
      }
      if(parts.length===5&&parts[4]==='ack'&&method==='POST'){
        const body=await ctx.body();
        const item=this.deps.feed.ack(parts[3],typeof body.by==='string'?body.by:ctx.role==='voice'?'voice':'client');
        return item?ok(item):fail(404,'ATTENTION_NOT_FOUND','Attention item not found');
      }
    }
    return;
  }

  private async handleAliases(ctx:Ctx):Promise<ApiResult|undefined>{
    const {method,parts}=ctx;
    const needFull=()=>ctx.role==='full'?undefined:fail(403,'FORBIDDEN','Changing session slots requires the full pairing code');
    const missing=(ref:string)=>fail(404,'ALIAS_NOT_FOUND',`No session bound to ${decodeURIComponent(ref)}`);
    if(parts.length===3){
      if(method==='GET')return ok(this.list().map(a=>this.describe(a)));
      if(method==='PUT'){ // Replaces all bindings. Binding is a human action → full token only.
        const denied=needFull();if(denied)return denied;
        const body=await ctx.body();this.deps.metadata.setSetting(SETTING,this.validate(body.bindings));
        return ok(this.list().map(a=>this.describe(a)));
      }
      return;
    }
    if(parts.length===4){
      const alias=this.resolve(parts[3]);
      if(method==='GET')return alias?ok(this.describe(alias)):missing(parts[3]);
      if(method==='DELETE'){
        const denied=needFull();if(denied)return denied;
        if(!alias)return missing(parts[3]);
        this.deps.metadata.setSetting(SETTING,this.list().filter(x=>x.slot!==alias.slot));return ok({deleted:true});
      }
      return;
    }
    if(parts.length===5&&parts[4]==='prompt'&&method==='POST')return this.promptAlias(ctx);
    return;
  }

  private async promptAlias(ctx:Ctx):Promise<ApiResult>{
    const ref=ctx.parts[3],alias=this.resolve(ref);
    if(!alias)return fail(404,'ALIAS_NOT_FOUND',`No session bound to ${decodeURIComponent(ref)}`);
    const body=await ctx.body(),message=typeof body.message==='string'?body.message.trim():'';
    if(!message)return fail(400,'INVALID_REQUEST','message is required');
    if(message.length>20000)return fail(413,'REQUEST_TOO_LARGE','message is too long');
    const mode=body.mode===undefined?'auto':String(body.mode);
    if(!['auto','prompt','steer','follow-up'].includes(mode))return fail(400,'INVALID_REQUEST','mode must be auto, prompt, steer or follow-up');
    const key=typeof body.idempotencyKey==='string'&&body.idempotencyKey?`${alias.slot}:${body.idempotencyKey.slice(0,128)}`:undefined;
    this.gc();
    if(key&&this.idempotent.has(key))return ok({...(this.idempotent.get(key)!.result as object),duplicate:true});
    let status:string;
    try{status=this.deps.agents.get(alias.agentId).record.status}
    catch{return fail(404,'ALIAS_TARGET_MISSING',`The session bound to slot ${alias.slot} no longer exists; rebind it`)}
    if(status==='stopped')return fail(409,'AGENT_NOT_RUNNING','The agent is stopped');
    // A busy agent gets a queued follow-up instead of a rejected prompt; idle/unloaded agents are started on demand.
    const kind:PromptKind=mode==='auto'?(['streaming','starting','stopping','waiting_for_user'].includes(status)?'follow-up':'prompt'):mode as PromptKind;
    await this.deps.send(alias.agentId,kind,message);
    const result={accepted:true,slot:alias.slot,agentId:alias.agentId,mode:kind,statusBefore:status,
      source:typeof body.source==='string'?body.source.slice(0,32):undefined};
    if(key)this.idempotent.set(key,{at:Date.now(),result});
    return ok(result);
  }
}
