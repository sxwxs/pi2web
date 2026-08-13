import {CATEGORIES,DEBATE_STANCES,ESCALATION_KINDS,REGISTRABLE_ROLES,REQUIRED_ACTIONS,RESPONSE_TYPES,SEVERITIES,VERDICT_TYPES,VOTE_STANCES} from './types.js';
import {anyJson,arr,bool,num,obj,oneOf,optional,refine,str,withDefault,type FieldError,type Validator} from './validate.js';

/**
 * Request schemas for every collaboration endpoint. They are deliberately strict:
 * a rejected payload comes back with per-field codes so an agent can repair and retry
 * instead of guessing what the hub wanted.
 */

const clientRequestId=()=>str({min:8,max:200});
const usage=()=>optional(obj({inputTokens:optional(num({min:0,max:100_000_000,integer:true})),outputTokens:optional(num({min:0,max:100_000_000,integer:true})),totalTokens:optional(num({min:0,max:100_000_000,integer:true}))}));
const codeLocation=()=>obj({path:str({min:1,max:400}),startLine:optional(num({integer:true,min:1})),endLine:optional(num({integer:true,min:1}))});
/** Evidence must point at a file: an unanchored claim is indistinguishable from a hallucination. */
const evidenceItem=()=>obj({path:str({min:1,max:400}),startLine:optional(num({integer:true,min:1})),endLine:optional(num({integer:true,min:1})),excerpt:optional(str({max:2000}))});

export const findingSchema=obj({
  externalId:optional(str({max:100})),
  title:str({min:8,max:200}),
  severity:oneOf(SEVERITIES),
  category:oneOf(CATEGORIES),
  requiredAction:withDefault(oneOf(REQUIRED_ACTIONS),()=>'should_fix' as const),
  confidence:optional(num({min:0,max:1})),
  location:codeLocation(),
  evidence:str({min:10,max:4000}),
  impact:optional(str({max:2000})),
  suggestion:optional(str({max:4000})),
  targetParticipantId:optional(str({max:100}))
});
export const findingsRequest=obj({
  clientRequestId:clientRequestId(),
  baselineId:str({min:1,max:100}),
  findings:arr(findingSchema,{max:50}),
  reviewComplete:withDefault(bool(),()=>false),
  usage:usage()
});

/** Batched after blind collection: one request validates every issue this reviewer did not report. */
export const issueVotesRequest=obj({
  clientRequestId:clientRequestId(),
  votes:arr(obj({issueId:str({min:1,max:100}),stance:oneOf(['approve','reject'] as const),rationale:optional(str({max:4000}))}),{max:200}),
  mergeProposals:withDefault(arr(obj({issueIds:arr(str({min:1,max:100}),{min:2,max:20}),rationale:str({min:10,max:2000})}),{max:50}),()=>[]),
  complete:withDefault(bool(),()=>true),
  usage:usage()
});
export const mergeVotesRequest=obj({
  clientRequestId:clientRequestId(),
  votes:arr(obj({proposalId:str({min:1,max:100}),stance:oneOf(['approve','reject'] as const),rationale:optional(str({max:4000}))}),{max:100}),
  complete:withDefault(bool(),()=>true),
  usage:usage()
});
export const issueDiscussionsRequest=obj({
  clientRequestId:clientRequestId(),
  discussions:arr(obj({issueId:str({min:1,max:100}),argument:str({min:20,max:4000}),respondingTo:optional(str({max:100}))}),{max:200}),
  complete:withDefault(bool(),()=>true),
  usage:usage()
});

export const responseSchema=obj({
  issueId:str({min:1,max:100}),
  responseType:oneOf(RESPONSE_TYPES),
  rationale:optional(str({max:4000})),
  changes:withDefault(arr(obj({path:str({min:1,max:400}),summary:str({min:5,max:1000})}),{max:50}),()=>[]),
  remaining:optional(str({max:2000})),
  question:optional(str({max:2000})),
  followUpRef:optional(str({max:200})),
  codeRef:optional(obj({commit:optional(str({max:100})),dirtyHash:optional(str({max:200}))})),
  expectedVersion:optional(num({integer:true,min:1}))
});
export const responsesRequest=obj({clientRequestId:clientRequestId(),responses:arr(responseSchema,{min:1,max:50}),usage:usage()});

