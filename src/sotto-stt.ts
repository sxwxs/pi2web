import type {MetadataStore} from './metadata-store.js';

export const DEFAULT_SOTTO_ENDPOINT = 'http://127.0.0.1:8766';
export type SottoSttSettings = {enabled: boolean; endpoint: string};
const invalid = (message: string, code = 'INVALID_SOTTO_SETTINGS') => Object.assign(new Error(message), {code});

/** No arbitrary URLs: the Sotto Web API is local-only, and this server is the authenticated proxy. */
export function validateSottoEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw invalid('Sotto endpoint must be a loopback HTTP URL');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Sotto endpoint must be a valid URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw invalid('Sotto endpoint must be http://127.0.0.1:<port> with no path or credentials');
  return url.origin;
}

export class SottoSttService {
  private settings: SottoSttSettings = {enabled: false, endpoint: DEFAULT_SOTTO_ENDPOINT};
  constructor(private readonly metadata: MetadataStore, private readonly fetcher: typeof fetch = fetch) {}
  load() {
    const saved = this.metadata.getSetting<Partial<SottoSttSettings>>('sottoStt');
    if (saved && typeof saved.enabled === 'boolean') {
      try { this.settings = {enabled: saved.enabled, endpoint: validateSottoEndpoint(saved.endpoint)}; }
      catch { /* Corrupt or obsolete settings must not enable an untrusted destination. */ }
    }
  }
  getSettings(): SottoSttSettings { return {...this.settings}; }
  private async request(path: string, init: RequestInit, timeoutMs: number) {
    const response = await this.fetcher(`${this.settings.endpoint}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
    }).catch(error => { throw invalid(`Cannot reach local Sotto: ${(error as Error).message}`, 'SOTTO_UNAVAILABLE'); });
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
    if (enabled) {
      const previous = this.settings;
      try {
        this.settings = next;
        const capabilities = await (await this.request('/api/capabilities', {method: 'GET'}, 4000)).json();
        if (capabilities?.stt !== true || capabilities?.format !== 'pcm-f32le' || capabilities?.sample_rate !== 16000)
          throw invalid('Sotto does not support 16 kHz PCM transcription', 'SOTTO_UNAVAILABLE');
      } catch (error) { this.settings = previous; throw error; }
    }
    this.settings = next;
    this.metadata.setSetting('sottoStt', next);
    return this.getSettings();
  }
  async transcribe(audio: Buffer) {
    if (!this.settings.enabled) throw invalid('Sotto transcription is disabled', 'SOTTO_DISABLED');
    if (!audio.length || audio.length % 4 || audio.length > 16000 * 4 * 60)
      throw invalid('Expected at most 60 seconds of 16 kHz float32 PCM');
    const response = await this.request('/api/transcribe', {
      method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: new Uint8Array(audio)
    }, 120000);
    const body = await response.json() as {text?: unknown};
    if (typeof body.text !== 'string') throw invalid('Invalid response from Sotto', 'SOTTO_UNAVAILABLE');
    return {text: body.text};
  }
}
