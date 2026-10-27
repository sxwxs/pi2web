import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

describe('Web Sotto input', () => {
  it('hides the mic until the selected Agent backend has STT enabled', () => {
    const code = source.slice(source.indexOf('  function updateVoiceAvailability()'), source.indexOf('  async function connectBackend('));
    const mic = {hidden: false, title: ''}, playback = {hidden: true};
    const a = {id: 'a', status: 'connected', voiceEnabled: false, voiceSttEnabled: true};
    const b = {id: 'b', status: 'connected', voiceEnabled: false, voiceSttEnabled: false};
    const state: any = {agent: null, voiceEnabled: false, voiceSttEnabled: false};
    const {updateVoiceAvailability} = runInNewContext(`${code}\n({updateVoiceAvailability})`, {
      state, connectedBackends: () => [a, b], backendOf: (id: string) => id === 'a' ? a : b,
      $: (id: string) => id === 'voiceInput' ? mic : playback,
      stopVoiceAudio: vi.fn(), updateVoiceButton: vi.fn()
    });
    updateVoiceAvailability();
    expect(mic.hidden).toBe(true);
    state.agent = {backendId: 'b'};
    updateVoiceAvailability();
    expect(mic.hidden).toBe(true);
    state.agent = {backendId: 'a'};
    updateVoiceAvailability();
    expect(mic.hidden).toBe(false);
    a.voiceSttEnabled = false;
    updateVoiceAvailability();
    expect(mic.hidden).toBe(true);
  });

  it('streams microphone PCM and renders partial text before stopping, without sending a prompt', async () => {
    const code = source.slice(source.indexOf('  function updateSottoDraft('), source.indexOf('  async function toggleVoiceInput('));
    const sent: any[] = [], mic = {disabled: false, textContent: '', title: '', classList: {add: vi.fn(), remove: vi.fn()}},
      input = {value: 'draft ', selectionStart: 6, setRangeText(text: string, start: number, end: number) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
      }}, stopTrack = vi.fn(), closeAudio = vi.fn(async () => {}), prompt = vi.fn();
    const fakeStream = {getTracks: () => [{stop: stopTrack}]};
    const socket: any = {readyState: 1, bufferedAmount: 0, send: vi.fn(data => sent.push(data)), close: vi.fn()};
    const nodes = {connect: vi.fn(), disconnect: vi.fn()};
    class AudioContext {
      sampleRate = 48000;
      destination = {};
      audioWorklet = {addModule: vi.fn(async () => {})};
      createMediaStreamSource = () => ({...nodes});
      createGain = () => ({...nodes, gain: {value: 1}});
      resume = vi.fn(async () => {});
      close = closeAudio;
    }
    class AudioWorkletNode {
      port: any = {onmessage: null};
      connect = vi.fn();
      disconnect = vi.fn();
    }
    const state: any = {agent: {agentId: 'a:one', backendId: 'a'}, voiceStream: null};
    const {startSottoStream, stopSottoStream} = runInNewContext(`${code}\n({startSottoStream, stopSottoStream})`, {
      state, $: (id: string) => id === 'input' ? input : mic,
      backendOf: () => ({base: 'http://127.0.0.1:11318', token: ''}),
      splitResourceKey: () => ({remoteId: 'one'}),
      navigator: {mediaDevices: {getUserMedia: async () => fakeStream}},
      window: {AudioContext, AudioWorkletNode}, AudioWorkletNode,
      WebSocket: Object.assign(function () { return socket; }, {OPEN: 1, CONNECTING: 0}),
      toast: vi.fn(), postAgent: prompt, setTimeout, clearTimeout
    });
    await startSottoStream();
    expect(state.voiceStream).toBeTruthy();
    socket.onmessage({data: JSON.stringify({type: 'ready'})});
    expect(JSON.parse(sent[0])).toMatchObject({type: 'start', sample_rate: 48000});
    state.voiceStream.node.port.onmessage({data: new Float32Array(4096).buffer});
    expect(sent[1].byteLength).toBe(4096 * 4);
    socket.onmessage({data: JSON.stringify({type: 'partial', segment: 0, text: '正在说'})});
    expect(input.value).toBe('draft 正在说');
    stopSottoStream(state.voiceStream);
    expect(JSON.parse(sent[2])).toEqual({type: 'stop'});
    socket.onmessage({data: JSON.stringify({type: 'final', segment: 0, text: '说完了'})});
    expect(input.value).toBe('draft 说完了');
    socket.onclose();
    expect(state.voiceStream).toBeNull();
    expect(stopTrack).toHaveBeenCalled();
    expect(closeAudio).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('renders live partial and final text without overwriting the surrounding draft', () => {
    const code = source.slice(source.indexOf('  function updateSottoDraft('), source.indexOf('  function finishSottoStream('));
    const input = {value: 'prefix  suffix', setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    }};
    const voice: any = {agentId: 'agent-a', input, at: 7, inserted: '', finals: new Map(), partial: ''};
    const state = {voiceStream: voice, agent: {agentId: 'agent-a'}};
    const finish = vi.fn(), toast = vi.fn();
    const {updateSottoDraft} = runInNewContext(`${code}\n({updateSottoDraft})`, {
      state, finishSottoStream: finish, toast
    });
    voice.partial = '你';
    updateSottoDraft(voice);
    expect(input.value).toBe('prefix 你 suffix');
    voice.partial = '你好';
    updateSottoDraft(voice);
    expect(input.value).toBe('prefix 你好 suffix');
    voice.finals.set(0, '你好');
    voice.partial = '世界';
    updateSottoDraft(voice);
    expect(input.value).toBe('prefix 你好 世界 suffix');
    input.value = 'changed';
    updateSottoDraft(voice);
    expect(finish).not.toHaveBeenCalled(); // no update when text itself has not changed
    voice.partial = '世界！';
    updateSottoDraft(voice);
    expect(finish).toHaveBeenCalledOnce();
    expect(input.value).toBe('changed');
  });
});
