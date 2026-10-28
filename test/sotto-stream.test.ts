import {describe, it, expect, vi} from 'vitest';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket, WebSocketServer} from 'ws';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';

const temp = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));
const message = (ws: WebSocket): Promise<any> =>
  new Promise(resolve => ws.once('message', data => resolve(JSON.parse(String(data)))));

describe('live browser dictation relay', () => {
  it('relays partial and final results over the authenticated Agent WebSocket, without a second model', async () => {
    const audio = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          stt: true,
          format: 'pcm-f32le',
          sample_rate: 16000,
          stream_port: (audio.address() as any).port + 2
        })
      );
    });
    let remote: WebSocketServer | undefined,
      port = 0;
    for (let attempt = 0; attempt < 20 && !remote; attempt++) {
      const candidate = 20000 + Math.floor(Math.random() * 20000);
      try {
        await new Promise<void>((resolve, reject) =>
          audio.listen(candidate, '127.0.0.1', resolve).once('error', reject)
        );
        const server = new WebSocketServer({port: candidate + 2, host: '127.0.0.1'});
        await once(server, 'listening');
        remote = server;
        port = candidate;
      } catch {
        if (audio.listening) await new Promise<void>(resolve => audio.close(() => resolve()));
      }
    }
    if (!remote) throw new Error('No available adjacent local ports for Sotto streaming test');
    remote.on('connection', socket => {
      socket.send(JSON.stringify({type: 'ready', model: 'one-shared-ASR'}));
      socket.on('message', (data, binary) => {
        if (binary) socket.send(JSON.stringify({type: 'partial', segment: 0, text: '正在说'}));
        else if (JSON.parse(String(data)).type === 'stop') {
          socket.send(JSON.stringify({type: 'final', segment: 0, text: '说完了'}));
          socket.close(1000);
        }
      });
    });
    const workspaces = new WorkspaceStore();
    const agents = new AgentManager(workspaces, (id, cwd) => new MockBackend(id, cwd));
    const server = new RemotePiServer({
      port: 0,
      noAuth: true,
      dataDir: await temp('pi2web-stream-'),
      workspaces,
      agents
    });
    let browser: WebSocket | undefined;
    const tabs: WebSocket[] = [];
    try {
      const address = await server.start();
      const base = `http://127.0.0.1:${address!.port}`;
      await server.sottoStt.update({enabled: true, endpoint: `http://127.0.0.1:${port}`});
      const post = async (url: string, data: any) =>
        (
          await (
            await fetch(base + url, {
              method: 'POST',
              headers: {'content-type': 'application/json'},
              body: JSON.stringify(data)
            })
          ).json()
        ).data;
      const workspace = await post('/api/v1/workspaces', {
        label: 'w',
        rootPath: await temp('pi2web-stream-ws-')
      });
      const agent = await post('/api/v1/agents', {workspaceId: workspace.id});
      // Transcription is a backend capability, not tied to an Agent on this backend.
      browser = new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/transcribe/ws`);
      const ready = message(browser);
      await once(browser, 'open');
      expect((await ready).type).toBe('ready');
      browser.send(JSON.stringify({type: 'start', format: 'float32', sample_rate: 16000}));
      // More than 60 seconds of PCM must not hit a cumulative audio limit.
      for (let i = 0; i < 120; i++) {
        browser.send(new Float32Array(8192));
        expect(await message(browser)).toMatchObject({type: 'partial', text: '正在说'});
      }
      const stopped = once(browser, 'close');
      browser.send(JSON.stringify({type: 'stop'}));
      expect(await message(browser)).toMatchObject({type: 'final', text: '说完了'});
      expect((await stopped)[0]).toBe(1000);

      // A ws parser error occurs before our message handler. It must not crash the backend.
      browser = new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/agents/${agent.agentId}/transcribe/ws`);
      const nextReady = message(browser);
      await once(browser, 'open');
      await nextReady;
      const rejected = once(browser, 'close');
      browser.send(Buffer.alloc(2 * 1024 * 1024 + 1));
      expect((await rejected)[0]).toBe(1009);
      expect((await fetch(base + '/api/v1/system/status')).status).toBe(200);
      const badAudio = await fetch(base + '/api/v1/transcribe', {
        method: 'POST',
        headers: {'content-type': 'audio/webm'},
        body: Buffer.alloc(8)
      });
      expect(badAudio.status).toBe(400);

      // The backend-wide switch ends all existing streams, not just the tab saving settings.
      for (let i = 0; i < 2; i++) {
        const tab = new WebSocket(
          `ws://127.0.0.1:${address!.port}/api/v1/agents/${agent.agentId}/transcribe/ws`
        );
        tabs.push(tab);
        const tabReady = message(tab);
        await once(tab, 'open');
        expect((await tabReady).type).toBe('ready');
        tab.send(JSON.stringify({type: 'start', format: 'float32', sample_rate: 48000}));
      }
      const stoppedTabs = tabs.map(tab => once(tab, 'close'));
      const errors = tabs.map(tab => message(tab));
      const response = await fetch(base + '/api/v1/sotto-stt', {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({enabled: false, endpoint: `http://127.0.0.1:${port}`})
      });
      expect(response.status).toBe(200);
      for (const error of errors)
        expect(await error).toMatchObject({type: 'error', message: expect.stringContaining('关闭')});
      for (const stoppedTab of stoppedTabs) expect((await stoppedTab)[0]).toBe(1011);
      await vi.waitFor(() => expect(remote!.clients.size).toBe(0));
    } finally {
      browser?.terminate();
      for (const tab of tabs) tab.terminate();
      await server.stop();
      await new Promise<void>(resolve => remote!.close(() => resolve()));
      await new Promise<void>(resolve => audio.close(() => resolve()));
    }
  });
});
