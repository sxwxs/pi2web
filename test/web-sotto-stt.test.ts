import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
const voiceStatus = section('  function applyVoiceStatus(', '  async function connectBackend(');
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>(r => {
    resolve = r;
  });
  return {promise, resolve};
};

function harness({
  acquisition,
  moduleLoad,
  remote = false
}: {acquisition?: Promise<any>; moduleLoad?: Promise<any>; remote?: boolean} = {}) {
  const sent: any[] = [],
    sockets: any[] = [],
    contexts: any[] = [];
  const mic = {
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    classList: {add: vi.fn(), remove: vi.fn()}
  };
  const input = {
    value: 'draft ',
    selectionStart: 6,
    setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    }
  };
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
    constructor() {
      contexts.push(this);
    }
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
    url: string;
    send = vi.fn(data => sent.push(data));
    close = vi.fn();
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
  }
  const state: any = {
    agent: remote ? {agentId: 'b:remote', backendId: 'b'} : {agentId: 'a:one', backendId: 'a'},
    voiceStream: null,
    voiceSttEnabled: true
  };
  const toast = vi.fn(),
    prompt = vi.fn();
  const backend = {
    id: 'a',
    status: 'connected',
    voiceSttEnabled: true,
    base: 'http://127.0.0.1:11318',
    token: '',
    statusInfo: {sottoStt: {enabled: true}}
  };
  const remoteBackend = {id: 'b', status: 'connected', voiceSttEnabled: false};
  const api = runInNewContext(
    `${voiceStatus}
    ${section('  function updateSottoDraft(', '  async function transcribeVoice(')}
    ${section('  function cancelVoiceRecording(', '  function clearAgentSelection(')}
    ({startSottoStream, stopSottoStream, finishSottoStream, toggleVoiceInput, cancelVoiceRecording, applyVoiceStatus, updateVoiceAvailability})`,
    {
      state,
      location: {origin: backend.base},
      $: (id: string) => (id === 'input' ? input : mic),
      backendOf: (id: string) => (id === 'b' ? remoteBackend : backend),
      connectedBackends: () => (remote ? [remoteBackend, backend] : [backend]),
      stopVoiceAudio: vi.fn(),
      updateVoiceButton: vi.fn(),
      splitResourceKey: (id: string) => ({remoteId: id.split(':')[1], backendId: id.split(':')[0]}),
      navigator: {mediaDevices: {getUserMedia}},
      window: {AudioContext, AudioWorkletNode},
      AudioWorkletNode,
      WebSocket,
      toast,
      postAgent: prompt,
      setTimeout,
      clearTimeout
    }
  );
  const message = (value: any) => sockets[0].onmessage({data: JSON.stringify(value)});
  const start = async () => {
    await api.startSottoStream();
    message({type: 'ready'});
  };
  return {
    api,
    backend,
    state,
    sent,
    sockets,
    contexts,
    stream,
    track,
    getUserMedia,
    mic,
    input,
    toast,
    prompt,
    message,
    start
  };
}

