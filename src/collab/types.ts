/** Shared contracts for the multi-agent collaboration hub. Everything crossing the HTTP boundary is defined here. */

export type CollabKind='review'|'scoring';
export type SessionStatus='active'|'finished'|'aborted';
/** Review phases. `stalled` is a flag on the session, never a phase: timeouts must not advance anything. */
export type ReviewPhase='draft'|'implementing'|'collecting'|'consolidating'|'responding'|'adjudicating'|'awaiting_human'|'finished';
export type ScoringPhase='nominating'|'consolidating'|'voting'|'rubric_locked'|'scoring'|'analysis'|'debating'|'rescoring'|'awaiting_human'|'finalized';
export type CollabPhase=ReviewPhase|ScoringPhase;
export const REVIEW_PHASES:ReviewPhase[]=['draft','implementing','collecting','consolidating','responding','adjudicating','awaiting_human','finished'];
export const SCORING_PHASES:ScoringPhase[]=['nominating','consolidating','voting','rubric_locked','scoring','analysis','debating','rescoring','awaiting_human','finalized'];

export type Role='implementer'|'reviewer'|'moderator'|'human';
export const ROLES:Role[]=['implementer','reviewer','moderator','human'];
/**
 * Roles a *seat* may be registered with. `human` is deliberately excluded: a human acts with the pairing
 * code, and a `human`-role participant token would hold nominate/vote/score capabilities while
 * `scoringPanel()` never waits for it — its submissions would move a tally nobody is waiting on.
 */
export const REGISTRABLE_ROLES:Role[]=['implementer','reviewer','moderator'];
/** Permissions are capability-based so symmetric (reverse) review needs no second code path. */
export type Capability='file_finding'|'respond'|'verdict'|'withdraw'|'nominate'|'vote'|'score'|'debate'|'clarify'|'merge'|'escalate';
export const CAPABILITIES:Record<Role,Capability[]>={
  implementer:['file_finding','respond','verdict','withdraw','clarify','escalate'],
  reviewer:['file_finding','respond','verdict','withdraw','nominate','vote','score','debate','clarify','escalate'],
  moderator:['file_finding','respond','verdict','withdraw','merge','clarify','escalate'],
  human:['file_finding','respond','verdict','withdraw','nominate','vote','score','debate','clarify','merge','escalate']
};
export const can=(role:Role,capability:Capability)=>CAPABILITIES[role]?.includes(capability)??false;

export type ParticipantState='active'|'left'|'budget_exhausted';

export type Severity='blocker'|'critical'|'major'|'minor'|'nit';
export const SEVERITIES:Severity[]=['blocker','critical','major','minor','nit'];
export type Category='security'|'correctness'|'performance'|'maintainability'|'style'|'test'|'docs'|'process';
export const CATEGORIES:Category[]=['security','correctness','performance','maintainability','style','test','docs','process'];
export type RequiredAction='must_fix'|'should_fix'|'discuss'|'fyi';
export const REQUIRED_ACTIONS:RequiredAction[]=['must_fix','should_fix','discuss','fyi'];

export type IssueStatus='open'|'answered'|'resolved'|'escalated'|'human_ruled'|'wontfix'|'closed'|'duplicate'|'withdrawn';
export const ISSUE_STATUSES:IssueStatus[]=['open','answered','resolved','escalated','human_ruled','wontfix','closed','duplicate','withdrawn'];
/** Statuses that still block the session from finishing. */
export const OPEN_ISSUE_STATUSES:IssueStatus[]=['open','answered','escalated'];
export type ResponseType='fixed'|'partially_fixed'|'rejected'|'needs_info'|'deferred';
export const RESPONSE_TYPES:ResponseType[]=['fixed','partially_fixed','rejected','needs_info','deferred'];
export type VerdictType='accept'|'reject'|'needs_info'|'escalate';
export const VERDICT_TYPES:VerdictType[]=['accept','reject','needs_info','escalate'];

export type EscalationKind='issue_dispute'|'rubric_dispute'|'score_dispute'|'budget_exhausted'|'other';
export const ESCALATION_KINDS:EscalationKind[]=['issue_dispute','rubric_dispute','score_dispute','budget_exhausted','other'];
export type EscalationStatus='pending'|'resolved'|'dismissed';
export type Urgency='low'|'normal'|'high';

export type VoteStance='approve'|'reject'|'abstain';
export const VOTE_STANCES:VoteStance[]=['approve','reject','abstain'];
export type DebateStance='raise'|'lower'|'hold'|'clarify';
export const DEBATE_STANCES:DebateStance[]=['raise','lower','hold','clarify'];
export type CriterionState='candidate'|'approved'|'rejected';

export type ScoringPolicy={
  minCriteria:number;maxCriteria:number;approvalThreshold:number;maxVotingRounds:number;
  scale:{min:number;max:number;step:number};convergenceRange:number;maxDebateRounds:number;blindScoring:boolean;
};
export type CollabPolicy={
  maxIssueRounds:number;
  maxTotalRounds:number;
  /** Only drives the `stalled` flag, warnings, and mail. It never advances a phase. */
  overdueWarningSec:number;
  autoEscalateOnDeadlock:boolean;
  blindFindings:boolean;
  /** Build-then-review: the session opens in `implementing` and the reviewers are only called once the code is ready. */
  implementationFirst:boolean;
  /** With implementationFirst, a managed implementer going idle after its `implement` task counts as "ready". */
  autoReviewOnAgentIdle:boolean;
  tokenBudgetPerParticipant:number;
  scoring:ScoringPolicy;
};
/** approvalThreshold is "two thirds" with a little headroom, so an exact 2-of-3 vote passes. */
export const DEFAULT_POLICY:CollabPolicy={
  maxIssueRounds:3,maxTotalRounds:6,overdueWarningSec:1800,autoEscalateOnDeadlock:true,blindFindings:true,
  implementationFirst:false,autoReviewOnAgentIdle:true,
  tokenBudgetPerParticipant:600_000,
  scoring:{minCriteria:4,maxCriteria:8,approvalThreshold:0.66,maxVotingRounds:3,scale:{min:0,max:10,step:0.5},convergenceRange:2,maxDebateRounds:2,blindScoring:true}
};

