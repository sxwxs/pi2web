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
const document = {createElement: (tagName: string) => ({tagName, textContent: ''})};
const loadModule = () => {
  const window: any = {};
  runInNewContext(source, {window, document, setTimeout, clearTimeout, AbortController, AbortSignal});
  return window.RemotePiVoiceCorrection;
};
/** The diff box as text: [-removed] and {+added}. */
const shown = (children: any[]) =>
  children
    .map(child =>
      typeof child === 'string'
        ? child
        : child.tagName === 'del'
          ? `[-${child.textContent}]`
          : `{+${child.textContent}}`
    )
    .join('');
function harness({enabled = true, remote = false, includeContext = false} = {}) {
  const elements: Record<string, any> = {};
  const $ = (id: string) =>
    (elements[id] ??= {
      value: '',
      hidden: true,
      disabled: false,
      textContent: '',
      children: [],
      replaceChildren(...children: unknown[]) {
        this.children = children;
      }
    });
  const input = {
    value: '已有草稿 ',
    selectionStart: 0,
    selectionEnd: 0,
    setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    setSelectionRange: vi.fn(function (this: any, start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }),
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
    onWrite = vi.fn();
  const correction = new (loadModule().VoiceCorrection)({
    $,
    getAgent: () => agent,
    getBackend: () => backend,
    getContext,
    request,
    toast,
    onWrite
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
    onWrite,
    backend,
    observe,
    diff: () => shown($('voiceCorrectionDiff').children),
    toggle: () => $('voiceCorrectionToggle'),
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
    expect(h.input.value).toBe('已有草稿 修正');
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

  it('debounces pauses, previews during recording, and writes the correction once stopped', async () => {
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
    expect(h.diff()).toBe('第一句[- ]{+，}第二句{+。}');
    // Dictation still owns the composer while recording.
    expect(h.input.value).toBe('已有草稿 第一句 第二句');
    expect(h.toggle().disabled).toBe(true);
    h.correction.toggle();
    expect(h.onWrite).not.toHaveBeenCalled();
    h.correction.end(h.owner, '第一句 第二句');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.input.value).toBe('已有草稿 第一句，第二句。');
    expect(h.onWrite).toHaveBeenCalledTimes(1);
    expect(h.$('voiceCorrectionPanel').hidden).toBe(false);
    expect(h.toggle()).toMatchObject({textContent: '恢复原文', disabled: false});
    h.input.value += ' 后续手写';
    h.correction.toggle();
    expect(h.input.value).toBe('已有草稿 第一句 第二句 后续手写');
    expect(h.toggle().textContent).toBe('采用修正');
    expect(h.$('voiceCorrectionStatus').textContent).toContain('输入框中仍是原文');
    h.correction.toggle();
    expect(h.input.value).toBe('已有草稿 第一句，第二句。 后续手写');
    expect(h.input.focus).not.toHaveBeenCalled();
  });

  it('keeps the caret where the user left it and cannot restore an edited correction', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.input.value += '，继续写';
    h.input.selectionStart = h.input.selectionEnd = h.input.value.length;
    h.requests[0].resolve({corrected: '修正后的'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 修正后的，继续写');
    expect(h.input.selectionStart).toBe(h.input.value.length);
    h.input.value = '已有草稿 修正后来的，继续写';
    h.correction.render();
    expect(h.toggle()).toMatchObject({textContent: '恢复原文', disabled: true});
    h.correction.toggle();
    expect(h.input.value).toBe('已有草稿 修正后来的，继续写');
    expect(h.onWrite).toHaveBeenCalledWith({start: 5, end: 7, text: '修正后的'});
  });

  it('appends a retried correction after the previous one was edited', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '第一次修正'});
    await vi.advanceTimersByTimeAsync(0);
    h.input.value = '已有草稿 手改过的修正';
    h.$('voiceCorrectionRetry').onclick();
    h.requests[1].resolve({corrected: '第二次修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 手改过的修正');
    expect(h.toggle()).toMatchObject({textContent: '追加修正', disabled: false});
    h.correction.toggle();
    expect(h.input.value).toBe('已有草稿 手改过的修正 第二次修正');
    expect(h.onWrite).toHaveBeenLastCalledWith({start: 11, end: 11, text: ' 第二次修正'});
  });

  it('compares line breaks the way the textarea stores them', async () => {
    const h = harness();
    // Like a textarea, the fake composer keeps only LF.
    const setRangeText = h.input.setRangeText;
    h.input.setRangeText = function (text: string, start: number, end: number) {
      setRangeText.call(this, text.replace(/\r\n?/g, '\n'), start, end);
    };
    h.input.value += '第一行\n第二行';
    h.correction.end(h.owner, '第一行\r\n第二行');
    h.requests[0].resolve({corrected: '第一行。\r\n第二行。'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 第一行。\n第二行。');
    expect(h.toggle()).toMatchObject({textContent: '恢复原文', disabled: false});
    h.correction.toggle();
    expect(h.input.value).toBe('已有草稿 第一行\n第二行');
  });

  it('writes each retried correction, including one that keeps the original', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '第一次修正'});
    await vi.advanceTimersByTimeAsync(0);
    void h.correction.correct(true);
    expect(h.toggle().disabled).toBe(true);
    h.requests[1].resolve({corrected: '第二次修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 第二次修正');
    void h.correction.correct(true);
    h.requests[2].resolve({corrected: '原文'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 原文');
    expect(h.diff()).toBe('原文');
    expect(h.toggle().disabled).toBe(true);
    expect(h.$('voiceCorrectionStatus').textContent).toContain('无需修正');
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
    expect(h.diff()).toBe('最新[-最终原文]{+修正}');
    expect(h.input.value).toBe('已有草稿 最新修正');
  });

  it('reuses a pending identical request at stop and never accepts before it returns', async () => {
    const h = harness();
    h.observe('原文');
    await vi.advanceTimersByTimeAsync(2000);
    h.correction.end(h.owner, '原文');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.toggle().disabled).toBe(true);
    h.correction.toggle();
    expect(h.onWrite).not.toHaveBeenCalled();
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 修正');
  });

  it('never overwrites manual edits and offers explicit append instead', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.input.value = '完全不同的手写草稿';
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('完全不同的手写草稿');
    expect(h.onWrite).not.toHaveBeenCalled();
    expect(h.toggle().textContent).toBe('追加修正');
    h.correction.toggle();
    expect(h.input.value).toBe('完全不同的手写草稿 修正');
    expect(h.correction.session).toBeNull();
  });

  it('keeps the original on failure and writes a successful retry', async () => {
    const h = harness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].reject(Error('连接失败'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.$('voiceCorrectionStatus').textContent).toContain('原文已保留');
    expect(h.input.value).toBe('已有草稿 原文');
    expect(h.onWrite).not.toHaveBeenCalled();
    h.$('voiceCorrectionRetry').onclick();
    h.requests[1].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 修正');
    h.$('voiceCorrectionClose').onclick();
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
    expect(h.input.value).toBe('已有草稿 修正');
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
function navigationHarness(h: ReturnType<typeof harness>) {
  const navigation = deferred(),
    selectAgent = vi.fn(async () => {});
  const postAgent = vi.fn(() => {
    expect(h.correction.session).toBeNull();
    return navigation.promise;
  });
  const state = {agent: {agentId: h.owner.agentId}, voiceCorrection: h.correction};
  const cancelSource = appSource.slice(
    appSource.indexOf('  function cancelVoiceRecording('),
    appSource.indexOf('  function clearAgentSelection(')
  );
  const navigateSource = appSource.slice(
    appSource.indexOf('  async function navigateAgent('),
    appSource.indexOf('  const performanceTime =')
  );
  const {navigateAgent} = runInNewContext(`${cancelSource}\n${navigateSource}\n({navigateAgent})`, {
    state,
    $: h.$,
    clearTimeout,
    postAgent,
    selectAgent,
    toast: h.toast
  });
  return {navigation, selectAgent, postAgent, navigateAgent};
}

describe('a correction written while an @mention is open', () => {
  const shiftSource = appSource.slice(
    appSource.indexOf('  function shiftMentionAfterWrite('),
    appSource.indexOf('  // Slash commands:')
  );
  const shiftWith = (state: {mentionStart: number | null; mentionEnd: number | null}) =>
    runInNewContext(`${shiftSource}\nshiftMentionAfterWrite`, {state});

  it('moves a mention after the rewritten text and leaves one before it alone', () => {
    const after = {mentionStart: 10, mentionEnd: 14};
    shiftWith(after)({start: 5, end: 7, text: '修正后的'});
    expect(after).toEqual({mentionStart: 12, mentionEnd: 16});
    const before = {mentionStart: 1, mentionEnd: 3};
    shiftWith(before)({start: 5, end: 7, text: '修正后的'});
    expect(before).toEqual({mentionStart: 1, mentionEnd: 3});
    const closed = {mentionStart: null, mentionEnd: null};
    shiftWith(closed)({start: 5, end: 7, text: '修正后的'});
    expect(closed).toEqual({mentionStart: null, mentionEnd: null});
  });
});

describe('same-Agent branch navigation invalidates voice correction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['ready', 'model', 'context'])(
    'cancels the %s preview before navigation and ignores late replies',
    async phase => {
      const h = harness({includeContext: phase === 'context'}),
        context = deferred();
      if (phase === 'context') h.getContext.mockReturnValueOnce(context.promise);
      h.observe('原分支的原文');
      h.correction.end(h.owner, '原分支的原文');
      if (phase === 'ready') {
        h.requests[0].resolve({corrected: '原分支的候选'});
        await vi.advanceTimersByTimeAsync(0);
      }
      const {navigateAgent, navigation, selectAgent, postAgent} = navigationHarness(h);
      const done = navigateAgent('other-branch-entry');
      expect(postAgent).toHaveBeenCalledWith(h.owner.agentId, '/navigate', {entryId: 'other-branch-entry'});
      expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
      if (phase === 'context') {
        expect(h.getContext.mock.calls[0][1].signal!.aborted).toBe(true);
        context.resolve({context: {latestAssistantMessage: '旧分支上下文'}});
      } else {
        expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
        if (phase === 'model') h.requests[0].resolve({corrected: '迟到的旧候选'});
      }
      await vi.advanceTimersByTimeAsync(0);
      navigation.resolve({});
      await done;
      h.correction.toggle();
      expect(h.correction.session).toBeNull();
      expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
      // A correction written before navigating stays, like any other text in the composer.
      expect(h.input.value).toBe(phase === 'ready' ? '已有草稿 原分支的候选' : '已有草稿 原分支的原文');
      expect(h.onWrite).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
      expect(selectAgent).toHaveBeenCalledWith({agentId: h.owner.agentId});
      if (phase === 'context') expect(h.request).not.toHaveBeenCalled();
    }
  );

  it('keeps the existing draft but not its old preview even when navigation fails', async () => {
    const h = harness();
    h.observe('保留的原文');
    h.correction.end(h.owner, '保留的原文');
    const {navigateAgent, navigation} = navigationHarness(h);
    const done = navigateAgent('invalid-entry');
    navigation.reject(Error('Navigation failed'));
    await expect(done).rejects.toThrow('Navigation failed');
    h.requests[0].resolve({corrected: '迟到的旧候选'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe('已有草稿 保留的原文');
    expect(h.correction.session).toBeNull();
  });
});

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
  const statusSource = appSource.slice(
    appSource.indexOf('  function applyVoiceStatus('),
    appSource.indexOf('  // The page is opened')
  );
  const sottoSaveSource = appSource.slice(
    appSource.indexOf('  async function saveSottoSettings('),
    appSource.indexOf('  function applyVoiceCorrectionSettings(')
  );
  const api = runInNewContext(
    `${statusSource}\n${sottoSaveSource}\n${settingsSource}\n({loadVoiceCorrectionSettings, saveVoiceCorrectionSettings, applyVoiceStatus, saveSottoSettings, saveVoiceInputSettings})`,
    {
      state,
      $: h.$,
      localBackend: () => h.backend,
      backendOf: () => h.backend,
      requestBackend,
      updateVoiceAvailability: vi.fn(),
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

  it('keeps the correction and its undo when fetched settings have not changed', async () => {
    const h = settingsHarness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '修正'});
    await vi.advanceTimersByTimeAsync(0);
    const session = h.correction.session;
    await h.api.loadVoiceCorrectionSettings();
    expect(h.correction.session).toBe(session);
    expect(h.input.value).toBe('已有草稿 修正');
    expect(h.toggle()).toMatchObject({textContent: '恢复原文', disabled: false});
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

  it.each([
    {model: 'new-model'},
    {baseUrl: 'http://localhost:9000/v1'},
    {enabled: false},
    {includeContext: true}
  ])(
    'invalidates an existing candidate before a full status refresh replaces correction settings: %j',
    async patch => {
      const h = settingsHarness();
      h.observe('原文');
      h.correction.end(h.owner, '原文');
      h.requests[0].resolve({corrected: '旧设置的候选'});
      await vi.advanceTimersByTimeAsync(0);
      const settings = {...h.backend.statusInfo.voiceCorrection, ...patch};
      h.api.applyVoiceStatus(h.backend, {...h.backend.statusInfo, voiceCorrection: settings});
      expect(h.backend.statusInfo.voiceCorrection).toEqual(settings);
      expect(h.correction.session).toBeNull();
      expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
      // The written correction is ordinary composer text now; the panel can no longer swap it.
      h.correction.toggle();
      expect(h.input.value).toBe('已有草稿 旧设置的候选');
    }
  );

  it('keeps the session when a full status refresh has unchanged correction settings', async () => {
    const h = settingsHarness();
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    h.requests[0].resolve({corrected: '模型候选'});
    await vi.advanceTimersByTimeAsync(0);
    const session = h.correction.session;
    h.api.applyVoiceStatus(h.backend, {
      ...h.backend.statusInfo,
      voiceCorrection: {...h.backend.statusInfo.voiceCorrection}
    });
    expect(h.correction.session).toBe(session);
    expect(h.input.value).toBe('已有草稿 模型候选');
    h.correction.clear();
  });

  it('cancels a pending candidate on the Sotto-save status refresh, even before reopening configuration', async () => {
    const h = settingsHarness();
    h.state.sottoBackendId = 'local';
    h.$('sottoEndpoint').value = 'http://127.0.0.1:8766';
    h.observe('原文');
    h.correction.end(h.owner, '原文');
    const settings = {...h.backend.statusInfo.voiceCorrection, includeContext: true, model: 'new-model'};
    h.requestBackend
      .mockResolvedValueOnce({enabled: true, endpoint: 'http://127.0.0.1:8766'} as any)
      .mockResolvedValueOnce({...h.backend.statusInfo, voiceCorrection: settings} as any);
    await h.api.saveSottoSettings();
    expect((h.request.mock.calls[0] as any)[2].signal.aborted).toBe(true);
    h.requests[0].resolve({corrected: '晚到的旧候选'});
    await vi.advanceTimersByTimeAsync(0);
    h.setServerSettings(settings);
    await h.api.loadVoiceCorrectionSettings();
    expect(h.backend.statusInfo.voiceCorrection).toEqual(settings);
    expect(h.correction.session).toBeNull();
    expect(h.$('voiceCorrectionPanel').hidden).toBe(true);
    expect(h.input.value).toBe('已有草稿 原文');
  });

  it('can attach correction to an existing live recording when refreshed settings enable it', async () => {
    const h = settingsHarness(false);
    h.observe('录音原文');
    const voice = (h.state.voiceStream = {...h.owner, inserted: '录音原文'});
    h.setServerSettings({enabled: true});
    await h.api.loadVoiceCorrectionSettings();
    expect(h.correction.session.owner).toBe(voice);
    expect(h.correction.session.original).toBe('录音原文');
    expect(h.toggle().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.correction.clear();
  });
});

describe('one save button for the voice input section', () => {
  it.each([true, false])('saves Sotto and correction together (Sotto reachable: %s)', async sottoUp => {
    const h = settingsHarness();
    await h.api.loadVoiceCorrectionSettings();
    h.state.sottoBackendId = 'local';
    h.$('voiceCorrectionModel').value = 'edited-model';
    h.requestBackend.mockImplementation(async (_id: string, url: string, init?: any) => {
      if (url === '/api/v1/sotto-stt') {
        if (!sottoUp) throw Error('Sotto unreachable');
        return {enabled: true, endpoint: 'http://127.0.0.1:8766'};
      }
      if (url === '/api/v1/voice-correction')
        return {settings: JSON.parse(init.body), apiKeyConfigured: false};
      return h.backend.statusInfo;
    });
    await h.api.saveVoiceInputSettings();
    const saved = h.requestBackend.mock.calls.filter(([, , init]: any) => init?.method === 'PUT');
    expect(saved.map(([, url]: any) => url).sort()).toEqual([
      '/api/v1/sotto-stt',
      '/api/v1/voice-correction'
    ]);
    expect(h.backend.statusInfo.voiceCorrection.model).toBe('edited-model');
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith(
      sottoUp ? '语音输入设置已保存' : 'Sotto 设置失败：Sotto unreachable'
    );
    expect(h.$('saveVoiceInput').disabled).toBe(false);
  });
});

describe('character diff between the transcript and its correction', () => {
  const {diffChars} = loadModule();
  const show = (runs: [string, string][]) =>
    runs.map(([op, text]) => (op === '=' ? text : op === '-' ? `[-${text}]` : `{+${text}}`)).join('');

  it('marks inserted punctuation and rewritten words character by character', () => {
    expect(show(diffChars('今天天气很好我们去公园', '今天天气很好，我们去公园。'))).toBe(
      '今天天气很好{+，}我们去公园{+。}'
    );
    expect(show(diffChars('用派森写个脚本', '用 Python 写个脚本'))).toBe('用[-派森]{+ Python }写个脚本');
    expect(diffChars('相同', '相同')).toEqual([['=', '相同']]);
  });

  it('keeps characters outside the basic plane whole', () => {
    expect(show(diffChars('a😀b', 'a😁b'))).toBe('a[-😀]{+😁}b');
  });

  it('rebuilds both texts from a minimal number of edits', () => {
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const text = () => Array.from({length: random(14)}, () => 'ab，。字'[random(5)]).join('');
    const lcs = (a: string[], b: string[]) => {
      const row = new Array(b.length + 1).fill(0);
      for (const x of a) {
        let diagonal = 0;
        for (let j = 1; j <= b.length; j++) {
          const above = row[j];
          row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
          diagonal = above;
        }
      }
      return row[b.length];
    };
    for (let i = 0; i < 500; i++) {
      const before = text(),
        after = text(),
        runs: [string, string][] = diffChars(before, after);
      const join = (skip: string) =>
        runs
          .filter(([op]) => op !== skip)
          .map(([, value]) => value)
          .join('');
      expect(join('+')).toBe(before);
      expect(join('-')).toBe(after);
      const edits = runs.filter(([op]) => op !== '=').reduce((sum, [, value]) => sum + value.length, 0);
      expect(edits).toBe(before.length + after.length - 2 * lcs([...before], [...after]));
    }
  });

  it('shows a whole replacement when the texts differ too much for a readable diff', () => {
    // A minimal diff would keep all 600 “a”s, but needs 1200 edits.
    const before = 'xa'.repeat(600),
      after = 'ya'.repeat(600);
    expect(diffChars(before, after)).toEqual([
      ['-', before.slice(0, -1)],
      ['+', after.slice(0, -1)],
      ['=', 'a']
    ]);
  });
});
