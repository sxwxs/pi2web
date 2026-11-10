import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {Check} from 'typebox/value';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};
import {
  FollowUpAdvisor,
  mergeFollowUpSettings,
  DEFAULT_FOLLOW_UP_SETTINGS
} from '../src/follow-up-advisor.js';
import type {PromptTemplate} from '../src/prompt-templates.js';
import {PromptTemplateStore} from '../src/prompt-templates.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';

const template = (name: string, description: string, content = `${description} content`): PromptTemplate => ({
  name,
  description,
  content,
  updatedAt: '2026-11-10T00:00:00.000Z'
});
const choice = (name: string, chosen: string, probability: number) => ({
  type: 'choice',
  name,
  choice: chosen,
  probabilities: [{value: chosen, probability}],
  confidence: probability
});

/** Fake model server: answers /v1/decisions and /v1/chat/completions and records the requests. */
function models(next: string, options: {template?: [string, number]; draft?: string; fail?: boolean} = {}) {
  const calls: {url: string; body: any; signal?: AbortSignal}[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({url: String(url), body, signal: init.signal});
    if (options.fail) return new Response('upstream down', {status: 502});
    if (String(url).endsWith('/v1/decisions'))
      return Response.json({
        model: 'gpt-6-luna',
        answers: [
          choice('next', next, 0.9),
          {type: 'predicate', name: 'complete', probability: 0.2},
          ...(options.template ? [choice('template', ...options.template)] : [])
        ]
      });
    return Response.json({choices: [{message: {role: 'assistant', content: options.draft ?? '请补充测试'}}]});
  });
  return {fetcher: fetcher as unknown as typeof fetch, calls};
}
const settle = (
  advisor: FollowUpAdvisor,
  agentId = 'a1',
  extra: Record<string, unknown> = {},
  profile = 'default'
) => {
  advisor.handleAgentEvent(agentId, {type: 'agent_start'});
  advisor.handleAgentEvent(agentId, {
    type: 'message_end',
    message: {role: 'user', content: '修复失败的测试'}
  });
  advisor.handleAgentEvent(agentId, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{type: 'text', text: '这个测试似乎是偶发失败。'}],
      stopReason: 'stop',
      ...extra
    }
  });
  advisor.handleAgentEvent(agentId, {type: 'agent_settled'}, {profile});
};
const ready = async (advisor: FollowUpAdvisor, agentId = 'a1') => {
  await vi.waitFor(() => expect(advisor.current(agentId)?.state).not.toBe('analyzing'));
  return advisor.current(agentId)!;
};

