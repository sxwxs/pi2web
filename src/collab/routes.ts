import {CollabHub} from './hub.js';
import {ValidationError} from './validate.js';
import {COLLAB_ERRORS,type Participant} from './types.js';

export type CollabRouteResult={status:number,payload:unknown,authFailed?:boolean};
export type CollabRouterDeps={
  resolveCwd:(workspaceId:string,relativeCwd:string)=>Promise<string>,
  /** True when the caller presented the Remote Pi pairing code, which means "a human is acting". */
  verifyHuman:(token:string)=>Promise<boolean>
};

const ok=(payload:unknown,status=200):CollabRouteResult=>({status,payload:{data:payload}});
const forbidden=(message:string):CollabRouteResult=>({status:403,payload:{error:{code:COLLAB_ERRORS.forbidden,message}}});

/**
 * HTTP surface for the collaboration hub. Two credentials are accepted:
 * the pairing code (a human, full control) and a participant token (one agent, its own session only).
 * Session creation, participant registration, forced advances, and rulings are human-only by design.
 */
export class CollabRouter {
  constructor(private readonly hub:CollabHub,private readonly deps:CollabRouterDeps){}

  async handle(input:{method:string,url:URL,parts:string[],token:string,body:()=>Promise<unknown>}):Promise<CollabRouteResult|undefined>{
    const {method,url,parts,token}=input;
    if(parts[0]!=='api'||parts[1]!=='v1'||parts[2]!=='collab')return undefined;
    const isHuman=token?await this.deps.verifyHuman(token):false;
    let participant:Participant|undefined;
    if(!isHuman){
      try{participant=this.hub.authenticate(token)}
      catch{return {status:401,payload:{error:{code:'UNAUTHORIZED',message:'A pairing code or participant token is required'}},authFailed:true}}
    }
    try{return await this.route({method,url,parts,body:input.body,isHuman,participant})}
    catch(error){return this.errorResult(error)}
  }

