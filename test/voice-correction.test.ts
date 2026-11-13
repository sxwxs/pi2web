import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {MetadataStore} from '../src/metadata-store.js';
import {RemotePiServer} from '../src/server.js';
import {
  DEFAULT_VOICE_CORRECTION_SETTINGS,
  mergeVoiceCorrectionSettings,
  VoiceCorrectionService
} from '../src/voice-correction.js';

const completion = (text = '更新最新主分支，并修正语音识别结果。') =>
  new Response(
    JSON.stringify({
      choices: [{message: {role: 'assistant', content: text}, finish_reason: 'stop'}]
    })
  );
const service = (options: ConstructorParameters<typeof VoiceCorrectionService>[1] = {}) => {
  const metadata = {getSetting: vi.fn(), setSetting: vi.fn()};
  const corrector = new VoiceCorrectionService(metadata as unknown as MetadataStore, options);
  return {corrector, metadata};
};

describe('voice transcript correction', () => {
  it('defaults off and never calls a model while disabled', async () => {
    const fetcher = vi.fn(),
      {corrector} = service({fetcher});
    expect(corrector.getSettings()).toEqual(DEFAULT_VOICE_CORRECTION_SETTINGS);
    await expect(corrector.correct({text: '测试'})).rejects.toMatchObject({
      code: 'VOICE_CORRECTION_DISABLED'
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {enabled: 'yes'},
    {includeContext: 'yes'},
    {baseUrl: 'file:///tmp/model'},
    {baseUrl: 'not-url'},
    {baseUrl: 'http://name:secret@localhost:8313'},
    {baseUrl: 'http://localhost/?key=secret'},
    {model: ''},
    {model: 'two models'},
    {model: 12},
    null,
    []
  ])('rejects invalid settings %j without publishing or persisting them', patch => {
    const {corrector, metadata} = service();
    expect(() => corrector.update(patch as any)).toThrow();
    expect(corrector.getSettings()).toEqual(DEFAULT_VOICE_CORRECTION_SETTINGS);
    expect(metadata.setSetting).not.toHaveBeenCalled();
  });

  it('merges patches, trims IDs and leaves settings unchanged when storage fails', () => {
    expect(
      mergeVoiceCorrectionSettings(DEFAULT_VOICE_CORRECTION_SETTINGS, {model: ' terra ', enabled: true})
    ).toMatchObject({model: 'terra', enabled: true});
    const {corrector, metadata} = service();
    metadata.setSetting.mockImplementation(() => {
      throw Error('disk full');
    });
    expect(() => corrector.update({enabled: true})).toThrow('disk full');
    expect(corrector.getSettings().enabled).toBe(false);
  });

  it.each(['http://localhost:8313/', 'http://localhost:8313/v1/'])(
    'uses chat completions for %s and keeps the transcript as data',
    async baseUrl => {
      const fetcher = vi.fn(async () => completion()),
        {corrector} = service({fetcher, apiKey: 'secret'});
      corrector.update({enabled: true, baseUrl});
      const original = '更新最新的。主分只。并修正语音识别结果。';
      const result = await corrector.correct({text: original});
      expect(result).toEqual({
        original,
        corrected: '更新最新主分支，并修正语音识别结果。',
        model: 'gpt-6.1-terra',
        contextUsed: false
      });
      const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://localhost:8313/v1/chat/completions');
      expect(options.headers).toMatchObject({authorization: 'Bearer secret'});
      const body = JSON.parse(String(options.body));
      expect(body.model).toBe('gpt-6.1-terra');
      expect(body.stream).toBe(false);
      expect(body.temperature).toBeUndefined();
      expect(body.messages[0].content).toContain('不要猜测');
      expect(JSON.parse(body.messages[1].content)).toEqual({original});
      expect(JSON.stringify(corrector.getSettings())).not.toContain('secret');
    }
  );

  it('keeps context private when loading settings saved before the privacy option existed', () => {
    const {corrector, metadata} = service();
    metadata.getSetting.mockReturnValue({
      enabled: true,
      baseUrl: 'http://localhost:8313/',
      model: 'gpt-6.1-terra'
    });
    corrector.load();
    expect(corrector.getSettings()).toMatchObject({enabled: true, includeContext: false});
    expect(metadata.setSetting).not.toHaveBeenCalled();
  });

  it('defaults context off and ignores supplied context even if the browser still thinks it is enabled', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => completion());
    const {corrector} = service({fetcher});
    corrector.update({enabled: true});
    const result = await corrector.correct({text: '原文', context: {firstUserMessage: 'PRIVATE_CONTEXT'}});
    expect(corrector.getSettings().includeContext).toBe(false);
    expect(result.contextUsed).toBe(false);
    const messages = JSON.parse(String(fetcher.mock.calls[0][1].body)).messages;
    expect(JSON.parse(messages[1].content)).toEqual({original: '原文'});
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_CONTEXT');
    corrector.update({includeContext: true});
    corrector.update({includeContext: false});
    await corrector.correct({text: '原文', context: {firstUserMessage: 'PRIVATE_CONTEXT'}});
    expect(String(fetcher.mock.calls[1][1].body)).not.toContain('PRIVATE_CONTEXT');
  });

  it('sends only allowed bounded context strings when explicitly opted in', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => completion());
    const {corrector} = service({fetcher});
    corrector.update({enabled: true, includeContext: true});
    const result = await corrector.correct({
      text: '语音原文',
      context: {
        firstUserMessage: '最初需求',
        latestUserMessage: '最近需求',
        latestAssistantMessage: 'AI_START' + '字'.repeat(10000) + 'AI_END',
        thinking: 'THINKING_SECRET',
        toolCall: {arguments: 'TOOL_SECRET'},
        logs: 'LOG_SECRET',
        system: 'SYSTEM_SECRET'
      }
    });
    expect(result.contextUsed).toBe(true);
    const messages = JSON.parse(String(fetcher.mock.calls[0][1].body)).messages;
    expect(messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    const payload = JSON.parse(messages[1].content);
    expect(payload.original).toBe('语音原文');
    expect(Object.keys(payload.context)).toEqual([
      'firstUserMessage',
      'latestUserMessage',
      'latestAssistantMessage'
    ]);
    expect(payload.context.latestAssistantMessage.length).toBe(4000);
    expect(payload.context.latestAssistantMessage).toMatch(/^AI_START[\s\S]*AI_END$/);
    expect(JSON.stringify(messages)).not.toContain('SECRET');
    expect(messages[0].content).toContain('输出只校对 original');
  });

  it('still works without any context when context is enabled but the conversation is empty', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => completion());
    const {corrector} = service({fetcher});
    corrector.update({enabled: true, includeContext: true});
    const result = await corrector.correct({text: '原文', context: {thinking: 'SECRET'}});
    expect(result.contextUsed).toBe(false);
    const payload = JSON.parse(JSON.parse(String(fetcher.mock.calls[0][1].body)).messages[1].content);
    expect(payload).toEqual({original: '原文'});
  });

  it('rejects missing and oversized text without a model call', async () => {
    const fetcher = vi.fn(),
      {corrector} = service({fetcher});
    corrector.update({enabled: true});
    for (const body of [null, {}, {text: '  '}, {text: 1}])
      await expect(corrector.correct(body)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    await expect(corrector.correct({text: '字'.repeat(20_001)})).rejects.toMatchObject({
      code: 'REQUEST_TOO_LARGE'
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response('secret upstream response', {status: 500}),
    () => completion(''),
    () => new Response(JSON.stringify({choices: [{message: {content: '一半'}, finish_reason: 'length'}]})),
    () => new Response('bad json')
  ])('reports model failures rather than replacing the original', async response => {
    const {corrector} = service({fetcher: vi.fn(async () => response())});
    corrector.update({enabled: true});
    await expect(corrector.correct({text: '原文'})).rejects.toMatchObject({code: 'VOICE_CORRECTION_FAILED'});
  });

  it('times out stalled requests and cancels requests on disabling, caller cancellation and shutdown', async () => {
    const fetcher = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
        })
    );
    const {corrector} = service({fetcher, timeoutMs: 10});
    corrector.update({enabled: true});
    await expect(corrector.correct({text: '原文'})).rejects.toMatchObject({code: 'VOICE_CORRECTION_TIMEOUT'});
    const cancelled = corrector.correct({text: '原文'});
    corrector.update({enabled: false});
    await expect(cancelled).rejects.toMatchObject({code: 'VOICE_CORRECTION_FAILED'});
    corrector.update({enabled: true});
    const controller = new AbortController(),
      byCaller = corrector.correct({text: '原文'}, controller.signal);
    controller.abort();
    await expect(byCaller).rejects.toMatchObject({code: 'VOICE_CORRECTION_FAILED'});
    const byShutdown = corrector.correct({text: '原文'});
    corrector.close();
    await expect(byShutdown).rejects.toMatchObject({code: 'VOICE_CORRECTION_FAILED'});
  });
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('authenticated voice correction API', () => {
  it('persists local-backend settings, exposes no key, corrects drafts without an Agent, and denies restricted tokens', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pi2web-correction-'));
    cleanups.push(() => rm(dataDir, {recursive: true, force: true}));
    const fetcher = vi.fn(async () => completion());
    let server = new RemotePiServer({
      port: 0,
      dataDir,
      voiceCorrectionApiKey: 'secret',
      voiceCorrectionFetcher: fetcher
    });
    cleanups.push(() => server.stop());
    const {token} = await server.auth.init(),
      voiceToken = await server.auth.rotateVoice();
    let address = await server.start(),
      base = `http://127.0.0.1:${address!.port}`;
    const call = async (method: string, payload?: unknown, auth = token) => {
      const response = await fetch(base + '/api/v1/voice-correction', {
        method,
        headers: {authorization: `Bearer ${auth}`, 'content-type': 'application/json'},
        ...(payload === undefined ? {} : {body: JSON.stringify(payload)})
      });
      return {status: response.status, body: (await response.json()) as any};
    };
    expect((await call('GET')).body.data).toEqual({
      settings: DEFAULT_VOICE_CORRECTION_SETTINGS,
      apiKeyConfigured: true
    });
    expect((await call('POST', {text: '原文'})).status).toBe(503);
    expect((await call('GET', undefined, 'wrong')).status).toBe(401);
    for (const method of ['GET', 'PUT', 'POST'])
      expect((await call(method, method === 'GET' ? undefined : {text: '原文'}, voiceToken)).status).toBe(
        403
      );
    const saved = await call('PUT', {enabled: true, includeContext: true});
    expect(saved.status).toBe(200);
    expect(saved.body.data.settings.model).toBe('gpt-6.1-terra');
    expect(saved.body.data.settings.includeContext).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain('secret');
    expect((await call('POST', {text: '原文'})).body.data.original).toBe('原文');
    expect(server.agents.list()).toEqual([]);
    expect((await call('POST', {text: '字'.repeat(20_001)})).status).toBe(413);
    const status = (await fetch(base + '/api/v1/system/status', {
      headers: {authorization: `Bearer ${token}`}
    }).then(r => r.json())) as any;
    expect(status.data.voiceCorrection.enabled).toBe(true);
    expect((await fetch(base + '/voice-correction.js')).status).toBe(200);
    await server.stop();
    server = new RemotePiServer({port: 0, dataDir, voiceCorrectionFetcher: fetcher});
    address = await server.start();
    base = `http://127.0.0.1:${address!.port}`;
    expect((await call('GET')).body.data.settings).toMatchObject({enabled: true, includeContext: true});
    expect((await call('PUT', {enabled: false})).status).toBe(200);
    expect((await call('POST', {text: '原文'})).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
