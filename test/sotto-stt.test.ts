import {describe, it, expect, vi} from 'vitest';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';
import {SottoSttService} from '../src/sotto-stt.js';
import type {MetadataStore} from '../src/metadata-store.js';

const temp = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));

describe('local Sotto STT configuration and proxy', () => {
  it('probes candidates without publishing them or rolling back another successful save', async () => {
    let reject!: (error: Error) => void;
    const slow = new Promise<Response>((_resolve, r) => {
      reject = r;
    });
    const setSetting = vi.fn();
    const fetcher = vi.fn((url: any) =>
      String(url).includes(':20000/')
        ? slow
        : Promise.resolve(
            new Response(
              JSON.stringify({
                stt: true,
                format: 'pcm-f32le',
                sample_rate: 16000,
                stream_port: 30002
              })
            )
          )
    );
    const service = new SottoSttService({setSetting} as unknown as MetadataStore, fetcher);
    const original = service.getSettings();
    const pending = service.update({enabled: true, endpoint: 'http://127.0.0.1:20000'}).catch(error => error);
    expect(service.getSettings()).toEqual(original);
    expect(setSetting).not.toHaveBeenCalled();
    const saved = await service.update({enabled: true, endpoint: 'http://127.0.0.1:30000'});
    reject(new Error('probe failed'));
    expect((await pending).code).toBe('SOTTO_UNAVAILABLE');
    expect(service.getSettings()).toEqual(saved);
    expect(setSetting).toHaveBeenCalledExactlyOnceWith('sottoStt', saved);
  });

  it('does not publish settings if persistence fails', async () => {
    const service = new SottoSttService({
      setSetting: () => {
        throw Error('disk full');
      }
    } as unknown as MetadataStore);
    const original = service.getSettings();
    await expect(service.update({enabled: false, endpoint: 'http://127.0.0.1:20000'})).rejects.toThrow(
      'disk full'
    );
    expect(service.getSettings()).toEqual(original);
  });

  it('denies the restricted Sotto draft token access to STT configuration', async () => {
    const server = new RemotePiServer({port: 0, dataDir: await temp('pi2web-sotto-auth-')});
    const {token} = await server.auth.init();
    const voiceToken = await server.auth.rotateVoice();
    try {
      const address = await server.start();
      const url = `http://127.0.0.1:${address!.port}/api/v1/sotto-stt`;
      expect((await fetch(url, {headers: {authorization: `Bearer ${voiceToken}`}})).status).toBe(403);
      expect(
        (
          await fetch(url, {
            method: 'PUT',
            headers: {authorization: `Bearer ${voiceToken}`, 'content-type': 'application/json'},
            body: JSON.stringify({enabled: true, endpoint: 'http://127.0.0.1:8766'})
          })
        ).status
      ).toBe(403);
      expect((await fetch(url, {headers: {authorization: `Bearer ${token}`}})).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('starts hidden, rejects remote endpoints, uses an authenticated local PCM proxy, and persists the setting', async () => {
    let loads = 0,
      calls = 0;
    const sotto = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/capabilities') {
        loads++;
        return res.end(
          JSON.stringify({
            stt: true,
            format: 'pcm-f32le',
            sample_rate: 16000,
            stream_port: (sotto.address() as any).port + 2
          })
        );
      }
      if (req.url === '/api/transcribe') {
        expect(req.headers['content-type']).toBe('application/octet-stream');
        let bytes = 0;
        for await (const chunk of req) bytes += chunk.length;
        expect(bytes).toBe(16000 * 4);
        calls++;
        return res.end(JSON.stringify({text: '测试语音'}));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>(resolve => sotto.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(sotto.address() as any).port}`;
    const workspaces = new WorkspaceStore();
    const agents = new AgentManager(workspaces, (id, cwd) => new MockBackend(id, cwd));
    const dataDir = await temp('pi2web-sotto-');
    const server = new RemotePiServer({port: 0, noAuth: true, dataDir, workspaces, agents});
    try {
      const address = await server.start();
      const base = `http://127.0.0.1:${address!.port}`;
      const call = async (method: string, url: string, data?: unknown) => {
        const response = await fetch(base + url, {
          method,
          headers: {'content-type': 'application/json'},
          ...(data === undefined ? {} : {body: JSON.stringify(data)})
        });
        return {status: response.status, body: (await response.json()) as any};
      };
      expect((await call('GET', '/api/v1/system/status')).body.data.voiceCapabilities.stt).toBe(false);
      expect((await call('GET', '/api/v1/sotto-stt')).body.data).toEqual({
        enabled: false,
        endpoint: 'http://127.0.0.1:8766'
      });
      for (const bad of [
        'https://example.com',
        'http://localhost:8766',
        'http://127.0.0.1:8766@evil.example',
        'http://127.0.0.1:8766/other',
        'http://127.0.0.1:8766?x=1'
      ])
        expect((await call('PUT', '/api/v1/sotto-stt', {enabled: true, endpoint: bad})).status).toBe(400);
      expect((await call('PUT', '/api/v1/sotto-stt', {enabled: true, endpoint})).body.data.enabled).toBe(
        true
      );
      expect(loads).toBe(1);
      expect((await call('GET', '/api/v1/system/status')).body.data.voiceCapabilities.stt).toBe(true);
      const workspace = (
        await call('POST', '/api/v1/workspaces', {label: 'x', rootPath: await temp('pi2web-sotto-ws-')})
      ).body.data;
      const agent = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id})).body.data;
      const url = `/api/v1/agents/${agent.agentId}/transcribe`;
      expect(
        (
          await fetch(base + url, {
            method: 'POST',
            headers: {'content-type': 'audio/webm'},
            body: new Uint8Array(8)
          })
        ).status
      ).toBe(400);
      const audio = new Float32Array(16000).buffer;
      const result = await fetch(base + url, {
        method: 'POST',
        headers: {'content-type': 'application/octet-stream'},
        body: audio
      });
      expect((await result.json()).data.text).toBe('测试语音');
      expect(calls).toBe(1);
      expect((await call('PUT', '/api/v1/sotto-stt', {enabled: false, endpoint})).body.data.enabled).toBe(
        false
      );
      expect((await call('GET', '/api/v1/system/status')).body.data.voiceCapabilities.stt).toBe(false);
      expect(
        (
          await fetch(base + url, {
            method: 'POST',
            headers: {'content-type': 'application/octet-stream'},
            body: audio
          })
        ).status
      ).toBe(503);
      const restored = new RemotePiServer({port: 0, noAuth: true, dataDir});
      try {
        await restored.start();
        expect(restored.sottoStt.getSettings()).toEqual({enabled: false, endpoint});
      } finally {
        await restored.stop();
      }
    } finally {
      await server.stop();
      await new Promise<void>(resolve => sotto.close(() => resolve()));
    }
  });
});
