import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {PromptTemplate} from './prompt-templates.js';
import {assistantText, authHeaders, clipSummaryField, deadline, endpoint} from './voice.js';

/**
 * After a run settles, judge whether the person needs to reply and, if so, suggest the reply: a saved Pi
 * prompt template when one fits, otherwise a draft from a chat model. Suggestions are only shown; nothing
 * is ever sent to the Agent from here.
 *
 * One request to an OpenAI Decisions endpoint (`POST /v1/decisions`) asks three independent questions:
 * what the next message should be (nothing / just "continue" / a specific reply), whether the answer is
 * complete, and which template fits. A chat completion drafts the reply only when no template fits.
 */
export type FollowUpSettings = {
  enabled: boolean;
  /** OpenAI-compatible base URL serving both /v1/decisions and /v1/chat/completions. */
  baseUrl: string;
  decisionModel: string;
  draftModel: string;
};
export const DEFAULT_FOLLOW_UP_SETTINGS: FollowUpSettings = {
  enabled: false,
  baseUrl: 'http://localhost:8313/',
  decisionModel: 'gpt-6-luna-decisions',
  draftModel: 'gpt-6.1-terra'
};
/** done: no reply needed; continue: "go ahead" is enough; needs_user: the person must say something specific. */
export type FollowUpOutcome = 'done' | 'continue' | 'needs_user';
export type FollowUpSuggestion =
  | {source: 'template'; name: string; text: string; probability: number}
  | {source: 'draft'; model: string; text: string};
export type FollowUpAdvice = {
  id: string;
  createdAt: number;
  state: 'analyzing' | 'ready' | 'error';
  outcome?: FollowUpOutcome;
  /** Probability of the chosen outcome. */
  probability?: number;
  /** Probability that the agent fully accomplished the request. */
  complete?: number;
  suggestion?: FollowUpSuggestion;
  /** Why the analysis or the draft failed; a ready advice can carry it when only the draft failed. */
  error?: string;
};
export type FollowUpAdvisorOptions = {
  /** The template library the reply is matched against. */
  templates?: () => PromptTemplate[];
  apiKey?: string;
  fetcher?: typeof fetch;
  decisionTimeoutMs?: number;
  draftTimeoutMs?: number;
};

const MAX_TEMPLATES = 50;
const TEMPLATE_THRESHOLD = 0.5;
const NONE = '__none__';
const OUTCOMES: Record<FollowUpOutcome, string> = {
  done: 'Nothing: the request is fully handled, nothing is pending, and the reply raises nothing the user would naturally act on.',
  continue:
    "Just 'continue' or 'yes, go ahead': the agent stopped partway or asked permission for a next step it already proposed, and can carry on without new information or a real decision.",
  needs_user:
    'A specific reply: choose between real alternatives, provide missing information or access, react to new feedback or results (e.g. review comments, test failures), or push back on a wrong, unverified or incomplete answer.'
};
const CONTEXT =
  'The input is one turn of a conversation between a user and an AI coding agent: the user request, then the final reply the agent gave after it finished working (tool calls omitted).';
const DRAFT_PROMPT = `你替用户起草下一条发给 AI 编程 Agent 的消息。输入是一个 JSON：userRequest 是用户本轮的请求，agentReply 是 Agent 完成工作后的最终回复（工具调用已省略），assessment 是自动判断的结果。

要求：
- 使用与 userRequest 相同的语言，用用户的口吻直接对 Agent 说话。
- 具体、简洁：指出缺失、错误或未验证的部分，要求 Agent 做什么、做到什么程度。
- Agent 让用户在方案之间选择或索要信息时，如果从上下文能看出合理的选择就直接给出并说明理由；看不出来的信息用【待填：说明】占位，不要编造。
- 只输出消息正文，不要前言、引号或解释。`;

const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_FOLLOW_UP_SETTINGS'});
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.name === 'TimeoutError'
      ? 'request timed out'
      : error.message
    : String(error);
const userText = (message: any): string | undefined => {
  if (message?.role !== 'user') return;
  if (typeof message.content === 'string') return message.content.trim() || undefined;
  if (Array.isArray(message.content))
    return (
      message.content
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
        .trim() || undefined
    );
};

/** Validates a settings patch on top of the current settings. */
export function mergeFollowUpSettings(current: FollowUpSettings, patch: Record<string, unknown>) {
  const next = {...current};
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw invalid('enabled must be a boolean');
    next.enabled = patch.enabled;
  }
  if ('baseUrl' in patch) {
    const value = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : '';
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid('baseUrl must be an http(s) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || value.length > 500)
      throw invalid('baseUrl must be an http(s) URL');
    next.baseUrl = value;
  }
  for (const key of ['decisionModel', 'draftModel'] as const)
    if (key in patch) {
      const value = typeof patch[key] === 'string' ? (patch[key] as string).trim() : '';
      if (!value || value.length > 200 || /\s/.test(value))
        throw invalid(`${key} must be a model ID without spaces`);
      next[key] = value;
    }
  return next;
}

