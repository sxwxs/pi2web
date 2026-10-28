import type {MetadataStore} from './metadata-store.js';
import {WebSocket} from 'ws';

export const DEFAULT_SOTTO_ENDPOINT = 'http://127.0.0.1:8766';
export type SottoSttSettings = {enabled: boolean; endpoint: string};
const invalid = (message: string, code = 'INVALID_SOTTO_SETTINGS') =>
  Object.assign(new Error(message), {code});

/** No arbitrary URLs: the Sotto Web API is local-only, and this server is the authenticated proxy. */
export function validateSottoEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw invalid('Sotto endpoint must be a loopback HTTP URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Sotto endpoint must be a valid URL');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  )
    throw invalid('Sotto endpoint must be http://127.0.0.1:<port> with no path or credentials');
  return url.origin;
}

/** An authenticated browser socket relays only audio and start/stop, never a Sotto control API. */
function proxySottoStream(client: WebSocket, url: string) {
  const upstream = new WebSocket(url, {handshakeTimeout: 5000, maxPayload: 65536});
  let started = false,
    finished = false,
    closed = false;
  let timer: ReturnType<typeof setTimeout>;
  const close = () => {
    closed = true;
    clearTimeout(timer);
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  const fail = (message: string, code = 1011) => {
    if (closed) return;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({type: 'error', message}));
      client.close(code);
    }
    close();
  };
  // Silence still contains PCM. Only a stalled capture/connection times out, not a long dictation.
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fail('Audio stream stalled: no microphone frames received for 30 seconds'),
      30000
    );
  };
  touch();
  client.on('close', close);
  client.on('error', close);
  upstream.on('error', () => fail('Sotto streaming service is unavailable'));
  upstream.on('close', code => {
    if (closed) return;
    if (!finished || code !== 1000) fail('Sotto streaming connection closed unexpectedly');
    else {
      clearTimeout(timer);
      if (client.readyState === WebSocket.OPEN) client.close(1000);
    }
  });
  upstream.on('message', (data, binary) => {
    if (closed || binary || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1_000_000) {
      fail('Transcription receiver is too slow', 1009);
      return;
    }
    client.send(data.toString());
  });
  client.on('message', (data, binary) => {
    if (closed || finished || client.readyState !== WebSocket.OPEN) return;
    const length = (data as Buffer).byteLength;
    if (upstream.readyState !== WebSocket.OPEN) {
      fail('Sotto streaming service is not ready');
      return;
    }
    if (!binary) {
      try {
        const value = JSON.parse(data.toString());
        if (
          !started &&
          value.type === 'start' &&
          value.format === 'float32' &&
          Number.isInteger(value.sample_rate) &&
          value.sample_rate >= 16000 &&
          value.sample_rate <= 96000
        ) {
          started = true;
          upstream.send(JSON.stringify({type: 'start', format: 'float32', sample_rate: value.sample_rate}));
          touch();
        } else if (started && value.type === 'stop') {
          finished = true;
          upstream.send(JSON.stringify({type: 'stop'}));
        } else fail('Invalid audio protocol', 1008);
      } catch {
        fail('Invalid audio protocol', 1008);
      }
    } else if (
      started &&
      length > 0 &&
      length % 4 === 0 &&
      length <= 32768 &&
      upstream.bufferedAmount < 1_000_000
    ) {
      upstream.send(data, {binary: true});
      touch();
    } else fail('Invalid audio frame or Sotto cannot keep up with microphone audio', 1009);
  });
  return fail;
}

export class SottoSttService {
  private streams = new Set<(reason: string) => void>();
  private settings: SottoSttSettings = {enabled: false, endpoint: DEFAULT_SOTTO_ENDPOINT};
  /** Bumped by every update, so a slow enable probe cannot overwrite a newer choice. */
  private updates = 0;
  constructor(
    private readonly metadata: MetadataStore,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  load() {
    const saved = this.metadata.getSetting<Partial<SottoSttSettings>>('sottoStt');
    if (saved && typeof saved.enabled === 'boolean') {
      try {
        this.settings = {enabled: saved.enabled, endpoint: validateSottoEndpoint(saved.endpoint)};
      } catch {
        /* Corrupt or obsolete settings must not enable an untrusted destination. */
      }
    }
  }
  getSettings(): SottoSttSettings {
    return {...this.settings};
  }
  streamUrl() {
    if (!this.settings.enabled) throw invalid('Sotto transcription is disabled', 'SOTTO_DISABLED');
    const port = Number(new URL(this.settings.endpoint).port) + 2;
    if (port > 65535) throw invalid('Invalid Sotto streaming port');
    return `ws://127.0.0.1:${port}/asr`;
  }
  stream(client: WebSocket) {
    const stop = proxySottoStream(client, this.streamUrl());
    this.streams.add(stop);
    client.once('close', () => this.streams.delete(stop));
  }
  private async request(endpoint: string, path: string, init: RequestInit, timeoutMs: number) {
    const response = await this.fetcher(`${endpoint}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(error => {
      throw invalid(`Cannot reach local Sotto: ${(error as Error).message}`, 'SOTTO_UNAVAILABLE');
    });
    if (!response.ok) {
      const message = (await response.json().catch(() => ({}))) as {error?: string};
      throw invalid(message.error || `Sotto returned HTTP ${response.status}`, 'SOTTO_UNAVAILABLE');
    }
    return response;
  }
  async update(input: unknown) {
    if (!input || typeof input !== 'object') throw invalid('enabled and endpoint are required');
    const {enabled, endpoint} = input as Record<string, unknown>;
    if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean');
    const next = {enabled, endpoint: validateSottoEndpoint(endpoint)};
    const update = ++this.updates;
    if (enabled) {
      const capabilities = await (
        await this.request(next.endpoint, '/api/capabilities', {method: 'GET'}, 4000)
      ).json();
      if (
        capabilities?.stt !== true ||
        capabilities?.format !== 'pcm-f32le' ||
        capabilities?.sample_rate !== 16000 ||
        capabilities?.stream_port !== Number(new URL(next.endpoint).port) + 2
      )
        throw invalid('Sotto does not support live PCM transcription', 'SOTTO_UNAVAILABLE');
      if (update !== this.updates)
        throw invalid('Sotto settings were changed by a newer request', 'SOTTO_SETTINGS_SUPERSEDED');
    }
    this.metadata.setSetting('sottoStt', next);
    const changed = !next.enabled || next.endpoint !== this.settings.endpoint;
    this.settings = next;
    if (changed) {
      for (const stop of this.streams) stop('Sotto 语音输入已关闭或服务地址已更改');
      this.streams.clear();
    }
    return this.getSettings();
  }
  async transcribe(audio: Buffer) {
    if (!this.settings.enabled) throw invalid('Sotto transcription is disabled', 'SOTTO_DISABLED');
    if (!audio.length || audio.length % 4 || audio.length > 16000 * 4 * 60)
      throw invalid('Expected at most 60 seconds of 16 kHz float32 PCM');
    const response = await this.request(
      this.settings.endpoint,
      '/api/transcribe',
      {
        method: 'POST',
        headers: {'content-type': 'application/octet-stream'},
        body: new Uint8Array(audio)
      },
      120000
    );
    const body = (await response.json()) as {text?: unknown};
    if (typeof body.text !== 'string') throw invalid('Invalid response from Sotto', 'SOTTO_UNAVAILABLE');
    return {text: body.text};
  }
}
