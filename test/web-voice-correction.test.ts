import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/voice-correction.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((r, j) => {
    resolve = r;
    reject = j;
  });
  return {promise, resolve, reject};
};
function harness({enabled = true, remote = false, includeContext = false} = {}) {
  const elements: Record<string, any> = {};
  const $ = (id: string) =>
    (elements[id] ??= {value: '', hidden: true, disabled: false, textContent: '', readOnly: false});
  const input = {
    value: '已有草稿 ',
    setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    setSelectionRange: vi.fn(),
    focus: vi.fn()
  };
  const backend = {
    id: 'local',
    statusInfo: {
      voiceCorrection: {
        enabled,
        includeContext,
        baseUrl: 'http://localhost:8313/',
        model: 'gpt-6.1-terra'
      }
    }
  };
  let agent = {agentId: remote ? 'remote:agent' : 'local:agent', backendId: remote ? 'remote' : 'local'};
  const owner = {agentId: agent.agentId, transcribeBackendId: backend.id, input, at: input.value.length};
  const requests: ReturnType<typeof deferred>[] = [];
  const request = vi.fn(() => {
    const d = deferred();
    requests.push(d);
    return d.promise;
  });
  const getContext = vi.fn(async (_agentId: string, _options: RequestInit): Promise<any> => ({context: {}}));
  const toast = vi.fn(),
    onAccept = vi.fn(),
    window: any = {};
  runInNewContext(source, {window, setTimeout, clearTimeout, AbortController, AbortSignal});
  const correction = new window.RemotePiVoiceCorrection.VoiceCorrection({
    $,
    getAgent: () => agent,
    getBackend: () => backend,
    getContext,
    request,
    toast,
    onAccept
  });
  correction.begin(owner);
  const observe = (text: string) => {
    input.value = input.value.slice(0, owner.at) + text;
    correction.observe(owner, text);
  };
  return {
    correction,
    owner,
    input,
    $,
    elements,
    request,
    getContext,
    requests,
    toast,
    onAccept,
    backend,
    observe,
    switchAgent: () => {
      agent = {agentId: 'other:agent', backendId: 'other'};
    }
  };
}