describe('Web Sotto input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses only the page-serving local backend for speech, even on a remote Agent', () => {
    const mic = {hidden: false, title: ''},
      playback = {hidden: true};
    const a = {
      id: 'a',
      base: 'http://127.0.0.1:11318',
      status: 'connected',
      voiceEnabled: false,
      voiceSttEnabled: true
    };
    const b = {
      id: 'b',
      base: 'https://remote.example',
      status: 'connected',
      voiceEnabled: false,
      voiceSttEnabled: false
    };
    const state: any = {agent: null};
    const {updateVoiceAvailability} = runInNewContext(`${voiceStatus}\n({updateVoiceAvailability})`, {
      state,
      location: {origin: a.base},
      connectedBackends: () => [b, a],
      backendOf: (id: string) => (id === 'a' ? a : b),
      $: (id: string) => (id === 'voiceInput' ? mic : playback),
      stopVoiceAudio: vi.fn(),
      updateVoiceButton: vi.fn()
    });
    updateVoiceAvailability();
    expect(mic.hidden).toBe(true);
    state.agent = {backendId: 'b'};
    updateVoiceAvailability();
    expect(mic.hidden).toBe(false);
    state.agent = {backendId: 'a'};
    updateVoiceAvailability();
    expect(mic.hidden).toBe(false);
    a.voiceSttEnabled = false;
    b.voiceSttEnabled = true;
    updateVoiceAvailability();
    expect(mic.hidden).toBe(true); // Remote recognition is never a fallback.
  });

  it('always edits the page-serving backend settings, not the selected remote workspace', () => {
    const local = {id: 'local', base: 'http://127.0.0.1:11318', status: 'connected'};
    const remote = {id: 'remote', base: 'https://remote.example', status: 'connected'};
    const {sottoConfigBackend} = runInNewContext(
      `${voiceStatus}\n${section('  function sottoConfigBackend()', '  async function loadSottoSettings()')}\n({sottoConfigBackend})`,
      {
        state: {workspace: {backendId: 'remote'}},
        location: {origin: local.base},
        connectedBackends: () => [remote, local]
      }
    );
    expect(sottoConfigBackend()).toBe(local);
    local.status = 'off';
    expect(sottoConfigBackend()).toBeNull();
  });

  it.each([false, true])(
    'refreshes authoritative STT capability after saving (independent STT: %s)',
    async independentStt => {
      const backend: any = {id: 'a', base: 'http://127.0.0.1:11318', status: 'connected'};
      const elements: any = {sottoEnabled: {checked: false}, sottoEndpoint: {value: 'http://127.0.0.1:8766'}};
      const settings = {enabled: false, endpoint: 'http://127.0.0.1:8766'};
      const requestBackend = vi.fn(async (_id, url) =>
        url === '/api/v1/sotto-stt'
          ? settings
          : {
              voiceEnabled: true,
              voiceCapabilities: {tts: true, stt: independentStt},
              sottoStt: settings
            }
      );
      const api = runInNewContext(
        `${voiceStatus}
      ${section('  async function saveSottoSettings(', '  function updateConfigUi(')}
      ({applyVoiceStatus, saveSottoSettings})`,
        {
          state: {agent: {backendId: 'a'}, sottoBackendId: 'a'},
          location: {origin: 'http://127.0.0.1:11318'},
          backendOf: () => backend,
          connectedBackends: () => [backend],
          $: (id: string) => (elements[id] ??= {}),
          requestBackend,
          stopVoiceAudio() {},
          updateVoiceButton() {},
          toast() {}
        }
      );
      api.applyVoiceStatus(backend, {
        voiceEnabled: true,
        voiceCapabilities: {tts: true, stt: true},
        sottoStt: {enabled: true}
      });
      await api.saveSottoSettings();
      expect(requestBackend).toHaveBeenLastCalledWith('a', '/api/v1/system/status');
      expect(elements.voiceInput.hidden).toBe(!independentStt);
    }
  );

  it('streams a remote Agent draft through the local speech backend and cancels when it changes', async () => {
    const h = harness({remote: true});
    h.api.updateVoiceAvailability();
    expect(h.mic.hidden).toBe(false);
    await h.start();
    expect(h.sockets[0].url).toBe('ws://127.0.0.1:11318/api/v1/transcribe/ws');
    expect(h.state.voiceStream.agentId).toBe('b:remote');
    expect(h.state.voiceStream.transcribeBackendId).toBe('a');
    h.api.applyVoiceStatus(h.backend, {sottoStt: {enabled: false}, voiceCapabilities: {stt: false}});
    expect(h.state.voiceStream).toBeNull();
  });

  it.each([false, true])(
    'stops Sotto before updating availability when it is disabled (other STT: %s)',
    async independentStt => {
      const h = harness();
      await h.start();
      h.api.applyVoiceStatus(h.backend, {
        sottoStt: {enabled: false},
        voiceCapabilities: {tts: false, stt: independentStt}
      });
      h.api.updateVoiceAvailability();
      expect(h.state.voiceStream).toBeNull();
      expect(h.track.stop).toHaveBeenCalledOnce();
      expect(h.contexts[0].close).toHaveBeenCalledOnce();
      expect(h.sockets[0].close).toHaveBeenCalledOnce();
      expect(h.mic.hidden).toBe(!independentStt);
    }
  );

  it('invalidates pending microphone permission when Sotto is disabled', async () => {
    const acquisition = deferred(),
      h = harness({acquisition: acquisition.promise});
    const starting = h.api.startSottoStream();
    h.api.applyVoiceStatus(h.backend, {sottoStt: {enabled: false}, voiceCapabilities: {stt: false}});
    acquisition.resolve(h.stream);
    await starting;
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.contexts).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });

  it('does not interrupt a different Backend and ends capture when its own endpoint changes', async () => {
    const h = harness();
    await h.start();
    h.api.applyVoiceStatus({id: 'b'}, {sottoStt: {enabled: false}});
    expect(h.state.voiceStream.phase).toBe('recording');
    h.api.applyVoiceStatus(h.backend, {
      sottoStt: {enabled: true, endpoint: 'http://127.0.0.1:9000'},
      voiceCapabilities: {stt: true}
    });
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it('applies a saved disable even if the subsequent status refresh fails', async () => {
    const h = harness();
    await h.start();
    h.state.sottoBackendId = 'a';
    const elements: any = {sottoEnabled: {checked: false}, sottoEndpoint: {value: 'http://127.0.0.1:8766'}};
    const {saveSottoSettings} = runInNewContext(
      `${section('  async function saveSottoSettings(', '  function updateConfigUi(')}\n({saveSottoSettings})`,
      {
        state: h.state,
        $: (id: string) => (elements[id] ??= {}),
        backendOf: () => h.backend,
        applyVoiceStatus: h.api.applyVoiceStatus,
        updateVoiceAvailability: h.api.updateVoiceAvailability,
        requestBackend: async (_id: string, url: string) => {
          if (url === '/api/v1/sotto-stt') return {enabled: false, endpoint: 'http://127.0.0.1:8766'};
          throw Error('status unavailable');
        },
        toast: h.toast
      }
    );
    await saveSottoSettings();
    expect(h.state.voiceStream).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it('keeps an existing recording stoppable even when starting a new one is unavailable', async () => {
    const h = harness();
    await h.start();
    h.state.voiceSttEnabled = false;
    h.state.agent = null;
    await h.api.toggleVoiceInput();
    expect(h.state.voiceStream.phase).toBe('draining');
    expect(h.track.stop).toHaveBeenCalledOnce();
    h.api.cancelVoiceRecording();
  });

  it('keeps recording while text keeps arriving and stops after one minute without new text', async () => {
    const h = harness();
    await h.start();
    h.message({type: 'partial', segment: 0, text: '正在说'});
    expect(h.input.value).toBe('draft 正在说');
    vi.advanceTimersByTime(50000);
    h.message({type: 'final', segment: 0, text: '第一句'});
    vi.advanceTimersByTime(50000);
    h.message({type: 'partial', segment: 1, text: '第二句'});
    vi.advanceTimersByTime(50000);
    h.message({type: 'partial', segment: 1, text: '第二句'}); // repeated text is not new input
    expect(h.state.voiceStream.phase).toBe('recording');
    expect(h.track.stop).not.toHaveBeenCalled();
    expect(h.input.value).toBe('draft 第一句 第二句');
    vi.advanceTimersByTime(10000);
    // Same as a manual stop: drain and finalise, keeping the recognised text.
    expect(h.state.voiceStream.phase).toBe('draining');
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.toast).toHaveBeenCalledWith('1 分钟没有新的识别文字，语音输入已自动停止');
    expect(h.input.value).toBe('draft 第一句 第二句');
    expect(h.prompt).not.toHaveBeenCalled();
    h.api.cancelVoiceRecording();
  });

  it.each(['current', 'terminal', 'other', 'failed'])(
    'cancels recording only when its Agent is successfully archived (%s)',
    async scenario => {
      const h = harness();
      await h.start();
      h.state.extensionStatus = new Map();
      h.state.widgets = new Map();
      const elements: any = {input: h.input, voiceInput: h.mic};
      const target = scenario === 'other' ? {agentId: 'a:two'} : h.state.agent;
      const {selectTerminal} = runInNewContext(
        `${section('  function clearAgentSelection(', '  function clearTerminalSelection(')}
        ${section('  async function selectTerminal(', '  const autoBindNewSession')}
        ${section("  $('menuArchiveAgent').onclick =", "  document.addEventListener('click'")}
        ({selectTerminal})`,
        {
          state: h.state,
          $: (id: string) => (elements[id] ??= {}),
          localStorage: {removeItem: vi.fn()},
          cancelVoiceRecording: h.api.cancelVoiceRecording,
          agentContextTarget: {kind: 'agent', item: target},
          confirm: () => true,
          postAgent: async () => {
            if (scenario === 'failed') throw Error('archive failed');
          },
          sessionKeyboard: {unbind: vi.fn()},
          refreshAgents: vi.fn(),
          toast: h.toast,
          updateVoiceAvailability: vi.fn(),
          sendFocus: vi.fn(),
          renderExtensionStatus: vi.fn(),
          renderWidgets: vi.fn(),
          updateTerminalHeader: vi.fn(),
          renderAgentList: vi.fn(),
          syncWorkspaceForSelection: vi.fn(),
          connectTerminalSocket: vi.fn()
        }
      );
      if (scenario === 'terminal') {
        await selectTerminal({terminalId: 'a:terminal', backendId: 'a'}, false);
        expect(elements.prompt.hidden).toBe(true);
        expect(h.state.voiceStream.phase).toBe('recording');
        expect(h.track.stop).not.toHaveBeenCalled();
      }
      await elements.menuArchiveAgent.onclick();
      const archived = scenario === 'current' || scenario === 'terminal';
      expect(h.track.stop).toHaveBeenCalledTimes(archived ? 1 : 0);
      expect(h.contexts[0].close).toHaveBeenCalledTimes(archived ? 1 : 0);
      expect(h.sockets[0].close).toHaveBeenCalledTimes(archived ? 1 : 0);
      if (archived) {
        expect(h.state.agent).toBeNull();
        expect(h.state.voiceStream).toBeNull();
      } else {
        expect(h.state.agent.agentId).toBe('a:one');
        expect(h.state.voiceStream.phase).toBe('recording');
        h.api.cancelVoiceRecording();
      }
    }
  );

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
    const acquisition = deferred(),
      h = harness({acquisition: acquisition.promise});
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
    const acquisition = deferred(),
      h = harness({acquisition: acquisition.promise});
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
    const moduleLoad = deferred(),
      h = harness({moduleLoad: moduleLoad.promise});
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

  it.each(['socket', 'microphone', 'backpressure', 'startup', 'flush', 'result'])(
    'explains and cleans up %s failures',
    async failure => {
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
    }
  );

  it('does not toggle recording again when the voice shortcut key repeats', () => {
    const input: any = {},
      toggleVoiceInput = vi.fn();
    runInNewContext(section("  $('input').onkeydown =", "  $('input').oninput ="), {
      $: () => input,
      toggleVoiceInput
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
  it.each([0, 128, 4096, 4480])(
    'flushes every one of %i samples before acknowledging, once only',
    samples => {
      let Processor: any;
      const messages: any[] = [];
      runInNewContext(readFileSync(new URL('../web/voice-pcm.js', import.meta.url), 'utf8'), {
        AudioWorkletProcessor: class {
          port = {postMessage: (data: any) => messages.push(data)};
        },
        registerProcessor: (_name: string, processor: any) => {
          Processor = processor;
        }
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
    }
  );
});
