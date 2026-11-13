import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  boundedVoiceCorrectionContext,
  voiceCorrectionContext,
  VOICE_CORRECTION_CONTEXT_LIMITS
} from '../src/voice-correction-context.js';
import {AgentManager, MockBackend} from '../src/agents.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {RemotePiServer} from '../src/server.js';
import type {TimelineEntry} from '../src/timeline.js';

const message = (id: string, role: string, content: unknown, extra = {}): TimelineEntry => ({
  type: 'message',
  id,
  parentId: null,
  message: {role, content, ...extra}
});
const branch = () => [
  message('u1', 'user', [
    {type: 'text', text: '首次需求：用 gpt-6.1-terra'},
    {type: 'image', data: 'IMAGE_SECRET'}
  ]),
  message('a1', 'assistant', [
    {type: 'text', text: '之前的回复'},
    {type: 'thinking', thinking: 'THINKING_SECRET'}
  ]),
  message('u2', 'user', '最近需求：增加语音纠错'),
  message('tool', 'toolResult', 'TOOL_RESULT_SECRET'),
  {type: 'custom', id: 'log', parentId: null, data: 'LOG_SECRET'},
  {type: 'custom_message', id: 'custom', parentId: null, content: 'CUSTOM_MESSAGE_SECRET'},
  {type: 'compaction', id: 'compact', parentId: null, summary: 'COMPACTION_SECRET'},
  {type: 'branch_summary', id: 'summary', parentId: null, summary: 'BRANCH_SUMMARY_SECRET'},
  message('system', 'system', 'SYSTEM_SECRET'),
  message(
    'a2',
    'assistant',
    [
      {type: 'thinking', thinking: 'LATEST_THINKING_SECRET', signature: 'SIGNATURE_SECRET'},
      {type: 'text', text: '最近回复：默认模型 gpt-6.1-terra。'},
      {type: 'toolCall', id: 'call', name: 'read', arguments: {path: 'TOOL_CALL_SECRET'}},
      {type: 'image', data: 'ASSISTANT_IMAGE_SECRET'}
    ],
    {stopReason: 'stop', errorMessage: 'METADATA_SECRET'}
  ),
  message('a3', 'assistant', [{type: 'thinking', thinking: 'THINKING_ONLY_SECRET'}])
];
const expected = {
  firstUserMessage: '首次需求：用 gpt-6.1-terra',
  latestUserMessage: '最近需求：增加语音纠错',
  latestAssistantMessage: '最近回复：默认模型 gpt-6.1-terra。'
};

