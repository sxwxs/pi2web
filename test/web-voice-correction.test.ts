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
function harness({enabled = true, remote = false} = {}) {
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
  const backend = {id: 'local', statusInfo: {voiceCorrection: {enabled}}};
  let agent = {agentId: remote ? 'remote:agent' : 'local:agent', backendId: remote ? 'remote' : 'local'};
  const owner = {agentId: agent.agentId, transcribeBackendId: backend.id, input, at: input.value.length};
  const requests: ReturnType<typeof deferred>[] = [];
  const request = vi.fn(() => {
    const d = deferred();
    requests.push(d);
    return d.promise;
  });
  const toast = vi.fn(),
    onAccept = vi.fn(),
    window: any = {};
  runInNewContext(source, {window, setTimeout, clearTimeout, AbortController});
  const correction = new window.RemotePiVoiceCorrection.VoiceCorrection({
    $,
    getAgent: () => agent,
    getBackend: () => backend,
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