export class FollowUpAdvisor {
  private emitter = new EventEmitter();
  private settings: FollowUpSettings = {...DEFAULT_FOLLOW_UP_SETTINGS};
  private advice = new Map<string, FollowUpAdvice>();
  private lastPrompt = new Map<string, string>();
  private lastReply = new Map<string, {text: string; failed: boolean}>();
  private running = new Map<string, AbortController>();
  private closed = false;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: FollowUpAdvisorOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }
  getSettings(): FollowUpSettings {
    return {...this.settings};
  }
  get apiKeyConfigured() {
    return !!this.options.apiKey;
  }
  updateSettings(patch: Record<string, unknown>) {
    this.settings = mergeFollowUpSettings(this.settings, patch);
    if (!this.settings.enabled) for (const agentId of [...this.advice.keys()]) this.clear(agentId);
    return this.getSettings();
  }
  /** `advice` is null when the Agent's advice was withdrawn. */
  subscribe(listener: (agentId: string, advice: FollowUpAdvice | null) => void) {
    this.emitter.on('advice', listener);
    return () => this.emitter.off('advice', listener);
  }
  current(agentId: string) {
    return this.advice.get(agentId);
  }
  all() {
    return [...this.advice.entries()];
  }
  /** Withdraw the advice of one Agent, e.g. when the person dismisses it or the Agent goes away. */
  clear(agentId: string) {
    this.running.get(agentId)?.abort();
    this.running.delete(agentId);
    if (this.advice.delete(agentId)) this.emitter.emit('advice', agentId, null);
  }
  close() {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.emitter.removeAllListeners();
  }
  handleAgentEvent(
    agentId: string,
    event: {type: string; [key: string]: unknown},
    context: {profile?: string} = {}
  ) {
    if (this.closed) return;
    // Any new run makes earlier advice obsolete, including one still being prepared.
    if (event.type === 'agent_start') {
      this.clear(agentId);
      this.lastReply.delete(agentId);
      if (typeof event.message === 'string' && event.message.trim())
        this.lastPrompt.set(agentId, event.message.trim());
      return;
    }
    if (event.type === 'message_end') {
      const message = event.message as any,
        prompt = userText(message);
      if (prompt) this.lastPrompt.set(agentId, prompt);
      else if (message?.role === 'assistant')
        this.lastReply.set(agentId, {
          text: assistantText(message) ?? '',
          failed: message.stopReason === 'error' || message.stopReason === 'aborted'
        });
      return;
    }
    if (event.type !== 'agent_settled') return;
    const reply = this.lastReply.get(agentId),
      prompt = this.lastPrompt.get(agentId) ?? '';
    this.lastReply.delete(agentId);
    // Collaboration agents are driven by the hub; cancelled, paused and failed runs speak for themselves.
    if (
      !this.settings.enabled ||
      context.profile === 'collab' ||
      event.aborted ||
      event.paused ||
      !reply?.text ||
      reply.failed
    )
      return;
    void this.analyze(agentId, prompt, reply.text);
  }
  /** Runs the decision and, when needed, the draft. Exposed for tests. */
  async analyze(agentId: string, userRequest: string, agentReply: string) {
    this.running.get(agentId)?.abort();
    const controller = new AbortController(),
      settings = this.getSettings(),
      id = randomUUID();
    this.running.set(agentId, controller);
    const publish = (advice: Omit<FollowUpAdvice, 'id' | 'createdAt'>) => {
      if (controller.signal.aborted || this.closed) return;
      const value = {id, createdAt: Date.now(), ...advice};
      this.advice.set(agentId, value);
      this.emitter.emit('advice', agentId, value);
    };
    publish({state: 'analyzing'});
    try {
      const request = clipSummaryField(userRequest, 12_000),
        reply = clipSummaryField(agentReply, 40_000),
        templates = [...(this.options.templates?.() ?? [])]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_TEMPLATES);
      const decision = await this.decide(settings, request, reply, templates, controller.signal);
      if (decision.outcome !== 'needs_user')
        return publish({
          state: 'ready',
          outcome: decision.outcome,
          probability: decision.probability,
          complete: decision.complete
        });
      const template = decision.template && templates.find(item => item.name === decision.template!.name);
      if (template)
        return publish({
          state: 'ready',
          outcome: 'needs_user',
          probability: decision.probability,
          complete: decision.complete,
          suggestion: {
            source: 'template',
            name: template.name,
            text: template.content,
            probability: decision.template!.probability
          }
        });
      try {
        const text = await this.draft(settings, request, reply, decision, controller.signal);
        publish({
          state: 'ready',
          outcome: 'needs_user',
          probability: decision.probability,
          complete: decision.complete,
          suggestion: {source: 'draft', model: settings.draftModel, text}
        });
      } catch (error) {
        publish({
          state: 'ready',
          outcome: 'needs_user',
          probability: decision.probability,
          complete: decision.complete,
          error: `草拟回复失败：${errorText(error)}`
        });
      }
    } catch (error) {
      publish({state: 'error', error: `跟进判断失败：${errorText(error)}`});
    } finally {
      if (this.running.get(agentId) === controller) this.running.delete(agentId);
    }
  }
  private async post(
    settings: FollowUpSettings,
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal
  ) {
    const response = await this.fetcher(endpoint(settings.baseUrl, path), {
      method: 'POST',
      signal: deadline(timeoutMs, signal),
      headers: {'content-type': 'application/json', ...authHeaders(this.options.apiKey)},
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return (await response.json()) as any;
  }
  private async decide(
    settings: FollowUpSettings,
    userRequest: string,
    agentReply: string,
    templates: PromptTemplate[],
    signal: AbortSignal
  ) {
    const questions: unknown[] = [
      {
        type: 'choice',
        name: 'next',
        instructions: "What should the user's next message to the agent be?",
        choices: Object.entries(OUTCOMES).map(([value, description]) => ({value, description}))
      },
      {
        type: 'predicate',
        name: 'complete',
        instructions:
          'Has the agent actually accomplished everything the user asked for in this request, verified where it matters?'
      }
    ];
    if (templates.length)
      questions.push({
        type: 'choice',
        name: 'template',
        instructions:
          'Which saved prompt template would the user most likely send as the next message? Choose none unless one clearly fits what the user would send next.',
        choices: [
          ...templates.map(template => ({
            value: template.name,
            description: clipSummaryField(
              [template.description, template.content].filter(Boolean).join('\n'),
              600
            )
          })),
          {value: NONE, description: 'None of the templates fits as the next message.'}
        ]
      });
    const result = await this.post(
      settings,
      '/decisions',
      {
        model: settings.decisionModel,
        input: [
          {role: 'developer', content: CONTEXT},
          {role: 'user', content: userRequest || '(unknown)'},
          {role: 'assistant', content: agentReply}
        ],
        questions
      },
      this.options.decisionTimeoutMs ?? 60_000,
      signal
    );
    const answers: any[] = Array.isArray(result?.answers) ? result.answers : [],
      answer = (name: string) => answers.find(item => item?.name === name),
      chosen = (item: any) =>
        item?.type === 'choice' && typeof item.choice === 'string'
          ? {
              value: item.choice as string,
              probability: Number(
                (item.probabilities ?? []).find((option: any) => option?.value === item.choice)
                  ?.probability ?? 0
              )
            }
          : undefined;
    const next = chosen(answer('next'));
    if (!next || !(next.value in OUTCOMES))
      throw new Error(answer('next')?.type === 'refusal' ? 'the decision model refused' : 'no usable answer');
    const complete = answer('complete'),
      template = chosen(answer('template'));
    return {
      outcome: next.value as FollowUpOutcome,
      probability: next.probability,
      complete: complete?.type === 'predicate' ? Number(complete.probability) : undefined,
      template:
        template && template.value !== NONE && template.probability >= TEMPLATE_THRESHOLD
          ? {name: template.value, probability: template.probability}
          : undefined
    };
  }
  private async draft(
    settings: FollowUpSettings,
    userRequest: string,
    agentReply: string,
    decision: {outcome: FollowUpOutcome; complete?: number},
    signal: AbortSignal
  ) {
    const result = await this.post(
      settings,
      '/chat/completions',
      {
        model: settings.draftModel,
        stream: false,
        // Reasoning models spend part of this on hidden reasoning before the reply.
        max_tokens: 8000,
        messages: [
          {role: 'system', content: DRAFT_PROMPT},
          {
            role: 'user',
            content: JSON.stringify({
              userRequest,
              agentReply,
              assessment: {next: decision.outcome, answerComplete: decision.complete}
            })
          }
        ]
      },
      this.options.draftTimeoutMs ?? 120_000,
      signal
    );
    const content = result?.choices?.[0]?.message?.content,
      text = (
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
            : ''
      ).trim();
    if (!text) throw new Error('the draft model returned no text');
    return text;
  }
}