export const verdictSchema=obj({
  issueId:str({min:1,max:100}),
  verdict:oneOf(VERDICT_TYPES),
  rationale:optional(str({max:4000})),
  expectedVersion:optional(num({integer:true,min:1}))
});
export const verdictsRequest=obj({clientRequestId:clientRequestId(),verdicts:arr(verdictSchema,{min:1,max:50}),usage:usage()});

export const escalationRequest=obj({
  clientRequestId:clientRequestId(),
  kind:oneOf(ESCALATION_KINDS),
  refId:optional(str({max:100})),
  summary:str({min:20,max:2000}),
  positions:withDefault(arr(obj({participantId:str({min:1,max:100}),stance:str({max:200}),rationale:str({min:10,max:2000})}),{max:20}),()=>[]),
  question:str({min:10,max:1000}),
  options:withDefault(arr(str({min:1,max:200}),{max:10}),()=>[]),
  urgency:withDefault(oneOf(['low','normal','high'] as const),()=>'normal' as const),
  usage:usage()
});

/**
 * A scale is only usable as a whole: `{min:10,max:1,step:1}` passes every per-field range check and then
 * produces a session in which every possible score fails validation. The span must be positive and
 * at least one step wide.
 */
const scoringScale=refine(obj({min:num({min:0,max:1000}),max:num({min:1,max:1000}),step:num({min:0.01,max:100})}),scale=>{
  const errors:FieldError[]=[];
  if(scale.max<=scale.min)errors.push({path:'max',code:'OUT_OF_ORDER',message:`Expected max (${scale.max}) to be greater than min (${scale.min})`,expected:`> ${scale.min}`});
  else if(scale.step>scale.max-scale.min)errors.push({path:'step',code:'TOO_LARGE',message:`Expected a step that fits inside the ${scale.min}-${scale.max} range`,expected:`<= ${scale.max-scale.min}`});
  return errors;
});
const scoringPolicyPatch=refine(obj({
  minCriteria:optional(num({integer:true,min:1,max:20})),
  maxCriteria:optional(num({integer:true,min:1,max:20})),
  approvalThreshold:optional(num({min:0.5,max:1})),
  maxVotingRounds:optional(num({integer:true,min:1,max:10})),
  scale:optional(scoringScale),
  convergenceRange:optional(num({min:0,max:1000})),
  maxDebateRounds:optional(num({integer:true,min:0,max:10})),
  blindScoring:optional(bool())
}),patch=>patch.minCriteria!==undefined&&patch.maxCriteria!==undefined&&patch.minCriteria>patch.maxCriteria
  ?[{path:'maxCriteria',code:'OUT_OF_ORDER',message:`Expected maxCriteria (${patch.maxCriteria}) to be at least minCriteria (${patch.minCriteria})`,expected:`>= ${patch.minCriteria}`}]
  :undefined);
export const policyPatch=obj({
  maxIssueRounds:optional(num({integer:true,min:1,max:20})),
  maxTotalRounds:optional(num({integer:true,min:1,max:50})),
  overdueWarningSec:optional(num({integer:true,min:60,max:86_400})),
  autoEscalateOnDeadlock:optional(bool()),
  blindFindings:optional(bool()),
  consensusReview:optional(bool()),
  maxConsensusRounds:optional(num({integer:true,min:1,max:10})),
  implementationFirst:optional(bool()),
  autoReviewOnAgentIdle:optional(bool()),
  tokenBudgetPerParticipant:optional(num({integer:true,min:1000,max:100_000_000})),
  scoring:optional(scoringPolicyPatch)
});

/** The implementer's "I am done, call the reviewers" signal. It is what turns build-then-review into one loop. */
export const readyRequest=obj({
  clientRequestId:clientRequestId(),
  summary:str({min:10,max:4000}),
  changes:withDefault(arr(obj({path:str({min:1,max:400}),summary:str({min:5,max:1000})}),{max:100}),()=>[]),
  codeRef:optional(obj({commit:optional(str({max:100})),dirtyHash:optional(str({max:200}))})),
  usage:usage()
});

