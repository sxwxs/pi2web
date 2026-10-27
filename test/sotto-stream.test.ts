import {describe, it, expect} from 'vitest';
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
const message = (ws: WebSocket): Promise<any> => new Promise(resolve => ws.once('message', data => resolve(JSON.parse(String(data)))));

describe('live browser dictation relay', () => {
  it('relays partial and final results over the authenticated Agent WebSocket, without a second model', async () => {
    const audio = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({stt: true, format: 'pcm-f32le', sample_rate: 16000, stream_port: (audio.address() as any).port + 2}));
    });
    let remote: WebSocketServer | undefined, port = 0;
    for (let attempt = 0; attempt < 20 && !remote; attempt++) {
      const candidate = 20000 + Math.floor(Math.random() * 20000);
      try {
        await new Promise<void>((resolve, reject) => audio.listen(candidate, '127.0.0.1', resolve).once('error', reject));
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
          socket.close();
        }
      });
    });
    const workspaces = new WorkspaceStore();
    const agents = new AgentManager(workspaces, (id, cwd) => new MockBackend(id, cwd));
    const server = new RemotePiServer({port: 0, noAuth: true, dataDir: await temp('pi2web-stream-'), workspaces, agents});
    let browser: WebSocket | undefined;
    try {
      const address = await server.start();
      const base = `http://127.0.0.1:${address!.port}`;
      await server.sottoStt.update({enabled: true, endpoint: `http://127.0.0.1:${port}`});
      const post = async (url: string, data: any) => (await (await fetch(base + url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)})).json()).data;
      const workspace = await post('/api/v1/workspaces', {label: 'w', rootPath: await temp('pi2web-stream-ws-')});
      const agent = await post('/api/v1/agents', {workspaceId: workspace.id});
      browser = new WebSocket(`ws://127.0.0.1:${address!.port}/api/v1/agents/${agent.agentId}/transcribe/ws`);
      const ready = message(browser);
      await once(browser, 'open');
      expect((await ready).type).toBe('ready');
      browser.send(JSON.stringify({type: 'start', format: 'float32', sample_rate: 48000}));
      browser.send(new Float32Array(4096));
      expect(await message(browser)).toMatchObject({type: 'partial', text: '正在说'});
      browser.send(JSON.stringify({type: 'stop'}));
      expect(await message(browser)).toMatchObject({type: 'final', text: '说完了'});
    } finally {
      browser?.terminate();
      await server.stop();
      await new Promise<void>(resolve => remote!.close(() => resolve()));
      await new Promise<void>(resolve => audio.close(() => resolve()));
    }
  });
});
