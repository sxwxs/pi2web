import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
const voiceStatus = section('  function applyVoiceStatus(', '  async function connectBackend(');
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>(r => {resolve = r;});
  return {promise, resolve};
};

function harness({acquisition, moduleLoad}: {acquisition?: Promise<any>; moduleLoad?: Promise<any>} = {}) {
  const sent: any[] = [], sockets: any[] = [], contexts: any[] = [];
  const mic = {disabled: false, textContent: '', title: '', classList: {add: vi.fn(), remove: vi.fn()}};
  const input = {value: 'draft ', selectionStart: 6, setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  }};
  const track = {stop: vi.fn(), onended: null as null | (() => void)};
  const stream = {getTracks: () => [track]};
  const getUserMedia = vi.fn(() => acquisition ?? Promise.resolve(stream));
  const nodes = () => ({connect: vi.fn(), disconnect: vi.fn()});
  class AudioContext {
    sampleRate = 48000;
    destination = {};
    audioWorklet = {addModule: vi.fn(() => moduleLoad ?? Promise.resolve())};
    createMediaStreamSource = () => nodes();
    createGain = () => ({...nodes(), gain: {value: 1}});
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    constructor() {contexts.push(this);}
  }
  class AudioWorkletNode {
    port: any = {onmessage: null, postMessage: vi.fn()};
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class WebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    send = vi.fn(data => sent.push(data));
    close = vi.fn();
    constructor() {sockets.push(this);}
  }
  const state: any = {agent: {agentId: 'a:one', backendId: 'a'}, voiceStream: null, voiceSttEnabled: true};
  const toast = vi.fn(), prompt = vi.fn();
  const api = runInNewContext(`${section('  function updateSottoDraft(', '  async function transcribeVoice(')}
    ${section('  function cancelVoiceRecording(', '  function clearAgentSelection(')}
    ({startSottoStream, stopSottoStream, finishSottoStream, toggleVoiceInput, cancelVoiceRecording})`, {
    state, $: (id: string) => id === 'input' ? input : mic,
    backendOf: () => ({base: 'http://127.0.0.1:11318', token: '', statusInfo: {sottoStt: {enabled: true}}}),
    splitResourceKey: () => ({remoteId: 'one', backendId: 'a'}),
    navigator: {mediaDevices: {getUserMedia}}, window: {AudioContext, AudioWorkletNode}, AudioWorkletNode,
    WebSocket, toast, postAgent: prompt, setTimeout, clearTimeout
  });
  const message = (value: any) => sockets[0].onmessage({data: JSON.stringify(value)});
  const start = async () => {await api.startSottoStream(); message({type: 'ready'});};
  return {api, state, sent, sockets, contexts, stream, track, getUserMedia, mic, input, toast, prompt, message, start};
}

