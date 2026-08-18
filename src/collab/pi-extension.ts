import {randomUUID} from 'node:crypto';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {StringEnum} from '@earendil-works/pi-ai';
import {Type} from 'typebox';

/** In-process transport owned by the server. No credential or URL enters model context. */
export type CollabToolBridge={
  getTask:(agentId:string)=>Promise<Record<string,unknown>>,
  submit:(agentId:string,action:CollabAction,payload:Record<string,unknown>)=>Promise<unknown>
};

export const COLLAB_ACTIONS=['ready','findings','issue_votes','merge_votes','issue_discussions','nominations','votes','scores','debate_argument','debate_arguments','escalate','withdraw'] as const;
export type CollabAction=typeof COLLAB_ACTIONS[number];
type Aliases=Map<string,string>;

const evidence=Type.Object({
  path:Type.String({minLength:1,description:'Workspace-relative evidence file'}),
  startLine:Type.Optional(Type.Number({minimum:1})),endLine:Type.Optional(Type.Number({minimum:1})),excerpt:Type.Optional(Type.String({maxLength:2000}))
},{additionalProperties:false});
const location=Type.Object({
  path:Type.String({minLength:1,description:'Workspace-relative file containing the finding'}),
  startLine:Type.Optional(Type.Number({minimum:1})),endLine:Type.Optional(Type.Number({minimum:1}))
},{additionalProperties:false});
const finding=Type.Object({
  externalId:Type.Optional(Type.String({maxLength:100})),title:Type.String({minLength:8,maxLength:200}),
  severity:StringEnum(['blocker','critical','major','minor','nit'] as const),
  category:StringEnum(['security','correctness','performance','maintainability','style','test','docs','process'] as const),
  requiredAction:Type.Optional(StringEnum(['must_fix','should_fix','discuss','fyi'] as const)),confidence:Type.Optional(Type.Number({minimum:0,maximum:1})),
  location,evidence:Type.String({minLength:10,maxLength:4000}),impact:Type.Optional(Type.String({maxLength:2000})),suggestion:Type.Optional(Type.String({maxLength:4000}))
},{additionalProperties:false});

const TOOL_FOR_TASK:Record<string,string>={
  implement:'collab_submit_ready',file_findings:'collab_submit_findings',file_findings_optional:'collab_submit_findings',validate_issues:'collab_submit_issue_votes',
  vote_on_merges:'collab_submit_merge_votes',defend_approved_issues:'collab_submit_issue_discussions',reconsider_issue_votes:'collab_submit_issue_votes',
  nominate_criteria:'collab_submit_nominations',vote_on_criteria:'collab_submit_votes',score_rubric:'collab_submit_scores',rescore_contested:'collab_submit_scores',
  debate_contested_scores:'collab_submit_debate_arguments'
};
const TASK_FOR_ACTION:Partial<Record<CollabAction,string[]>>={
  ready:['implement'],findings:['file_findings','file_findings_optional'],issue_votes:['validate_issues','reconsider_issue_votes'],merge_votes:['vote_on_merges'],
  issue_discussions:['defend_approved_issues'],nominations:['nominate_criteria'],votes:['vote_on_criteria'],scores:['score_rubric','rescore_contested'],debate_arguments:['debate_contested_scores']
};
const SUBMIT_TOOLS=[...new Set(Object.values(TOOL_FOR_TASK))];
const OPTIONAL_TOOLS=['collab_escalate','collab_withdraw_issue'];
/** Last-resort scrub for text the hub did not write for the tool flow (mostly error strings). */
const scrub=(text:string)=>text
  .replace(/(?:POST|GET|PUT|DELETE)s?\s+(?:to\s+)?\S*\/api\/v1\/\S+/gi,'use the active collaboration submission tool')
  .replace(/\S*\/api\/v1\/\S+/gi,'the collaboration tool')
  .replace(/[0-9a-f]{8}-[0-9a-f-]{16,}/gi,'[internal reference]');
