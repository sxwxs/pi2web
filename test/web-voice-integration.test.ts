import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const draft = source.slice(
  source.indexOf('  const handledDrafts = new Set()'),
  source.indexOf('  function handleAgentEvent(')
);

describe('recorded audio transcription into the Web UI input', () => {
  const transcription = source.slice(
    source.indexOf('  async function transcribeVoice('),
    source.indexOf('  const handledDrafts = new Set()')
  );
  function harness() {
    const input = {value: '已有草稿', focus: vi.fn()};
    const backend = {id: 'local', base: 'http://localhost:11318', status: 'connected'};
    const correction = {begin: vi.fn(), end: vi.fn(), clear: vi.fn()};
    const state: any = {
      mediaRecorder: {mimeType: 'audio/webm'},
      mediaChunks: [],
      mediaAgentId: 'remote:agent',
      mediaBackendId: 'local',
      agent: {agentId: 'remote:agent'},
      voiceCorrection: correction,
      voiceStream: null,
      pendingTranscription: null
    };
    const requests: {resolve: (response: Response) => void; reject: (error: Error) => void}[] = [];
    const fetcher = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          requests.push({resolve, reject});
        })
    );
    const elements: any = {input},
      toast = vi.fn();
    const cancellation = source.slice(
      source.indexOf('  function cancelVoiceRecording('),
      source.indexOf('  function clearAgentSelection(')
    );
    const {transcribeVoice, cancelVoiceRecording} = runInNewContext(
      `${cancellation}\n${transcription}\n({transcribeVoice, cancelVoiceRecording})`,
      {
        state,
        Blob,
        AbortController,
        clearTimeout,
        splitResourceKey: (id: string) => ({backendId: id.split(':')[0]}),
        backendOf: () => backend,
        fetch: fetcher,
        $: (id: string) => (elements[id] ??= {classList: {remove: vi.fn()}}),
        toast
      }
    );
    return {
      input,
      state,
      correction,
      transcribeVoice,
      cancelVoiceRecording,
      requests,
      toast,
      elements,
      resolve: (response: Response) => requests[0].resolve(response),
      fetcher
    };
  }
  it('corrects a recorded result through the speech backend while keeping the original in the composer', async () => {
    const h = harness(),
      done = h.transcribeVoice();
    h.resolve(new Response(JSON.stringify({data: {text: '识别原文'}})));
    await done;
    expect(h.input.value).toBe('已有草稿 识别原文');
    const owner = h.correction.begin.mock.calls[0][0];
    expect(owner).toMatchObject({agentId: 'remote:agent', transcribeBackendId: 'local', at: 5});
    expect(h.correction.end).toHaveBeenCalledWith(owner, '识别原文');
    expect(h.fetcher.mock.calls[0][0]).toBe('http://localhost:11318/api/v1/transcribe');
  });
  it('does not insert or correct a late transcription after switching Agent', async () => {
    const h = harness(),
      done = h.transcribeVoice();
    h.state.agent = {agentId: 'remote:other'};
    h.resolve(new Response(JSON.stringify({data: {text: '晚到原文'}})));
    await done;
    expect(h.input.value).toBe('已有草稿');
    expect(h.correction.begin).not.toHaveBeenCalled();
  });
  it('does not restore cancelled text or a preview after switching away and back to the same Agent', async () => {
    const h = harness(),
      done = h.transcribeVoice();
    const signal = h.fetcher.mock.calls[0][1].signal!;
    expect(h.state.mediaAgentId).toBeNull();
    h.cancelVoiceRecording();
    h.state.agent = {agentId: 'remote:other'};
    h.cancelVoiceRecording();
    h.state.agent = {agentId: 'remote:agent'};
    expect(signal.aborted).toBe(true);
    expect(h.elements.voiceInput.disabled).toBe(false);
    h.resolve(new Response(JSON.stringify({data: {text: '晚到原文'}})));
    await done;
    expect(h.input.value).toBe('已有草稿');
    expect(h.correction.begin).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });
  it.each(['local', 'remote'])(
    'cancels a pending transcription when its %s backend is disconnected',
    async backendId => {
      const h = harness(),
        done = h.transcribeVoice();
      h.cancelVoiceRecording(backendId);
      expect(h.fetcher.mock.calls[0][1].signal!.aborted).toBe(true);
      h.requests[0].reject(new Error('aborted'));
      await done;
      expect(h.state.pendingTranscription).toBeNull();
      expect(h.toast).not.toHaveBeenCalled();
    }
  );
  it('leaves an unrelated backend transcription running', async () => {
    const h = harness(),
      done = h.transcribeVoice();
    const pending = h.state.pendingTranscription;
    h.cancelVoiceRecording('unrelated');
    expect(h.state.pendingTranscription).toBe(pending);
    expect(h.fetcher.mock.calls[0][1].signal!.aborted).toBe(false);
    h.resolve(new Response(JSON.stringify({data: {text: '有效原文'}})));
    await done;
    expect(h.input.value).toBe('已有草稿 有效原文');
  });
  it.each(['success', 'error'])(
    'an old %s does not change the new request or its microphone button',
    async outcome => {
      const h = harness(),
        old = h.transcribeVoice();
      h.cancelVoiceRecording();
      h.state.mediaRecorder = {mimeType: 'audio/webm'};
      h.state.mediaChunks = [];
      h.state.mediaAgentId = 'remote:agent';
      h.state.mediaBackendId = 'local';
      const current = h.transcribeVoice(),
        pending = h.state.pendingTranscription;
      if (outcome === 'success')
        h.requests[0].resolve(new Response(JSON.stringify({data: {text: '旧结果'}})));
      else h.requests[0].reject(new Error('旧请求失败'));
      await old;
      expect(h.state.pendingTranscription).toBe(pending);
      expect(h.elements.voiceInput.disabled).toBe(true);
      expect(h.input.value).toBe('已有草稿');
      expect(h.correction.begin).not.toHaveBeenCalled();
      expect(h.toast).not.toHaveBeenCalled();
      h.requests[1].resolve(new Response(JSON.stringify({data: {text: '新结果'}})));
      await current;
      expect(h.input.value).toBe('已有草稿 新结果');
      expect(h.state.pendingTranscription).toBeNull();
      expect(h.elements.voiceInput.disabled).toBe(false);
    }
  );
});