export type CollabSubject={type:'diff'|'paths'|'commit_range'|'free';value:string;notes?:string};
export type StalledInfo={since:string;waitingOn:string[]};
export type CollabSession={
  sessionId:string;kind:CollabKind;title:string;workspaceId:string;cwd:string;
  subject:CollabSubject;phase:CollabPhase;round:number;debateRound:number;policy:CollabPolicy;
  status:SessionStatus;stalled?:StalledInfo;outcome?:Record<string,unknown>;
  createdAt:string;updatedAt:string;
};
export type Participant={
  participantId:string;sessionId:string;role:Role;displayName:string;model?:string;
  /** Every seat is a local pi2web agent that the hub wakes itself; there is no self-service participation. */
  agentId:string;state:ParticipantState;
  tokenBudget:number;tokensUsed:number;tokensEstimated:boolean;
  createdAt:string;lastSeenAt?:string;
};
export type CollabEvent={sessionId:string;sequence:number;eventId:string;type:string;actorId?:string;payload:Record<string,unknown>;createdAt:string};
export type CodeLocation={path:string;startLine?:number;endLine?:number};
export type Evidence={path:string;startLine?:number;endLine?:number;excerpt?:string};
export type Baseline={baselineId:string;sessionId:string;round:number;vcs:string;commit?:string;range?:string;dirtyHash?:string;paths:string[];capturedAt:string};
export type Issue={
  issueId:string;sessionId:string;externalId?:string;reporterId:string;targetParticipantId:string;
  title:string;severity:Severity;category:Category;requiredAction:RequiredAction;confidence?:number;
  location:CodeLocation;evidence?:string;impact?:string;suggestion?:string;baselineId:string;
  status:IssueStatus;round:number;version:number;mergedInto?:string;createdAt:string;updatedAt:string;
};
export type IssueMessageKind='response'|'verdict'|'note'|'ruling';
export type IssueMessage={messageId:string;issueId:string;round:number;authorId:string;kind:IssueMessageKind;payload:Record<string,unknown>;createdAt:string};
export type Escalation={
  escalationId:string;sessionId:string;kind:EscalationKind;refId?:string;raisedBy:string;summary:string;
  positions:{participantId:string;stance:string;rationale:string}[];question:string;options:string[];
  urgency:Urgency;status:EscalationStatus;decision?:Record<string,unknown>;resolvedBy?:string;
  createdAt:string;resolvedAt?:string;
};
export type Criterion={criterionId:string;sessionId:string;state:CriterionState;name:string;definition:string;anchors?:Record<string,string>;weight?:number;source?:Record<string,unknown>;round:number;createdAt:string};
export type Vote={voteId:string;sessionId:string;criterionId:string;participantId:string;round:number;stance:VoteStance;weight?:number;amendment?:string;rationale?:string;createdAt:string};
export type Score={scoreId:string;sessionId:string;criterionId:string;participantId:string;round:number;score:number;rationale:string;evidence:unknown[];confidence?:number;changeReason?:string;createdAt:string};
export type DebateArgument={argumentId:string;debateId:string;participantId:string;stance:DebateStance;argument:string;evidence:unknown[];respondingTo?:string;createdAt:string};
export type Debate={debateId:string;sessionId:string;criterionId:string;round:number;status:'open'|'closed';arguments:DebateArgument[];createdAt:string};
/** A queued wake-up. It is acked as soon as the hub has told the agent about it. */
export type InboxItem={itemId:string;sessionId:string;participantId:string;type:string;payload:Record<string,unknown>;createdAt:string;ackedAt?:string};

/** Error codes returned to agents. Keep them stable: agents branch on these strings. */
export const COLLAB_ERRORS={
  validationFailed:'VALIDATION_FAILED',
  evidenceRequired:'EVIDENCE_REQUIRED',
  sessionNotFound:'COLLAB_SESSION_NOT_FOUND',
  participantNotFound:'COLLAB_PARTICIPANT_NOT_FOUND',
  issueNotFound:'COLLAB_ISSUE_NOT_FOUND',
  escalationNotFound:'COLLAB_ESCALATION_NOT_FOUND',
  forbidden:'COLLAB_FORBIDDEN',
  humanOnly:'COLLAB_HUMAN_ONLY',
  wrongPhase:'COLLAB_WRONG_PHASE',
  conflict:'COLLAB_CONFLICT',
  staleBaseline:'STALE_BASELINE',
  noCodeChange:'NO_CODE_CHANGE',
  budgetExhausted:'TOKEN_BUDGET_EXHAUSTED',
  humanRulingFinal:'HUMAN_RULING_FINAL',
  scoresSealed:'SCORES_SEALED',
  criterionNotFound:'COLLAB_CRITERION_NOT_FOUND',
  debateNotFound:'COLLAB_DEBATE_NOT_FOUND'
} as const;