  private async route(ctx:{method:string,url:URL,parts:string[],body:()=>Promise<unknown>,isHuman:boolean,participant?:Participant}):Promise<CollabRouteResult|undefined>{
    const {method,url,parts,isHuman,participant}=ctx;
    const human=(action:string)=>{if(!isHuman)throw Object.assign(new Error(`${action} is reserved for humans`),{code:COLLAB_ERRORS.humanOnly,httpStatus:403})};
    const asParticipant=():Participant=>{if(!participant)throw Object.assign(new Error('This endpoint requires a participant token'),{code:COLLAB_ERRORS.forbidden,httpStatus:403});return participant};
    const scoped=(sessionId:string)=>{if(participant&&participant.sessionId!==sessionId)throw Object.assign(new Error('Collaboration session not found'),{code:COLLAB_ERRORS.sessionNotFound,httpStatus:404})};
    const number=(name:string,fallback:number)=>{const raw=url.searchParams.get(name);const value=raw===null?fallback:Number(raw);return Number.isFinite(value)?value:fallback};

    // /api/v1/collab/escalations[/{id}/resolve]
    if(parts[3]==='escalations'){
      if(method==='GET'&&parts.length===4){human('Listing escalations');return ok(this.hub.listEscalations({status:(url.searchParams.get('status') as any)??undefined,sessionId:url.searchParams.get('sessionId')??undefined}))}
      if(method==='GET'&&parts.length===5){human('Reading an escalation');return ok(this.hub.getEscalation(parts[4]))}
      if(method==='POST'&&parts[5]==='resolve'){human('Ruling on an escalation');return ok(await this.hub.resolveEscalation(parts[4],await ctx.body()))}
      return undefined;
    }
    if(parts[3]!=='sessions')return undefined;

    if(method==='POST'&&parts.length===4){human('Creating a collaboration session');return ok(await this.hub.createSession(await ctx.body(),this.deps.resolveCwd),201)}
    if(method==='GET'&&parts.length===4){
      if(isHuman)return ok(this.hub.listSessions({status:url.searchParams.get('status')??undefined,kind:url.searchParams.get('kind')??undefined,limit:number('limit',50),offset:number('offset',0)}));
      return ok([this.hub.getSession(asParticipant().sessionId)]);
    }
    const sessionId=parts[4];
    if(!sessionId)return undefined;
    scoped(sessionId);
    const tail=parts[5],sub=parts[6];
    // Only these tails have sub-resources. Without this, `POST .../advance/anything` would be treated as an
    // advance, and any future sub-path would be silently answered by the flat handler above it.
    if(sub&&!['participants','issues','debates'].includes(tail??''))return undefined;

    if(method==='GET'&&!tail)return ok({...this.hub.getSession(sessionId),progress:this.hub.progress(sessionId),participants:isHuman?this.hub.participantsForHuman(sessionId):this.hub.store.listParticipants(sessionId)});
    if(tail==='participants'){
      // Sub-resources first: an unguarded register branch would swallow .../participants/{id}/binding and /budget
      // and answer them with "role is required", which is how both repair paths became unreachable over HTTP.
      // .../participants/{participantId}/binding — repairs a seat that was registered with the wrong binding.
      if(method==='POST'&&sub&&parts[7]==='binding'){
        human('Rebinding a participant');
        const {participant:bound,token}=this.hub.rebindParticipant(sessionId,sub,await ctx.body());
        return ok({participant:bound,participantToken:token});
      }
      // .../participants/{participantId}/budget — un-blocks a seat that spent its budget, at any time.
      if(method==='POST'&&sub&&parts[7]==='budget'){
        human('Raising a token budget');
        return ok(this.hub.raiseParticipantBudget(sessionId,sub,await ctx.body()));
      }
      // An unknown sub-resource must 404, not fall through to "register a participant".
      if(sub)return undefined;
      if(method==='POST'){
        human('Registering a participant');
        const {participant:created,token}=this.hub.addParticipant(sessionId,await ctx.body());
        // The plaintext token is returned exactly once; only its hash is stored.
        return ok({participant:created,participantToken:token,briefing:this.hub.digest(created)},201);
      }
      if(method==='GET')return ok(isHuman?this.hub.participantsForHuman(sessionId):this.hub.store.listParticipants(sessionId).map(entry=>({...entry})));
    }
    if(method==='POST'&&tail==='advance'){human('Advancing a phase');return ok(await this.hub.advance(sessionId,await ctx.body()))}
    if(method==='POST'&&tail==='retry-waiting'){human('Retrying waiting Agents');return ok(this.hub.retryWaiting(sessionId,await ctx.body()))}
    if(method==='POST'&&tail==='policy'){human('Changing the policy');return ok(this.hub.updatePolicy(sessionId,await ctx.body()))}
    if(method==='POST'&&tail==='open-round'){human('Opening a round');return ok(await this.hub.openRound(sessionId))}
    if(method==='POST'&&tail==='recheck'){human('Reopening a finished review');return ok(await this.hub.startRecheck(sessionId,await ctx.body()))}
    if(method==='GET'&&tail==='events')return ok(url.searchParams.has('tail')
      ? this.hub.recentEvents(sessionId,number('tail',200),participant)
      : this.hub.events(sessionId,number('since',0),number('limit',500),participant));
    if(method==='GET'&&tail==='digest')return ok(this.hub.digest(asParticipant()));
    if(method==='GET'&&tail==='issues'&&!sub)return ok(isHuman?this.hub.store.listIssues(sessionId):this.hub.listIssues(asParticipant()));
    if(method==='GET'&&tail==='issues'&&sub)return ok(this.hub.issueDetail(sessionId,sub,participant));
    if(method==='POST'&&tail==='issues'&&parts[7]==='withdraw')return ok(await this.hub.withdrawIssue(asParticipant(),sub));
    if(method==='GET'&&tail==='review-consensus')return ok(this.hub.reviewConsensus(sessionId,participant));
    if(method==='POST'&&tail==='issue-votes')return ok(await this.hub.submitIssueVotes(asParticipant(),await ctx.body()));
    if(method==='POST'&&tail==='merge-votes')return ok(await this.hub.submitMergeVotes(asParticipant(),await ctx.body()));
    if(method==='POST'&&tail==='issue-discussions')return ok(await this.hub.submitIssueDiscussions(asParticipant(),await ctx.body()));
    if(method==='POST'&&tail==='nominations')return ok(await this.hub.submitNominations(asParticipant(),await ctx.body()),201);
    if(method==='GET'&&tail==='criteria')return ok(this.hub.criteria(sessionId,participant));
    if(method==='POST'&&tail==='votes')return ok(await this.hub.submitVotes(asParticipant(),await ctx.body()));
    if(method==='GET'&&tail==='votes')return ok(this.hub.votes(sessionId,participant));
    if(method==='POST'&&tail==='scores')return ok(await this.hub.submitScores(asParticipant(),await ctx.body()));
    if(method==='GET'&&tail==='analysis')return ok(this.hub.analysis(sessionId,participant));
    if(method==='GET'&&tail==='debates')return ok(this.hub.store.listDebates(sessionId));
    if(method==='POST'&&tail==='debates'&&parts[7]==='arguments')return ok(await this.hub.submitDebateArgument(asParticipant(),sub,await ctx.body()),201);
    if(method==='POST'&&tail==='finalize'){human('Finalizing a scoring session');return ok(await this.hub.finalizeScoring(sessionId,await ctx.body()))}
    if(method==='POST'&&tail==='ready')return ok(await this.hub.markImplementationReady(asParticipant(),await ctx.body()));
    if(method==='POST'&&tail==='findings')return ok(await this.hub.submitFindings(asParticipant(),await ctx.body()),201);
    if(method==='POST'&&tail==='escalations')return ok(await this.hub.raiseEscalation(asParticipant(),await ctx.body()),202);
    // The report is the human close-out view: it lists every issue and escalation, which would defeat blind
    // collection if a participant token could read it while the round is still open.
    if(method==='GET'&&tail==='report'){human('Reading the session report');const reportSession=this.hub.getSession(sessionId);return ok({session:reportSession,progress:this.hub.progress(sessionId),issues:this.hub.store.listIssues(sessionId),reviewSummary:reportSession.kind==='review'?this.hub.reviewSummary(sessionId):undefined,escalations:this.hub.listEscalations({sessionId})})}
    return undefined;
  }

  /** Every failure carries a stable code so an agent can branch on it instead of parsing prose. */
  private errorResult(error:unknown):CollabRouteResult{
    if(error instanceof ValidationError)return {status:422,payload:{error:{code:error.code,message:error.message,fieldErrors:error.fieldErrors}}};
    const value=error as any,code=value?.code as string|undefined;
    const status=Number.isInteger(value?.httpStatus)?value.httpStatus
      :code===COLLAB_ERRORS.conflict||code===COLLAB_ERRORS.staleBaseline||code===COLLAB_ERRORS.wrongPhase||code===COLLAB_ERRORS.humanRulingFinal?409
      :code===COLLAB_ERRORS.budgetExhausted?429
      :code?.endsWith('NOT_FOUND')?404:400;
    const extra=code===COLLAB_ERRORS.staleBaseline&&value.currentBaseline?{currentBaseline:value.currentBaseline}:{};
    if(status===403&&!code)return forbidden(String(value?.message??'Forbidden'));
    return {status,payload:{error:{code:code??'BAD_REQUEST',message:String(value?.message??'Request failed'),...extra}}};
  }
}