describe('voice correction preview and acceptance', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not read or transmit conversation context unless separately opted in', () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    expect(h.getContext).not.toHaveBeenCalled();
    expect(JSON.parse((h.request.mock.calls[0] as any)[2].body)).toEqual({text: '原文'});
    h.correction.clear();
  });

  it('reads only the owning Agent context and routes correction through the local backend when opted in', async () => {
    const h = harness({remote: true, includeContext: true});
    const context = {firstUserMessage: '远端用户消息', latestAssistantMessage: '远端 AI 回复'};
    h.getContext.mockResolvedValueOnce({context});
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getContext.mock.calls[0][0]).toBe('remote:agent');
    expect((h.request.mock.calls[0] as any)[0]).toBe('local');
    expect(JSON.parse((h.request.mock.calls[0] as any)[2].body)).toEqual({text: '原文', context});
    h.requests[0].resolve({corrected: '修正', contextUsed: true});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionStatus').textContent).toContain('已结合截断的用户/AI消息');
    h.correction.clear();
  });

  it('falls back to transcript-only correction and reports that context could not be read', async () => {
    const h = harness({includeContext: true});
    h.getContext.mockRejectedValueOnce(Error('unavailable'));
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse((h.request.mock.calls[0] as any)[2].body)).toEqual({text: '原文'});
    h.requests[0].resolve({corrected: '修正', contextUsed: false});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionStatus').textContent).toContain('上下文读取失败');
    expect(h.input.value).toBe('已有草稿 原文');
    h.correction.clear();
  });

  it.each(['resolve', 'reject'])(
    'does not call the model after cancellation while reading context (%s)',
    async outcome => {
      const h = harness({includeContext: true}),
        context = deferred();
      h.getContext.mockReturnValueOnce(context.promise);
      h.observe('原文');
      h.correction.end(h.owner, '原文');
      const signal = h.getContext.mock.calls[0][1].signal!;
      h.correction.clear();
      expect(signal.aborted).toBe(true);
      if (outcome === 'resolve') context.resolve({context: {firstUserMessage: '旧会话'}});
      else context.reject(Error('aborted'));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
    }
  );

  it('ignores a late context response after a newer transcript starts correction', async () => {
    const h = harness({includeContext: true}),
      old = deferred();
    h.getContext.mockReturnValueOnce(old.promise);
    h.observe('旧原文');
    h.correction.end(h.owner, '旧原文');
    h.getContext.mockResolvedValueOnce({context: {latestAssistantMessage: '新回复'}});
    h.observe('新原文');
    h.correction.end(h.owner, '新原文');
    await vi.advanceTimersByTimeAsync(0);
    old.resolve({context: {latestAssistantMessage: '过时回复'}});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(JSON.parse((h.request.mock.calls[0] as any)[2].body)).toEqual({
      text: '新原文',
      context: {latestAssistantMessage: '新回复'}
    });
    h.correction.clear();
  });

  it('does nothing when disabled', async () => {
    const h = harness({enabled: false});
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
  });

  it('debounces pauses, previews during recording, and reuses the latest correction on stop', async () => {
    const h = harness({remote: true});
    h.observe('第一句');
    await vi.advanceTimersByTimeAsync(1500);
    h.observe('第一句 第二句');
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request.mock.calls[0]).toMatchObject([
      'local',
      '/api/v1/voice-correction',
      {body: JSON.stringify({text: '第一句 第二句'})}
    ]);
    h.requests[0].resolve({corrected: '第一句，第二句。'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionOriginal').value).toBe('第一句 第二句');
    expect(h.$('voiceCorrectionText').value).toBe('第一句，第二句。');
    expect(h.input.value).toBe('已有草稿 第一句 第二句');
    expect(h.$('voiceCorrectionAccept').disabled).toBe(true);
    h.correction.accept();
    expect(h.onAccept).not.toHaveBeenCalled();
    h.correction.end(h.owner, '第一句 第二句');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.$('voiceCorrectionAccept').disabled).toBe(false);
    h.$('voiceCorrectionText').value = '第一句，手动修改的第二句。';
    h.input.value += ' 后续手写';
    h.correction.accept();
    expect(h.input.value).toBe('已有草稿 第一句，手动修改的第二句。 后续手写');
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
    expect(h.onAccept).toHaveBeenCalledTimes(1);
  });

  it('corrects the final result immediately and ignores out-of-order replies for an older pause', async () => {
    const h = harness();
    h.observe('旧原文');
    await vi.advanceTimersByTimeAsync(2000);
    const oldSignal = (h.request.mock.calls[0] as any)[2].signal;
    h.observe('最新最终原文');
    h.correction.end(h.owner, '最新最终原文');
    expect(oldSignal.aborted).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.requests[1].resolve({corrected: '最新修正'});
    await vi.advanceTimersByTimeAsync(0);
    h.requests[0].resolve({corrected: '过时修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionText').value).toBe('最新修正');
    expect(h.input.value).toBe('已有草稿 最新最终原文');
  });

  it('reuses a pending identical request at stop and never accepts before it returns', async () => {
    const h = harness();
    h.observe('原文');
    await vi.advanceTimersByTimeAsync(2000);
    h.correction.end(h.owner, '原文');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.$('voiceCorrectionText').readOnly).toBe(true);
    h.correction.accept();
    expect(h.onAccept).not.toHaveBeenCalled();
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionText').readOnly).toBe(false);
  });

  it('never overwrites manual edits and offers explicit append instead', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    h.input.value = '完全不同的手写草稿';
    h.correction.render();
    expect(h.$('voiceCorrectionAccept').textContent).toBe('追加修正');
    h.correction.accept();
    expect(h.input.value).toBe('完全不同的手写草稿 修正');
  });

  it('preserves the original on failure, supports editing and retry, and never sends a prompt', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].reject(Error('连接失败'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionStatus').textContent).toContain('原文已保留');
    expect(h.input.value).toBe('已有草稿 原文');
    void h.correction.correct(true);
    h.requests[1].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionText').value).toBe('修正');
    h.$('voiceCorrectionKeep').onclick();
    expect(h.input.value).toBe('已有草稿 原文');
    expect(h.onAccept).not.toHaveBeenCalled();
  });

  it('cancels a dismissed preview, a changed backend configuration, and a switched Agent', async () => {
    for (const action of ['dismiss', 'settings', 'agent']) {
      const h = harness();
      h.observe('原文');
      h.correction.end(h.owner, '原文');
      if (action === 'dismiss') h.correction.clear();
      else if (action === 'settings') h.correction.configure(h.backend);
      else {
        h.switchAgent();
        h.correction.clear();
      }
      expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
      h.requests[0].resolve({corrected: '晚到的结果'});
      await vi.advanceTimersByTimeAsync(0);
      expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
      expect(h.input.value).toBe('已有草稿 原文');
    }
  });

  it('does not clear a local correction just because an unrelated backend disconnects', () => {
    const h = harness({remote: true});
    h.observe('原文');
    h.correction.clear('unrelated');
    expect(h.$('voiceCorrectionPanel').hidden).toBe(false);
    h.correction.clear('remote');
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
  });
});

const appSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const settingsSource = appSource.slice(
  appSource.indexOf('  function applyVoiceCorrectionSettings('),
  appSource.indexOf('  /** Follow-up settings belong to a backend:')
);
function settingsHarness(enabled = true) {
  const h = harness({enabled});
  h.$('configDialog').open = true;
  const state: any = {voiceCorrection: h.correction, voiceStream: null, voiceCorrectionSettingsRequest: 0};
  let serverSettings = {...h.backend.statusInfo.voiceCorrection};
  const requestBackend = vi.fn(async () => ({settings: serverSettings, apiKeyConfigured: false}));
  const api = runInNewContext(
    `${settingsSource}\n({loadVoiceCorrectionSettings, saveVoiceCorrectionSettings})`,
    {
      state,
      $: h.$,
      localBackend: () => h.backend,
      backendOf: () => h.backend,
      requestBackend,
      toast: h.toast
    }
  );
  return {
    ...h,
    state,
    api,
    requestBackend,
    setServerSettings: (patch: Partial<typeof serverSettings>) => {
      serverSettings = {...serverSettings, ...patch};
    }
  };
}

describe('correction settings refreshed when configuration is reopened', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes the context privacy flag and cancels previews when that flag changes', async () => {
    const h = settingsHarness();
    await h.api.loadVoiceCorrectionSettings();
    expect(h.$('voiceCorrectionIncludeContext').checked).toBe(false);
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.setServerSettings({includeContext: true});
    await h.api.loadVoiceCorrectionSettings();
    expect(h.backend.statusInfo.voiceCorrection.includeContext).toBe(true);
    expect(h.$('voiceCorrectionIncludeContext').checked).toBe(true);
    expect(h.correction.session).toBeNull();
    expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
    h.$('voiceCorrectionIncludeContext').checked = false;
    h.setServerSettings({includeContext: false});
    await h.api.saveVoiceCorrectionSettings();
    const options = (h.requestBackend.mock.calls.at(-1) as any)[2];
    expect(JSON.parse(options.body).includeContext).toBe(false);
    expect(h.backend.statusInfo.voiceCorrection.includeContext).toBe(false);
  });

  it('updates both the form and the dictation gate after another page enables correction', async () => {
    const h = settingsHarness(false);
    h.setServerSettings({enabled: true});
    await h.api.loadVoiceCorrectionSettings();
    expect(h.$('voiceCorrectionEnabled').checked).toBe(true);
    expect(h.backend.statusInfo.voiceCorrection.enabled).toBe(true);
    h.correction.begin(h.owner);
    h.observe('下一次录音');
    h.correction.end(h.owner, '下一次录音');
    expect(h.request).toHaveBeenCalledTimes(1);
    h.correction.clear();
  });

  it('leaves an edited candidate intact when fetched settings have not changed', async () => {
    const h = settingsHarness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    h.$('voiceCorrectionText').value = '用户编辑后的候选';
    const session = h.correction.session;
    await h.api.loadVoiceCorrectionSettings();
    expect(h.correction.session).toBe(session);
    expect(h.$('voiceCorrectionText').value).toBe('用户编辑后的候选');
    h.correction.clear();
  });

  it('invalidates a pending preview when the refreshed settings disable correction', async () => {
    const h = settingsHarness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.setServerSettings({enabled: false});
    await h.api.loadVoiceCorrectionSettings();
    expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
    expect(h.backend.statusInfo.voiceCorrection.enabled).toBe(false);
    h.requests[0].resolve({corrected: '晚到的候选'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
    expect(h.input.value).toBe('已有草稿 原文');
  });

  it('refreshes the endpoint and model and cancels a candidate based on old settings', async () => {
    const h = settingsHarness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.setServerSettings({baseUrl: 'http://localhost:9000/v1', model: 'another-model'});
    await h.api.loadVoiceCorrectionSettings();
    expect(h.backend.statusInfo.voiceCorrection).toMatchObject({
      baseUrl: 'http://localhost:9000/v1',
      model: 'another-model'
    });
    expect(h.$('voiceCorrectionModel').value).toBe('another-model');
    expect(h.correction.session).toBeNull();
    expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
  });

  it('can attach correction to an existing live recording when refreshed settings enable it', async () => {
    const h = settingsHarness(false);
    h.observe('录音原文');
    const voice = (h.state.voiceStream = {...h.owner, inserted: '录音原文'});
    h.setServerSettings({enabled: true});
    await h.api.loadVoiceCorrectionSettings();
    expect(h.correction.session.owner).toBe(voice);
    expect(h.correction.session.original).toBe('录音原文');
    expect(h.$('voiceCorrectionAccept').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.correction.clear();
  });
});
