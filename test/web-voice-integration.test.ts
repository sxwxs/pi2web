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
    const correction = {begin: vi.fn(), end: vi.fn()};
    const state: any = {
      mediaRecorder: {mimeType: 'audio/webm'},
      mediaChunks: [],
      mediaAgentId: 'remote:agent',
      mediaBackendId: 'local',
      agent: {agentId: 'remote:agent'},
      voiceCorrection: correction
    };
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>(r => {
      resolve = r;
    });
    const fetcher = vi.fn(() => response);
    const elements: any = {input};
    const {transcribeVoice} = runInNewContext(`${transcription}\n({transcribeVoice})`, {
      state,
      Blob,
      clearTimeout,
      backendOf: () => backend,
      fetch: fetcher,
      $: (id: string) => (elements[id] ??= {classList: {remove: vi.fn()}}),
      toast: vi.fn()
    });
    return {input, state, correction, transcribeVoice, resolve, fetcher};
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
});

describe('draft into the current Web UI input', () => {
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
