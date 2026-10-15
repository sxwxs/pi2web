import {afterEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WebSocket, WebSocketServer} from 'ws';
import {RemotePiServer} from '../src/server.js';

type Target = {base:string, requests:{method:string, url:string, authorization?:string, body:string}[], close:() => Promise<void>};

/** Stands in for the pi2web instance the browser cannot reach: it only records what the relay forwards. */
async function startTarget():Promise<Target> {
  const requests:Target['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks:Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({method:req.method ?? '', url:req.url ?? '', authorization:req.headers.authorization, body:Buffer.concat(chunks).toString()});
      if (req.headers.authorization !== 'Bearer target-token') { res.statusCode = 401; return res.end('{"error":{"message":"nope"}}') }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({data:{seen:req.url}}));
    });
  });
  const sockets = new WebSocketServer({server, path:'/api/v1/ws'});
  sockets.on('connection', (socket, req) => {
    socket.send(JSON.stringify({protocol:req.headers['sec-websocket-protocol']}));
    socket.on('message', data => socket.send(`echo:${data}`));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port:number}).port;
  return {
    base:`http://127.0.0.1:${port}`,
    requests,
    close:() => new Promise<void>(resolve => { sockets.close(); server.close(() => resolve()) }),
  };
}

let server:RemotePiServer | undefined, target:Target | undefined;
afterEach(async () => { await server?.stop(); server = undefined; await target?.close(); target = undefined });

async function start() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi2web-relay-'));
  server = new RemotePiServer({port:0, dataDir:dir});
  const first = await server.auth.init();
  const address = await server.start();
  target = await startTarget();
  const base = `http://127.0.0.1:${address!.port}`, headers = {Authorization:`Bearer ${first.token}`, 'Content-Type':'application/json'};
  const created = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'lab', base:target.base, token:'target-token'})});
  const host = (await created.json()).data;
  return {base, headers, token:first.token!, host, status:created.status};
}

describe('backend relay', () => {
  it('forwards requests to the saved target and authenticates them there', async () => {
    const {base, headers, host} = await start();
    expect(host).toMatchObject({name:'lab', hasToken:true});
    expect(host.token).toBeUndefined();

    const relayed = await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents?limit=2`, {headers});
    expect(relayed.status).toBe(200);
    expect((await relayed.json()).data).toEqual({seen:'/api/v1/agents?limit=2'});
    expect(target!.requests.at(-1)).toMatchObject({method:'GET', url:'/api/v1/agents?limit=2', authorization:'Bearer target-token'});

    const posted = await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`, {method:'POST', headers, body:JSON.stringify({workspaceId:'w'})});
    expect(posted.status).toBe(200);
    expect(target!.requests.at(-1)).toMatchObject({method:'POST', body:'{"workspaceId":"w"}'});
  });

  it('requires this server\'s own pairing code and a known host', async () => {
    const {base, headers, host} = await start();
    expect((await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/hosts`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/hosts/host-unknown/api/v1/agents`, {headers})).status).toBe(404);
    expect(target!.requests).toHaveLength(0);
  });

  it('returns the existing host when the same target is added again', async () => {
    const {base, headers, host, status} = await start();
    expect(status).toBe(201);
    const again = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'lab from phone', base:target!.base})});
    expect(again.status).toBe(200);
    const second = (await again.json()).data;
    expect(second).toMatchObject({id:host.id, name:'lab from phone', hasToken:true});

    const listed = await (await fetch(`${base}/api/v1/hosts`, {headers})).json();
    expect(listed.data).toHaveLength(1);
  });

  it('deletes a host and rejects an invalid base', async () => {
    const {base, headers, host} = await start();
    expect((await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'bad', base:'ftp://example.com'})})).status).toBe(400);
    expect((await fetch(`${base}/api/v1/hosts/${host.id}`, {method:'DELETE', headers})).status).toBe(200);
    expect((await (await fetch(`${base}/api/v1/hosts`, {headers})).json()).data).toEqual([]);
    expect((await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`, {headers})).status).toBe(404);
  });

  it('pipes websocket frames through to the target', async () => {
    const {base, token, host} = await start();
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/hosts/${host.id}/api/v1/ws`, [`access-token.${token}`]);
    const messages:string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', data => { messages.push(String(data)); if (messages.length === 2) resolve() });
      socket.on('open', () => socket.send('ping'));
    });
    socket.close();
    // The target sees its own pairing code, never the one the browser used to reach this server.
    expect(JSON.parse(messages[0]).protocol).toBe('access-token.target-token');
    expect(messages[1]).toBe('echo:ping');
  });

  it('closes relayed sockets on shutdown', async () => {
    const {base, token, host} = await start();
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/hosts/${host.id}/api/v1/ws`, [`access-token.${token}`]);
    await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject) });
    const closed = new Promise<void>(resolve => socket.on('close', () => resolve()));
    // A relayed socket that nobody tracks would keep server.close() waiting forever.
    await server!.stop();
    server = undefined;
    await closed;
  });

  it('reports an unreachable target instead of hanging', async () => {
    const {base, headers} = await start();
    const created = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'down', base:'http://127.0.0.1:1'})});
    const host = (await created.json()).data;
    const relayed = await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`, {headers});
    expect(relayed.status).toBe(502);
    expect((await relayed.json()).error.code).toBe('RELAY_FAILED');
  });
});
