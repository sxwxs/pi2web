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

  it('resamples a browser recording to one channel of 16 kHz float32 PCM', async () => {
    const code = source.slice(source.indexOf('  async function recordingToSottoPcm('), source.indexOf('  async function transcribeVoice('));
    const close = vi.fn(async () => {}), left = new Float32Array(48000).fill(0.5), right = new Float32Array(48000).fill(-0.25);
    const buffer = {length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 2,
      getChannelData: (index: number) => index ? right : left};
    const {recordingToSottoPcm} = runInNewContext(`${code}\n({recordingToSottoPcm})`, {
      window: {AudioContext: class {decodeAudioData = async () => buffer; close = close;}}
    });
    const result = await recordingToSottoPcm({arrayBuffer: async () => new ArrayBuffer(8)});
    expect(result.byteLength).toBe(16000 * 4);
    expect(new Float32Array(result)[0]).toBeCloseTo(0.125);
    expect(close).toHaveBeenCalledOnce();
  });
});