describe('Web Sotto input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides the mic until the selected Agent backend has STT enabled', () => {
    const mic = {hidden: false, title: ''}, playback = {hidden: true};
    const a = {id: 'a', status: 'connected', voiceEnabled: false, voiceSttEnabled: true};
    const b = {id: 'b', status: 'connected', voiceEnabled: false, voiceSttEnabled: false};
    const state: any = {agent: null};
    const {updateVoiceAvailability} = runInNewContext(`${voiceStatus}\n({updateVoiceAvailability})`, {
      state, connectedBackends: () => [a, b], backendOf: (id: string) => id === 'a' ? a : b,
      $: (id: string) => id === 'voiceInput' ? mic : playback, stopVoiceAudio: vi.fn(), updateVoiceButton: vi.fn()
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

  it.each([false, true])('refreshes authoritative STT capability after saving (independent STT: %s)', async independentStt => {
    const backend: any = {id: 'a', status: 'connected'};
    const elements: any = {sottoEnabled: {checked: false}, sottoEndpoint: {value: 'http://127.0.0.1:8766'}};
    const settings = {enabled: false, endpoint: 'http://127.0.0.1:8766'};
    const requestBackend = vi.fn(async (_id, url) => url === '/api/v1/sotto-stt' ? settings : {
      voiceEnabled: true, voiceCapabilities: {tts: true, stt: independentStt}, sottoStt: settings
    });
    const api = runInNewContext(`${voiceStatus}
      ${section('  async function saveSottoSettings(', '  function updateConfigUi(')}
      ({applyVoiceStatus, saveSottoSettings})`, {
      state: {agent: {backendId: 'a'}, sottoBackendId: 'a'}, backendOf: () => backend,
      connectedBackends: () => [backend], $: (id: string) => elements[id] ??= {}, requestBackend,
      stopVoiceAudio() {}, updateVoiceButton() {}, toast() {}
    });
    api.applyVoiceStatus(backend, {voiceEnabled: true, voiceCapabilities: {tts: true, stt: true}, sottoStt: {enabled: true}});
    await api.saveSottoSettings();
    expect(requestBackend).toHaveBeenLastCalledWith('a', '/api/v1/system/status');
    expect(elements.voiceInput.hidden).toBe(!independentStt);
  });

  it('keeps recording across sentence finals, pauses and the old one-minute limit', async () => {
    const h = harness();
    await h.start();
    h.message({type: 'partial', segment: 0, text: '正在说'});
    expect(h.input.value).toBe('draft 正在说');
    h.message({type: 'final', segment: 0, text: '第一句'});
    vi.advanceTimersByTime(120000);
    expect(h.state.voiceStream.phase).toBe('recording');
    expect(h.track.stop).not.toHaveBeenCalled();
    h.message({type: 'partial', segment: 1, text: '第二句'});
    expect(h.input.value).toBe('draft 第一句 第二句');
    expect(h.prompt).not.toHaveBeenCalled();
    h.api.cancelVoiceRecording();
  });

  it('drains queued PCM and the tail before stop, then accepts final results', async () => {
    const h = harness();
    await h.start();
    const voice = h.state.voiceStream;
    const audio = (size: number) => voice.node.port.onmessage({data: new Float32Array(size).buffer});
    audio(4096);
    h.api.stopSottoStream(voice);
    expect(voice.node.port.postMessage).toHaveBeenCalledWith({type: 'flush'});
    expect(h.sent).toHaveLength(2); // start + audio, no stop yet
    audio(128);
    voice.node.port.onmessage({data: {type: 'flushed'}});
    expect(h.sent[2].byteLength).toBe(128 * 4);
    expect(JSON.parse(h.sent[3])).toEqual({type: 'stop'});
    audio(128);
    expect(h.sent).toHaveLength(4);
    h.message({type: 'final', segment: 0, text: '说完了'});
    h.sockets[0].onclose({code: 1000});
    expect(h.input.value).toBe('draft 说完了');
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
    expect(h.toast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves startup before acquiring the microphone', async () => {
    const acquisition = deferred(), h = harness({acquisition: acquisition.promise});
    const first = h.api.startSottoStream();
    await h.api.startSottoStream();
    expect(h.getUserMedia).toHaveBeenCalledOnce();
    acquisition.resolve(h.stream);
    await first;
    expect(h.contexts).toHaveLength(1);
    h.api.cancelVoiceRecording();
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it('a second click cancels pending acquisition and releases a late microphone', async () => {
    const acquisition = deferred(), h = harness({acquisition: acquisition.promise});
    const first = h.api.toggleVoiceInput();
    await h.api.toggleVoiceInput();
    acquisition.resolve(h.stream);
    await first;
    expect(h.getUserMedia).toHaveBeenCalledOnce();
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.contexts).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });

  it('cancels worklet loading without reviving capture even after returning to the same Agent', async () => {
    const moduleLoad = deferred(), h = harness({moduleLoad: moduleLoad.promise});
    const first = h.api.startSottoStream();
    await vi.waitFor(() => expect(h.contexts).toHaveLength(1));
    h.api.cancelVoiceRecording('a');
    h.state.agent = {agentId: 'b:other', backendId: 'b'};
    h.state.agent = {agentId: 'a:one', backendId: 'a'};
    moduleLoad.resolve();
    await first;
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
    expect(h.sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['socket', 'microphone', 'backpressure', 'startup', 'flush', 'result'])('explains and cleans up %s failures', async failure => {
    const h = harness();
    await h.api.startSottoStream();
    if (failure === 'startup') vi.advanceTimersByTime(30000);
    else {
      h.message({type: 'ready'});
      if (failure === 'socket') h.sockets[0].onclose({code: 1006});
      if (failure === 'microphone') h.track.onended!();
      if (failure === 'backpressure') {
        h.sockets[0].bufferedAmount = 500000;
        h.state.voiceStream.node.port.onmessage({data: new Float32Array(4096).buffer});
      }
      if (failure === 'flush' || failure === 'result') {
        const voice = h.state.voiceStream;
        h.api.stopSottoStream(voice);
        if (failure === 'result') voice.node.port.onmessage({data: {type: 'flushed'}});
        vi.advanceTimersByTime(12000);
      }
    }
    expect(h.state.voiceStream).toBeNull();
    expect(h.toast).toHaveBeenCalledOnce();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
    expect(h.sockets[0].close).toHaveBeenCalledOnce();
    expect(h.mic.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not toggle recording again when the voice shortcut key repeats', () => {
    const input: any = {}, toggleVoiceInput = vi.fn();
    runInNewContext(section("  $('input').onkeydown =", "  $('input').oninput ="), {
      $: () => input, toggleVoiceInput
    });
    const event = {altKey: true, shiftKey: true, key: 'V', repeat: false, preventDefault: vi.fn()};
    input.onkeydown(event);
    input.onkeydown({...event, repeat: true});
    input.onkeydown({...event, repeat: true});
    expect(toggleVoiceInput).toHaveBeenCalledOnce();
  });

  it('does not overwrite a draft edited during recording', async () => {
    const h = harness();
    await h.start();
    h.message({type: 'partial', segment: 0, text: '你好'});
    h.input.value = 'changed';
    h.message({type: 'partial', segment: 0, text: '你好世界'});
    expect(h.state.voiceStream).toBeNull();
    expect(h.input.value).toBe('changed');
    expect(h.toast).toHaveBeenCalledOnce();
  });
});

describe('PCM worklet', () => {
  it.each([0, 128, 4096, 4480])('flushes every one of %i samples before acknowledging, once only', samples => {
    let Processor: any;
    const messages: any[] = [];
    runInNewContext(readFileSync(new URL('../web/voice-pcm.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class {port = {postMessage: (data: any) => messages.push(data)};},
      registerProcessor: (_name: string, processor: any) => {Processor = processor;}
    });
    const node = new Processor();
    for (let i = 0; i < samples; i += 128) node.process([[new Float32Array(128).fill(0.25)]]);
    node.port.onmessage({data: {type: 'flush'}});
    expect(messages.at(-1)).toEqual({type: 'flushed'});
    const audio = messages.slice(0, -1).flatMap(data => [...new Float32Array(data)]);
    expect(audio).toHaveLength(samples);
    expect(audio.every(x => x === 0.25)).toBe(true);
    const count = messages.length;
    node.port.onmessage({data: {type: 'flush'}});
    expect(node.process([[new Float32Array(128)]])).toBe(false);
    expect(messages).toHaveLength(count);
  });
});