/** Inline-only Pi extension. It is loaded solely for profile=collab sessions. */
export function createCollabExtension(agentId:string,bridge:CollabToolBridge){
  return function collabExtension(pi:ExtensionAPI){
    let aliases:Aliases=new Map(),lastTask:Record<string,unknown>|undefined,baseTools:string[]|undefined;
    const reference=(id:string,kind:string)=>{
      if(!id)return id;const existing=aliases.get(id);if(existing)return existing;
      const prefix=kind==='issue'?'issue':kind==='criterion'?'criterion':kind==='proposal'?'proposal':kind==='debate'?'debate':kind==='baseline'?'base':kind==='participant'?'reviewer':'ref';
      const value=`${prefix}-${[...aliases.values()].filter(entry=>entry.startsWith(`${prefix}-`)).length+1}`;aliases.set(id,value);return value;
    };
    const redact=(value:unknown):unknown=>{
      if(Array.isArray(value))return value.map(redact);
      if(!value||typeof value!=='object')return typeof value==='string'&&aliases.has(value)?aliases.get(value):value;
      const output:Record<string,unknown>={};
      for(const [name,entry] of Object.entries(value as Record<string,unknown>)){
        if(name==='sessionId')continue;
        const ids=typeof entry==='string'?[entry]:Array.isArray(entry)&&entry.every(item=>typeof item==='string')?entry as string[]:undefined;
        if(ids&&/(Id|Ids)$/.test(name)){
          const kind=/issue/i.test(name)?'issue':/criterion/i.test(name)?'criterion':/proposal/i.test(name)?'proposal':/debate/i.test(name)?'debate':/baseline/i.test(name)?'baseline':/participant|author|reporter|target|raisedBy/i.test(name)?'participant':'ref';
          output[name.replace(/Id(s)?$/,'Ref$1')]=typeof entry==='string'?reference(entry,kind):ids.map(item=>reference(item,kind));
        }else output[name]=redact(entry);
      }
      return output;
    };
    /**
     * Aliases are assigned before the walk, not during it, for two reasons. Seat refs must line up with the panel
     * (so "reviewer-2" means the same agent in every turn and in every argument the model writes), and any id the
     * walk does not recognise as an id-shaped key - `progress.waitingOn` is a plain string array - would otherwise
     * reach the model as a raw hub uuid. Findings borrow the board's own numbering so a ref survives a new turn.
     */
    const seed=(task:Record<string,unknown>)=>{
      const counters=new Map<string,number>();
      const claim=(id:unknown,alias:string)=>{if(typeof id==='string'&&id&&!aliases.has(id))aliases.set(id,alias)};
      for(const seat of Array.isArray(task.panel)?task.panel as Record<string,unknown>[]:[]){
        const role=typeof seat.role==='string'?seat.role:'participant',next=(counters.get(role)??0)+1;
        counters.set(role,next);claim(seat.participantId,`${role}-${next}`);
      }
      const walk=(value:unknown)=>{
        if(Array.isArray(value))return value.forEach(walk);
        if(!value||typeof value!=='object')return;
        const entry=value as Record<string,unknown>;
        if(typeof entry.issueId==='string'&&typeof entry.number==='number')claim(entry.issueId,`issue-${entry.number}`);
        for(const nested of Object.values(entry))walk(nested);
      };
      walk(task);
    };
    /** Hub errors name findings by hub id; the model only knows aliases, so map before falling back to scrubbing. */
    const explain=(text:string)=>{
      let output=text;
      for(const [id,alias] of aliases)output=output.split(id).join(alias);
      return scrub(output);
    };
    const restore=(value:unknown):unknown=>{
      if(Array.isArray(value))return value.map(restore);
      if(!value||typeof value!=='object'){
        if(typeof value!=='string')return value;for(const [id,alias] of aliases)if(alias===value)return id;return value;
      }
      return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,entry])=>[key.replace(/Ref(s)?$/,'Id$1'),restore(entry)]));
    };
    const taskText=(task:Record<string,unknown>)=>{
      const safe=redact(task) as Record<string,unknown>,context={...safe};delete context.task;delete context.instructions;
      const lines=['Local code collaboration task.'];
      if(safe.task)lines.push(`Current action: ${safe.task}.`);
      if(safe.phase)lines.push(`Phase: ${safe.phase}${safe.round!==undefined?`, round ${safe.round}`:''}.`);
      if(typeof safe.instructions==='string')lines.push(`Instructions: ${scrub(safe.instructions)}`);
      if(Object.keys(context).length)lines.push(`Task context:\n${JSON.stringify(context,null,2)}`);
      const submit=TOOL_FOR_TASK[String(safe.task??'')];lines.push(submit?`Complete every required Ref with ${submit}, then end the turn.`:'No submission is required; end the turn.');
      return lines.join('\n');
    };    const currentTask=()=>String(lastTask?.task??'');
    const normalize=(action:CollabAction,payload:Record<string,unknown>)=>{
      const body=restore(payload) as Record<string,unknown>;
      if(action==='findings'){
        if(!body.baselineId&&lastTask?.baseline&&typeof (lastTask.baseline as any).baselineId==='string')body.baselineId=(lastTask.baseline as any).baselineId;
        body.reviewComplete=true;
      }
      if(action==='nominations')body.nominationsComplete=true;
      if(action!=='withdraw')body.clientRequestId=randomUUID();
      return body;
    };
    const rememberBaseTools=()=>{if(!baseTools)baseTools=pi.getActiveTools().filter(name=>!SUBMIT_TOOLS.includes(name)&&!OPTIONAL_TOOLS.includes(name)&&name!=='collab_get_task')};
    const activate=(task?:Record<string,unknown>)=>{
      rememberBaseTools();const taskName=String(task?.task??''),implement=taskName==='implement';
      const builtins=implement?baseTools! : baseTools!.filter(name=>name!=='edit'&&name!=='write');
      const submit=TOOL_FOR_TASK[taskName],optional=taskName&&taskName!=='wait'?['collab_escalate',...(taskName.includes('issue')||taskName==='validate_issues'?['collab_withdraw_issue']:[])]:[];
      pi.setActiveTools([...new Set([...builtins,'collab_get_task',...(submit?[submit]:[]),...optional])]);
    };
    const assertTask=(action:CollabAction)=>{
      const allowed=TASK_FOR_ACTION[action];if(allowed&&!allowed.includes(currentTask()))throw new Error(`The active task is ${currentTask()||'unknown'}, which cannot submit ${action}. Call collab_get_task again.`);
    };
    const acceptedText=(result:unknown)=>`Collaboration submission accepted.${result&&typeof result==='object'?` ${JSON.stringify(redact(result))}`:''}`;
    const registerSubmit=(definition:{name:string,label:string,action:CollabAction,description:string,parameters:any,terminate?:boolean})=>pi.registerTool({
      name:definition.name,label:definition.label,description:definition.description,promptSnippet:definition.description,
      promptGuidelines:[`Use ${definition.name} only after collab_get_task requests it, and include every required Ref exactly once.`],parameters:definition.parameters,
      async execute(_id:string,input:Record<string,unknown>){
        try{assertTask(definition.action);const result=await bridge.submit(agentId,definition.action,normalize(definition.action,input));return {content:[{type:'text',text:acceptedText(result)}],details:{result:redact(result)},terminate:definition.terminate??true}}
        catch(error){const fields=(error as {fieldErrors?:unknown}).fieldErrors;throw new Error(explain(`${(error as Error).message??'Submission failed'}${fields?` ${JSON.stringify(fields)}`:''}`))}
      }
    } as any);

    pi.on('session_start',()=>{baseTools=undefined;lastTask=undefined;aliases=new Map();activate()});
    pi.on('before_agent_start',event=>{
      lastTask=undefined;aliases=new Map();activate();
      return {systemPrompt:`${event.systemPrompt}\n\n## Local collaboration\nThis is a local software-development workflow. Call collab_get_task first after every collaboration wake-up. Use only the collaboration submission tool activated for that task. Inspect code normally, but modify files only for an implement task; review and scoring tasks are read-only. The tools own transport and credentials: never use curl, invent endpoints or identifiers, sleep, or poll.`};
    });
    pi.on('tool_call',(event:any)=>{
      if((event.toolName==='edit'||event.toolName==='write')&&currentTask()!=='implement')return {block:true,reason:'Collaboration review and scoring tasks are read-only. Only an implement task may modify files.'};
    });
    pi.registerTool({
      name:'collab_get_task',label:'Get Collaboration Task',description:'Get the complete current collaboration assignment and activate its exact typed submission tool.',
      promptSnippet:'Fetch the current collaboration assignment before doing any collaboration work',promptGuidelines:['Call collab_get_task first after every pi2web collaboration wake-up.'],parameters:Type.Object({}, {additionalProperties:false}),
      async execute(){aliases=new Map();lastTask=await bridge.getTask(agentId);seed(lastTask);activate(lastTask);return {content:[{type:'text',text:taskText(lastTask)}],details:{task:redact(lastTask)}}}
    });

    registerSubmit({name:'collab_submit_ready',label:'Submit Implementation',action:'ready',description:'Declare the assigned implementation complete with an auditable change summary.',parameters:Type.Object({
      summary:Type.String({minLength:10,maxLength:4000}),changes:Type.Array(Type.Object({path:Type.String({minLength:1}),summary:Type.String({minLength:5})},{additionalProperties:false}),{maxItems:100}),
      codeRef:Type.Optional(Type.Object({commit:Type.Optional(Type.String()),dirtyHash:Type.Optional(Type.String())},{additionalProperties:false}))
    },{additionalProperties:false})});
    registerSubmit({name:'collab_submit_findings',label:'Submit Review Findings',action:'findings',description:'Submit the complete blind review, including every required recheck and all new evidence-backed findings.',parameters:Type.Object({
      findings:Type.Array(finding,{maxItems:50}),rechecks:Type.Optional(Type.Array(Type.Object({issueRef:Type.String(),outcome:StringEnum(['resolved','still_present'] as const),rationale:Type.String({minLength:10,maxLength:4000})},{additionalProperties:false}),{maxItems:100}))
    },{additionalProperties:false})});
    registerSubmit({name:'collab_submit_issue_votes',label:'Submit Issue Votes',action:'issue_votes',description:'Vote on every required issue and optionally propose duplicate groups.',parameters:Type.Object({
      votes:Type.Array(Type.Object({issueRef:Type.String(),stance:StringEnum(['approve','reject'] as const),rationale:Type.Optional(Type.String({maxLength:4000}))},{additionalProperties:false}),{maxItems:200,description:'One vote per Ref in yourRequiredIssueIds; an empty array is only accepted when you owe none'}),
      mergeProposals:Type.Optional(Type.Array(Type.Object({issueRefs:Type.Array(Type.String(),{minItems:2,maxItems:20}),rationale:Type.String({minLength:10,maxLength:2000})},{additionalProperties:false}),{maxItems:50}))
    },{additionalProperties:false})});
    registerSubmit({name:'collab_submit_merge_votes',label:'Submit Merge Votes',action:'merge_votes',description:'Vote on every required duplicate-merge proposal.',parameters:Type.Object({votes:Type.Array(Type.Object({proposalRef:Type.String(),stance:StringEnum(['approve','reject'] as const),rationale:Type.Optional(Type.String({maxLength:4000}))},{additionalProperties:false}),{minItems:1,maxItems:100})},{additionalProperties:false})});
    registerSubmit({name:'collab_submit_issue_discussions',label:'Submit Issue Arguments',action:'issue_discussions',description:'Defend every required finding with evidence, and withdraw the ones you no longer stand by.',parameters:Type.Object({
      discussions:Type.Optional(Type.Array(Type.Object({issueRef:Type.String(),argument:Type.String({minLength:20,maxLength:4000}),respondingTo:Type.Optional(Type.String())},{additionalProperties:false}),{maxItems:200})),
      withdrawals:Type.Optional(Type.Array(Type.Object({issueRef:Type.String(),rationale:Type.String({minLength:10,maxLength:4000,description:'Why you no longer stand by your own finding'})},{additionalProperties:false}),{maxItems:200}))
    },{additionalProperties:false})});
    registerSubmit({name:'collab_submit_nominations',label:'Submit Criteria Nominations',action:'nominations',description:'Submit the complete independent set of proposed scoring criteria.',parameters:Type.Object({nominations:Type.Array(Type.Object({
      externalId:Type.Optional(Type.String()),name:Type.String({minLength:2,maxLength:80}),definition:Type.String({minLength:20,maxLength:2000}),weightSuggestion:Type.Optional(Type.Number({minimum:0,maximum:1})),anchors:Type.Optional(Type.Record(Type.String(),Type.String())),rationale:Type.Optional(Type.String({maxLength:2000}))
    },{additionalProperties:false}),{maxItems:20})},{additionalProperties:false})});
    registerSubmit({name:'collab_submit_votes',label:'Submit Criteria Votes',action:'votes',description:'Vote exactly once on every required rubric candidate.',parameters:Type.Object({votes:Type.Array(Type.Object({
      criterionRef:Type.String(),stance:StringEnum(['approve','reject','abstain'] as const),weight:Type.Optional(Type.Number({minimum:0,maximum:1})),amendment:Type.Optional(Type.String({maxLength:1000})),rationale:Type.Optional(Type.String({maxLength:2000}))
    },{additionalProperties:false}),{minItems:1,maxItems:40})},{additionalProperties:false})});
    registerSubmit({name:'collab_submit_scores',label:'Submit Rubric Scores',action:'scores',description:'Score exactly once every required criterion with rationale and file evidence.',parameters:Type.Object({scores:Type.Array(Type.Object({
      criterionRef:Type.String(),score:Type.Number(),rationale:Type.String({minLength:20,maxLength:4000}),evidence:Type.Array(evidence,{minItems:1,maxItems:20}),confidence:Type.Optional(Type.Number({minimum:0,maximum:1})),changeReason:Type.Optional(Type.String({maxLength:2000}))
    },{additionalProperties:false}),{minItems:1,maxItems:40})},{additionalProperties:false})});
    registerSubmit({name:'collab_submit_debate_arguments',label:'Submit Score Debate',action:'debate_arguments',description:'Submit one evidence-backed position for every required contested-criterion debate.',parameters:Type.Object({arguments:Type.Array(Type.Object({
      debateRef:Type.String(),stance:StringEnum(['raise','lower','hold'] as const),argument:Type.String({minLength:20,maxLength:4000}),evidence:Type.Optional(Type.Array(evidence,{maxItems:20})),respondingTo:Type.Optional(Type.String())
    },{additionalProperties:false}),{minItems:1,maxItems:40})},{additionalProperties:false})});
    registerSubmit({name:'collab_escalate',label:'Escalate Collaboration',action:'escalate',description:'Escalate a genuine blocker or unresolved judgment to the human operator.',terminate:false,parameters:Type.Object({
      kind:StringEnum(['issue_dispute','rubric_dispute','score_dispute','other'] as const),refRef:Type.Optional(Type.String()),summary:Type.String({minLength:20,maxLength:2000}),question:Type.String({minLength:10,maxLength:1000}),options:Type.Optional(Type.Array(Type.String(),{maxItems:10})),urgency:Type.Optional(StringEnum(['low','normal','high'] as const))
    },{additionalProperties:false})});
    registerSubmit({name:'collab_withdraw_issue',label:'Withdraw Issue',action:'withdraw',description:'Withdraw one of your own findings when you no longer stand by it. Does not end your turn.',terminate:false,parameters:Type.Object({issueRef:Type.String()},{additionalProperties:false})});
  };
}
