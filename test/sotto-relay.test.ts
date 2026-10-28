import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SottoSttService} from '../src/sotto-stt.js';
import {WebSocket} from 'ws';

vi.mock('ws', async () => {
  const {EventEmitter} = await import('node:events');
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 2;
    });
    terminate = vi.fn(() => {
      this.readyState = 3;
    });
    static latest: WebSocket;
    constructor() {
      super();
      WebSocket.latest = this;
    }
  }
  return {WebSocket};
});

function relay() {
  const client = new WebSocket('ws://browser');
  const setSetting = vi.fn();
  const service = new SottoSttService(
    {getSetting: () => ({enabled: true, endpoint: 'http://127.0.0.1:8766'}), setSetting} as any,
    vi.fn(
      async (url: any) =>
        new Response(
          JSON.stringify({
            stt: true,
            format: 'pcm-f32le',
            sample_rate: 16000,
            stream_port: Number(new URL(String(url)).port) + 2
          })
        )
    )
  );
  service.load();
  service.stream(client);
  const upstream: WebSocket = (WebSocket as any).latest;
  const start = () =>
    client.emit(
      'message',
      Buffer.from(JSON.stringify({type: 'start', format: 'float32', sample_rate: 16000})),
      false
    );
  const pcm = () => client.emit('message', Buffer.alloc(4096 * 4), true);
  const stop = () => client.emit('message', Buffer.from('{"type":"stop"}'), false);
  return {client, upstream, start, pcm, stop, service, setSetting};
}

describe('Sotto relay lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends an existing relay immediately when its service is disabled', async () => {
    const r = relay();
    r.start();
    await r.service.update({enabled: false, endpoint: 'http://127.0.0.1:8766'});
    expect(r.client.close).toHaveBeenCalled();
    expect(r.upstream.close).toHaveBeenCalled();
    const sent = vi.mocked(r.upstream.send).mock.calls.length;
    r.pcm();
    expect(r.upstream.send).toHaveBeenCalledTimes(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a stream when its endpoint changes but not when the same settings are saved', async () => {
    const r = relay();
    r.start();
    await r.service.update({enabled: true, endpoint: 'http://127.0.0.1:8766'});
    expect(r.client.close).not.toHaveBeenCalled();
    await r.service.update({enabled: true, endpoint: 'http://127.0.0.1:9000'});
    expect(r.client.close).toHaveBeenCalledOnce();
    expect(r.upstream.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a stream when saving fails and unregisters a closed stream', async () => {
    const r = relay();
    r.start();
    r.setSetting.mockImplementationOnce(() => {
      throw Error('disk full');
    });
    await expect(r.service.update({enabled: false, endpoint: 'http://127.0.0.1:8766'})).rejects.toThrow(
      'disk full'
    );
    expect(r.client.close).not.toHaveBeenCalled();
    expect(r.service.getSettings().enabled).toBe(true);
    r.client.emit('close');
    await r.service.update({enabled: false, endpoint: 'http://127.0.0.1:8766'});
    expect(r.client.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps silence/audio flowing beyond the former 75-second deadline', () => {
    const r = relay();
    r.start();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20000);
      r.pcm(); // all-zero PCM is a pause, not a stalled microphone
    }
    expect(r.client.close).not.toHaveBeenCalled();
    expect(r.upstream.send).toHaveBeenCalledTimes(11);
    r.client.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explains a capture stall and releases the upstream and timer', () => {
    const r = relay();
    r.start();
    vi.advanceTimersByTime(30000);
    expect(JSON.parse((r.client.send as any).mock.calls[0][0])).toMatchObject({
      type: 'error',
      message: expect.stringContaining('stalled')
    });
    expect(r.client.close).toHaveBeenCalledWith(1011);
    expect(r.upstream.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a browser protocol error even while upstream is connecting', () => {
    const r = relay();
    Object.assign(r.upstream, {readyState: WebSocket.CONNECTING});
    expect(() => r.client.emit('error', new Error('maxPayload'))).not.toThrow();
    expect(r.upstream.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('only treats an upstream close as success after stop (stopped: %s)', stopped => {
    const r = relay();
    r.start();
    if (stopped) r.stop();
    r.upstream.emit('close', 1000);
    expect(r.client.close).toHaveBeenCalledWith(stopped ? 1000 : 1011);
    expect(r.client.send).toHaveBeenCalledTimes(stopped ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([3, 32772])('rejects invalid PCM frame size %i with an explanation', length => {
    const r = relay();
    r.start();
    r.client.emit('message', Buffer.alloc(length), true);
    expect(r.client.close).toHaveBeenCalledWith(1009);
    expect(JSON.parse((r.client.send as any).mock.calls[0][0]).type).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });
});