describe('follow-up advisor', () => {
  it('suggests a matching template without drafting, asking the decision model about the last turn', async () => {
    const {fetcher, calls} = models('needs_user', {template: ['review-ai', 0.9]});
    const advisor = new FollowUpAdvisor({
      fetcher,
      templates: () => [template('review-ai', '审查 PR 上的 AI 评论'), template('run-tests', '跑测试')]
    });
    advisor.updateSettings({enabled: true});
    const seen: unknown[] = [];
    advisor.subscribe((agentId, advice) => seen.push([agentId, advice?.state ?? null]));
    settle(advisor);
    expect(advisor.current('a1')?.state).toBe('analyzing');
    expect(await ready(advisor)).toMatchObject({
      state: 'ready',
      outcome: 'needs_user',
      probability: 0.9,
      complete: 0.2,
      suggestion: {
        source: 'template',
        name: 'review-ai',
        text: '审查 PR 上的 AI 评论 content',
        probability: 0.9
      }
    });
    expect(seen).toEqual([
      ['a1', 'analyzing'],
      ['a1', 'ready']
    ]);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.url).toBe('http://localhost:8313/v1/decisions');
    expect(request.body.model).toBe('gpt-6-luna-decisions');
    expect(request.body.input.slice(1)).toEqual([
      {role: 'user', content: '修复失败的测试'},
      {role: 'assistant', content: '这个测试似乎是偶发失败。'}
    ]);
    expect(request.body.questions.map((q: any) => q.name)).toEqual(['next', 'complete', 'template']);
    expect(request.body.questions[0].choices.map((c: any) => c.value)).toEqual([
      'done',
      'continue',
      'needs_user'
    ]);
    expect(request.body.questions[2].choices.map((c: any) => c.value)).toEqual([
      'review-ai',
      'run-tests',
      '__none__'
    ]);
  });

  it('drafts a reply with the chat model when no template fits well enough', async () => {
    const {fetcher, calls} = models('needs_user', {
      template: ['review-ai', 0.3],
      draft: '  请定位根因并修复。 '
    });
    const advisor = new FollowUpAdvisor({fetcher, templates: () => [template('review-ai', 'x')]});
    advisor.updateSettings({enabled: true, draftModel: 'gpt-6.1-terra'});
    settle(advisor);
    expect(await ready(advisor)).toMatchObject({
      outcome: 'needs_user',
      suggestion: {source: 'draft', model: 'gpt-6.1-terra', text: '请定位根因并修复。'}
    });
    expect(calls.map(call => call.url)).toEqual([
      'http://localhost:8313/v1/decisions',
      'http://localhost:8313/v1/chat/completions'
    ]);
    expect(calls[1].body.model).toBe('gpt-6.1-terra');
    expect(JSON.parse(calls[1].body.messages[1].content)).toMatchObject({
      userRequest: '修复失败的测试',
      agentReply: '这个测试似乎是偶发失败。',
      assessment: {next: 'needs_user', answerComplete: 0.2}
    });
  });

  it('only marks done and continue, without a suggestion or a draft', async () => {
    for (const outcome of ['done', 'continue']) {
      const {fetcher, calls} = models(outcome);
      const advisor = new FollowUpAdvisor({fetcher});
      advisor.updateSettings({enabled: true});
      settle(advisor);
      const advice = await ready(advisor);
      expect(advice).toMatchObject({state: 'ready', outcome, probability: 0.9});
      expect(advice.suggestion).toBeUndefined();
      expect(calls).toHaveLength(1);
      // No templates: the decision asks only about the conversation.
      expect(calls[0].body.questions).toHaveLength(2);
    }
  });

  it('stays quiet when disabled and for cancelled, paused, failed and collaboration runs', async () => {
    const {fetcher} = models('done');
    const advisor = new FollowUpAdvisor({fetcher});
    settle(advisor);
    expect(fetcher).not.toHaveBeenCalled();
    advisor.updateSettings({enabled: true});
    advisor.handleAgentEvent('a1', {type: 'message_end', message: {role: 'assistant', content: 'partial'}});
    advisor.handleAgentEvent('a1', {type: 'agent_settled', aborted: true});
    advisor.handleAgentEvent('a1', {type: 'message_end', message: {role: 'assistant', content: 'partial'}});
    advisor.handleAgentEvent('a1', {type: 'agent_settled', paused: true});
    settle(advisor, 'a1', {stopReason: 'error'});
    settle(advisor, 'a1', {}, 'collab');
    expect(fetcher).not.toHaveBeenCalled();
    expect(advisor.all()).toEqual([]);
  });

  it('withdraws advice and cancels its requests when a new run starts or it is dismissed', async () => {
    let release!: () => void;
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((resolve, reject) => {
          signals.push(init.signal);
          release = () => resolve(Response.json({answers: [choice('next', 'done', 1)]}));
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    ) as unknown as typeof fetch;
    const advisor = new FollowUpAdvisor({fetcher});
    advisor.updateSettings({enabled: true});
    const seen: unknown[] = [];
    advisor.subscribe((_agentId, advice) => seen.push(advice?.state ?? null));
    settle(advisor);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    advisor.handleAgentEvent('a1', {type: 'agent_start'});
    expect(signals[0].aborted).toBe(true);
    expect(advisor.current('a1')).toBeUndefined();
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual(['analyzing', null]);

    settle(advisor);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    release();
    await ready(advisor);
    advisor.clear('a1');
    expect(advisor.all()).toEqual([]);
    expect(seen.at(-1)).toBeNull();
  });

  it('reports a failed decision, and keeps the verdict when only the draft fails', async () => {
    const failing = new FollowUpAdvisor({fetcher: models('done', {fail: true}).fetcher});
    failing.updateSettings({enabled: true});
    settle(failing);
    expect(await ready(failing)).toMatchObject({state: 'error', error: expect.stringContaining('502')});

    const calls: string[] = [];
    const draftFails = new FollowUpAdvisor({
      fetcher: (async (url: any) => {
        calls.push(String(url));
        return String(url).endsWith('/decisions')
          ? Response.json({answers: [choice('next', 'needs_user', 0.8)]})
          : new Response('nope', {status: 500});
      }) as typeof fetch
    });
    draftFails.updateSettings({enabled: true});
    settle(draftFails);
    expect(await ready(draftFails)).toMatchObject({
      state: 'ready',
      outcome: 'needs_user',
      error: expect.stringContaining('草拟回复失败')
    });
  });

  it('validates settings and clears all advice when switched off', async () => {
    expect(
      mergeFollowUpSettings(DEFAULT_FOLLOW_UP_SETTINGS, {baseUrl: ' https://llm.example.com/v1 '})
    ).toMatchObject({
      baseUrl: 'https://llm.example.com/v1'
    });
    expect(() => mergeFollowUpSettings(DEFAULT_FOLLOW_UP_SETTINGS, {enabled: 'yes'})).toThrow(/boolean/);
    expect(() => mergeFollowUpSettings(DEFAULT_FOLLOW_UP_SETTINGS, {baseUrl: 'ftp://x'})).toThrow(/http/);
    expect(() => mergeFollowUpSettings(DEFAULT_FOLLOW_UP_SETTINGS, {decisionModel: ' '})).toThrow(/model ID/);
    expect(() => mergeFollowUpSettings(DEFAULT_FOLLOW_UP_SETTINGS, {draftModel: 'a b'})).toThrow(/model ID/);
    const advisor = new FollowUpAdvisor({fetcher: models('done').fetcher, apiKey: 'secret'});
    advisor.updateSettings({enabled: true});
    settle(advisor);
    await ready(advisor);
    advisor.updateSettings({enabled: false});
    expect(advisor.all()).toEqual([]);
    expect(advisor.apiKeyConfigured).toBe(true);
  });
});