describe('bounded message-only correction context', () => {
  it('selects first/latest user messages and the latest assistant text, excluding every other block and entry', () => {
    const context = voiceCorrectionContext(branch());
    expect(context).toEqual(expected);
    expect(JSON.stringify(context)).not.toContain('SECRET');
  });
  it('does not use tool-use commentary, failed replies or aborted replies instead of the last completed answer', () => {
    const entries = [
      ...branch(),
      message('tool-use', 'assistant', 'TOOL_USE_COMMENTARY', {stopReason: 'toolUse'}),
      message('failed', 'assistant', 'FAILED_REPLY', {stopReason: 'error'}),
      message('aborted', 'assistant', 'ABORTED_REPLY', {stopReason: 'aborted'})
    ];
    expect(voiceCorrectionContext(entries)).toEqual(expected);
  });
  it('omits duplicate first/latest prompts and handles a new or text-free conversation', () => {
    expect(voiceCorrectionContext([message('u1', 'user', '唯一用户消息')])).toEqual({
      firstUserMessage: '唯一用户消息'
    });
    expect(voiceCorrectionContext([])).toEqual({});
    expect(voiceCorrectionContext([message('u1', 'user', [{type: 'image', data: 'SECRET'}])])).toEqual({});
  });
  it('truncates all three fields with strict individual budgets, preserving their beginning and end', () => {
    const context = boundedVoiceCorrectionContext({
      firstUserMessage: 'FIRST_START' + '字'.repeat(5000) + 'FIRST_END',
      latestUserMessage: 'USER_START' + '字'.repeat(5000) + 'USER_END',
      latestAssistantMessage: 'AI_START' + '字'.repeat(10000) + 'AI_END'
    });
    let total = 0;
    for (const key of Object.keys(VOICE_CORRECTION_CONTEXT_LIMITS) as (keyof typeof context)[]) {
      expect(context[key]!.length).toBe(VOICE_CORRECTION_CONTEXT_LIMITS[key]);
      expect(context[key]).toContain('[中间内容已截断]');
      total += context[key]!.length;
    }
    expect(total).toBe(8000);
    expect(context.firstUserMessage).toMatch(/^FIRST_START[\s\S]*FIRST_END$/);
    expect(context.latestUserMessage).toMatch(/^USER_START[\s\S]*USER_END$/);
    expect(context.latestAssistantMessage).toMatch(/^AI_START[\s\S]*AI_END$/);
  });
  it('rebuilds only known string fields without forwarding tool, thinking or metadata fields from a client', () => {
    expect(
      boundedVoiceCorrectionContext({
        firstUserMessage: ' 用户消息 ',
        latestUserMessage: [{type: 'text', text: 'not a string'}],
        latestAssistantMessage: 'AI 回复',
        thinking: 'SECRET',
        toolResults: ['SECRET'],
        logs: 'SECRET'
      })
    ).toEqual({firstUserMessage: '用户消息', latestAssistantMessage: 'AI 回复'});
    for (const value of [null, [], 'text', {latestUserMessage: '  '}])
      expect(boundedVoiceCorrectionContext(value)).toEqual({});
  });
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('current-branch context API', () => {
  it('returns only bounded message text from the chosen Agent branch, never its full session, and requires full access', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pi2web-correction-context-'));
    cleanups.push(() => rm(dataDir, {recursive: true, force: true}));
    const workspaces = new WorkspaceStore();
    const backends: ContextBackend[] = [];
    class ContextBackend extends MockBackend {
      currentBranch = branch();
      timeline() {
        return {
          sessionId: 'current-session',
          leafId: this.currentBranch.at(-1)?.id ?? null,
          entries: () => this.currentBranch
        };
      }
      async getSession() {
        throw Error('Full session must not be read for correction');
      }
      async navigate(entryId: string) {
        const index = this.currentBranch.findIndex(entry => entry.id === entryId);
        this.currentBranch = this.currentBranch.slice(0, index + 1);
        return {cancelled: false};
      }
    }
    const agents = new AgentManager(workspaces, (id, cwd) => {
      const backend = new ContextBackend(id, cwd);
      if (backends.length) backend.currentBranch = [message('other', 'user', 'OTHER_AGENT_SECRET')];
      backends.push(backend);
      return backend;
    });
    const fetcher = vi.fn(
      async (_url: any, _init: any) =>
        new Response(
          JSON.stringify({
            choices: [{message: {content: '修正后的原文'}, finish_reason: 'stop'}]
          })
        )
    );
    const server = new RemotePiServer({
      port: 0,
      dataDir,
      workspaces,
      agents,
      voiceCorrectionFetcher: fetcher
    });
    cleanups.push(() => server.stop());
    const {token} = await server.auth.init(),
      voiceToken = await server.auth.rotateVoice();
    const address = await server.start(),
      base = `http://127.0.0.1:${address!.port}`;
    const call = async (url: string, method = 'GET', body?: unknown, auth = token) => {
      const response = await fetch(base + url, {
        method,
        headers: {authorization: `Bearer ${auth}`, 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      return {status: response.status, body: (await response.json()) as any};
    };
    const workspace = (await call('/api/v1/workspaces', 'POST', {label: 'ws', rootPath: dataDir})).body.data;
    const agent = (await call('/api/v1/agents', 'POST', {workspaceId: workspace.id})).body.data;
    await call('/api/v1/agents', 'POST', {workspaceId: workspace.id});
    const url = `/api/v1/agents/${agent.agentId}/voice-correction-context`;
    const data = (await call(url)).body.data;
    expect(data).toEqual({sessionId: 'current-session', context: expected});
    await call('/api/v1/voice-correction', 'PUT', {enabled: true, includeContext: true});
    const corrected = await call('/api/v1/voice-correction', 'POST', {
      text: '语音原文',
      context: data.context
    });
    expect(corrected.body.data.contextUsed).toBe(true);
    const modelRequest = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(JSON.parse(modelRequest.messages[1].content)).toEqual({original: '语音原文', context: expected});
    expect(JSON.stringify(modelRequest)).not.toContain('SECRET');
    await call('/api/v1/voice-correction', 'PUT', {includeContext: false});
    const withoutContext = await call('/api/v1/voice-correction', 'POST', {
      text: '语音原文',
      context: data.context
    });
    expect(withoutContext.body.data.contextUsed).toBe(false);
    const privateRequest = JSON.parse(String(fetcher.mock.calls[1][1].body));
    expect(JSON.parse(privateRequest.messages[1].content)).toEqual({original: '语音原文'});
    expect((await call(url, 'GET', undefined, voiceToken)).status).toBe(403);
    expect((await call(url, 'GET', undefined, 'wrong')).status).toBe(401);
    expect((await call('/api/v1/agents/missing/voice-correction-context')).status).toBe(404);
    await agents.navigate(agent.agentId, 'u1');
    expect((await call(url)).body.data.context).toEqual({firstUserMessage: expected.firstUserMessage});
    expect(agents.list()).toHaveLength(2);
  });
});