export const createSessionRequest=obj({
  kind:oneOf(['review','scoring'] as const),
  title:str({min:3,max:200}),
  workspaceId:str({min:1,max:200}),
  relativeCwd:withDefault(str({max:400}),()=>'.'),
  subject:obj({type:oneOf(['diff','paths','commit_range','free'] as const),value:str({min:1,max:2000}),notes:optional(str({max:4000}))}),
  policy:optional(policyPatch)
});

export const createParticipantRequest=obj({
  /** `human` is not registrable: a human uses the pairing code, not a seat the panel never waits for. */
  role:oneOf(REGISTRABLE_ROLES),
  displayName:str({min:1,max:100}),
  model:optional(str({max:200})),
  /** The local pi2web agent that fills this seat. The hub wakes it; nothing polls the hub. */
  agentId:str({min:1,max:200}),
  tokenBudget:optional(num({integer:true,min:100,max:100_000_000}))
});

export const rebindParticipantRequest=obj({
  /** Hands the seat to another local agent: the bound one died, or was picked by mistake. */
  agentId:str({min:1,max:200}),
  /** Filled by the human UI from the selected Agent's actual capabilities; never typed by the operator. */
  model:optional(str({max:200}))
});

/** Raising a spent budget is its own operation: an escalation ruling can only be used once. */
export const participantBudgetRequest=obj({
  tokenBudget:num({integer:true,min:100,max:100_000_000})
});

export const advanceRequest=obj({
  force:withDefault(bool(),()=>false),
  reason:withDefault(str({max:2000}),()=>'')
});
export const retryWaitingRequest=obj({
  /** Optional UI-selected subset. Busy Agents are always skipped by the hub. */
  participantIds:optional(arr(str({min:1,max:100}),{max:100}))
});

export const resolveEscalationRequest=obj({
  decision:str({min:1,max:2000}),
  rationale:str({min:10,max:4000}),
  /** Optional ruling applied to the referenced issue. `reopen` hands it back to the responder. */
  issueDecision:optional(oneOf(['resolved','wontfix','closed','reopen'] as const)),
  extra:optional(anyJson(16*1024))
});

export type Schema<T>=Validator<T>;

// ---- scoring session payloads ----

export const nominationsRequest=obj({
  clientRequestId:clientRequestId(),
  nominations:arr(obj({
    externalId:optional(str({max:100})),
    name:str({min:2,max:80}),
    definition:str({min:20,max:2000}),
    weightSuggestion:optional(num({min:0,max:1})),
    anchors:optional(obj({},{allowUnknown:true})),
    rationale:optional(str({max:2000}))
  }),{max:20}),
  nominationsComplete:withDefault(bool(),()=>false),
  usage:usage()
});

export const votesRequest=obj({
  clientRequestId:clientRequestId(),
  votes:arr(obj({
    criterionId:str({min:1,max:100}),
    stance:oneOf(VOTE_STANCES),
    weight:optional(num({min:0,max:1})),
    amendment:optional(str({max:1000})),
    rationale:optional(str({max:2000}))
  }),{min:1,max:40}),
  usage:usage()
});

/** Evidence is mandatory and each entry must point at a file: an unanchored score is a guess. */
export const scoresRequest=obj({
  clientRequestId:clientRequestId(),
  scores:arr(obj({
    criterionId:str({min:1,max:100}),
    score:num({min:0,max:1000}),
    rationale:str({min:20,max:4000}),
    evidence:arr(evidenceItem(),{min:1,max:20}),
    confidence:optional(num({min:0,max:1})),
    changeReason:optional(str({max:2000}))
  }),{min:1,max:40}),
  usage:usage()
});

export const debateArgumentRequest=obj({
  clientRequestId:clientRequestId(),
  stance:oneOf(DEBATE_STANCES),
  argument:str({min:20,max:4000}),
  evidence:withDefault(arr(evidenceItem(),{max:20}),()=>[]),
  respondingTo:optional(str({max:100})),
  usage:usage()
});

export const finalizeRequest=obj({
  /** Human overrides for criteria the panel could not settle, keyed by criterionId. */
  rulings:withDefault(arr(obj({criterionId:str({min:1,max:100}),score:num({min:0,max:1000}),rationale:str({min:10,max:2000})}),{max:40}),()=>[])
});