describe('follow-up advice over the API', () => {
  let server: RemotePiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });
  const start = async (dataDir: string) => {
    const workspaces = new WorkspaceStore(),
      agents = new AgentManager(workspaces, (id, cwd) => new MockBackend(id, cwd));
    server = new RemotePiServer({
      port: 0,
      noAuth: true,
      dataDir,
      workspaces,
      agents,
      promptTemplates: new PromptTemplateStore(() => path.join(dataDir, 'prompts')),
      followUpFetcher: models('continue').fetcher
    });
    const address = await server.start(),
      base = `http://127.0.0.1:${address!.port}`;
    const call = async (url: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + url, {
        method,
        headers: {'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      return {status: response.status, body: (await response.json()) as any};
    };
    return {base, call};
  };

  it('persists settings, replays advice after agent states, and broadcasts a dismissal', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pi2web-follow-up-')),
      root = await mkdtemp(path.join(tmpdir(), 'pi2web-follow-up-ws-'));
    let {base, call} = await start(dataDir);
    expect((await call('/api/v1/follow-up-advisor')).body.data).toEqual({
      settings: DEFAULT_FOLLOW_UP_SETTINGS,
      apiKeyConfigured: false
    });
    expect((await call('/api/v1/follow-up-advisor', 'PUT', {baseUrl: 'nope'})).status).toBe(400);
    const saved = await call('/api/v1/follow-up-advisor', 'PUT', {
      enabled: true,
      draftModel: 'gpt-6.1-terra'
    });
    expect(saved.body.data.settings).toMatchObject({enabled: true, draftModel: 'gpt-6.1-terra'});
    await server!.stop();
    ({base, call} = await start(dataDir));
    expect((await call('/api/v1/follow-up-advisor')).body.data.settings.enabled).toBe(true);
    expect((await call('/api/v1/system/status')).body.data.followUpAdviceEnabled).toBe(true);

    const workspace = (await call('/api/v1/workspaces', 'POST', {label: 'ws', rootPath: root})).body.data;
    const agent = (await call('/api/v1/agents', 'POST', {workspaceId: workspace.id})).body.data;
    await server!.followUp.analyze(agent.agentId, 'do it', 'Done with step 1 of 3. Continue?');
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws'),
      messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise(resolve => ws.once('open', resolve));
    ws.send(JSON.stringify({type: 'subscribe_all'}));
    await vi.waitFor(() => expect(messages.some(m => m.type === 'subscribed_all')).toBe(true));
    const types = messages.map(m => m.type);
    expect(types.indexOf('follow_up_advice')).toBeGreaterThan(types.indexOf('agent_state'));
    expect(messages.find(m => m.type === 'follow_up_advice')).toMatchObject({
      agentId: agent.agentId,
      advice: {state: 'ready', outcome: 'continue'}
    });
    for (const message of messages.filter(m => m.type === 'follow_up_advice'))
      expect(Check(schema, message)).toBe(true);
    expect((await call(`/api/v1/agents/${agent.agentId}/follow-up-advice`, 'DELETE')).body.data).toEqual({
      dismissed: true
    });
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({type: 'follow_up_advice', agentId: agent.agentId, advice: null})
    );
    expect(Check(schema, messages.at(-1))).toBe(true);
    expect((await call('/api/v1/agents/missing/follow-up-advice', 'DELETE')).status).toBe(404);
    ws.close();
  });
});