describe('draft into the current Web UI input', () => {
  it.each(['voiceStream', 'mediaRecorder', 'pendingTranscription'])(
    'inserts and acknowledges external text without taking the preview from %s',
    active => {
      const sent: any[] = [],
        input = {value: '录音原文', focus: vi.fn(), setSelectionRange: vi.fn()};
      const backend = {id: 'local', ws: {readyState: 1, send: (text: string) => sent.push(JSON.parse(text))}};
      const correction = {begin: vi.fn(), end: vi.fn()};
      const state = {
        selectedKind: 'agent',
        agent: {agentId: 'local:agent', backendId: 'local'},
        voiceCorrection: correction,
        [active]: {}
      };
      const {handleDraftEvent} = runInNewContext(`${draft}\n({handleDraftEvent})`, {
        state,
        backendOf: () => backend,
        localBackend: () => backend,
        WebSocket: {OPEN: 1},
        $: () => input,
        toast: vi.fn()
      });
      handleDraftEvent({backendId: 'local', draft: {id: 'external', text: '外部原文', mode: 'append'}});
      expect(input.value).toBe('录音原文 外部原文');
      expect(sent).toEqual([{type: 'draft_ack', id: 'external'}]);
      expect(correction.begin).not.toHaveBeenCalled();
      expect(correction.end).not.toHaveBeenCalled();
    }
  );
  it('still corrects external text when no recording or transcription owns the preview', () => {
    const input = {value: '草稿', focus: vi.fn(), setSelectionRange: vi.fn()};
    const backend = {id: 'local'},
      correction = {begin: vi.fn(), end: vi.fn()};
    const state = {
      selectedKind: 'agent',
      agent: {agentId: 'local:agent', backendId: 'local'},
      voiceCorrection: correction
    };
    const {handleDraftEvent} = runInNewContext(`${draft}\n({handleDraftEvent})`, {
      state,
      backendOf: () => backend,
      localBackend: () => backend,
      WebSocket: {OPEN: 1},
      $: () => input,
      toast: vi.fn()
    });
    handleDraftEvent({backendId: 'local', draft: {id: 'external', text: '外部原文', mode: 'append'}});
    const owner = correction.begin.mock.calls[0][0];
    expect(owner).toMatchObject({agentId: 'local:agent', transcribeBackendId: 'local', at: 3});
    expect(correction.end).toHaveBeenCalledWith(owner, '外部原文');
  });
  it('never switches Agent and only inserts into the displayed backend', () => {
    const sent: any[] = [],
      input = {value: 'hello', focus: vi.fn(), setSelectionRange: vi.fn(), scrollTop: 0, scrollHeight: 10};
    const backend = {id: 'a', ws: {readyState: 1, send: (message: string) => sent.push(JSON.parse(message))}};
    const state: any = {selectedKind: 'agent', agent: {agentId: 'b:other', backendId: 'b'}};
    const selectAgent = vi.fn();
    const {handleDraftEvent} = runInNewContext(`${draft}\n({handleDraftEvent})`, {
      state,
      backendOf: () => backend,
      WebSocket: {OPEN: 1},
      $: () => input,
      toast: vi.fn(),
      selectAgent
    });
    const message = {backendId: 'a', draft: {id: 'one', text: 'world', mode: 'append'}};
    handleDraftEvent(message);
    expect(input.value).toBe('hello');
    expect(sent).toEqual([]);
    state.agent = {agentId: 'a:current', backendId: 'a'};
    handleDraftEvent(message);
    expect(input.value).toBe('hello world');
    expect(sent).toEqual([{type: 'draft_ack', id: 'one'}]);
    handleDraftEvent(message);
    expect(input.value).toBe('hello world');
    expect(sent).toHaveLength(2); // replay: re-ack, never insert twice
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it('leaves text pending until the page has an Agent selected', () => {
    const sent: any[] = [],
      input = {value: '', focus: vi.fn(), setSelectionRange: vi.fn(), scrollTop: 0, scrollHeight: 0};
    const backend = {id: 'a', ws: {readyState: 1, send: (message: string) => sent.push(JSON.parse(message))}};
    const state: any = {selectedKind: 'agent', agent: null};
    const {handleDraftEvent} = runInNewContext(`${draft}\n({handleDraftEvent})`, {
      state,
      backendOf: () => backend,
      WebSocket: {OPEN: 1},
      $: () => input,
      toast: vi.fn()
    });
    const message = {backendId: 'a', draft: {id: 'two', text: 'memo', mode: 'replace'}};
    handleDraftEvent(message);
    expect(input.value).toBe('');
    expect(sent).toEqual([]);
    state.agent = {agentId: 'a:current', backendId: 'a'};
    handleDraftEvent(message);
    expect(input.value).toBe('memo');
    expect(sent).toEqual([{type: 'draft_ack', id: 'two'}]);
  });
});
