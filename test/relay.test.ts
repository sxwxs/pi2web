import {afterEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {WebSocket, WebSocketServer} from 'ws';
import {RemotePiServer} from '../src/server.js';

/** Shaped like a real pairing code, which is what the relay accepts for a target. */
const TARGET_TOKEN = 'target-token-7VqK3nZt0aLpXb';

type Target = {base:string, requests:{method:string, url:string, authorization?:string, body:string}[], close:() => Promise<void>};

/**
 * Stands in for the pi2web instance the browser cannot reach: it only records what the relay forwards.
 * A null token stands for a target started with --no-auth, which accepts a request without any code.
 */
async function startTarget(token:string|null = TARGET_TOKEN):Promise<Target> {
  const requests:Target['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks:Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({method:req.method ?? '', url:req.url ?? '', authorization:req.headers.authorization, body:Buffer.concat(chunks).toString()});
      if (token !== null && req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end('{"error":{"message":"nope"}}') }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({data:{seen:req.url}}));
    });
  });
  const sockets = new WebSocketServer({server, path:'/api/v1/ws'});
  sockets.on('connection', (socket, req) => {
    socket.send(JSON.stringify({protocol:req.headers['sec-websocket-protocol']}));
    socket.on('message', data => socket.send(String(data) === 'snapshot' ? 'B'.repeat(3 * 1024 * 1024) : `echo:${data}`));
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
  const created = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'lab', base:target.base, token:TARGET_TOKEN})});
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
    expect(target!.requests.at(-1)).toMatchObject({method:'GET', url:'/api/v1/agents?limit=2', authorization:`Bearer ${TARGET_TOKEN}`});

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

  it('stores a prefix a path can be appended to, and only a pairing code it could have issued', async () => {
    const {base, headers} = await start();
    const register = (body:unknown) => fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify(body)});
    // A query or fragment would swallow the relayed path, and a fragment makes the WebSocket throw.
    const trimmed = await register({name:'trimmed', base:'http://10.0.0.5:11318/edge/?probe=1#top'});
    expect((await trimmed.json()).data.base).toBe('http://10.0.0.5:11318/edge');
    expect((await register({name:'creds', base:'http://user:pw@10.0.0.6:11318'})).status).toBe(400);
    // A code with a space cannot be sent as a subprotocol, so it is refused here, not at connect time.
    const spaced = await register({name:'spaced', base:'http://10.0.0.7:11318', token:'has a space'});
    expect(spaced.status).toBe(400);
    // The only way out for a code an older version allowed has to be in the message that refuses it.
    expect((await spaced.json()).error.message).toContain('--rotate-access-token');
    expect((await register({name:'short', base:'http://10.0.0.7:11318', token:'short'})).status).toBe(400);
  });

  it('survives a saved host that no longer passes validation', async () => {
    const {base, headers, token} = await start();
    // Written the way a record saved before that validation existed would look.
    server!.metadata.setSetting('relayHosts', [{id:'host-legacy', name:'legacy', base:'http://127.0.0.1:1/#top', token:'has a space', createdAt:new Date().toISOString()}]);
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/hosts/host-legacy/api/v1/ws`, [`access-token.${token}`]);
    await expect(new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject) })).rejects.toThrow();
    // The handshake fails on its own socket instead of taking the process down with it.
    expect((await fetch(`${base}/api/v1/hosts`, {headers})).status).toBe(200);
  });

  it('deletes a host and rejects an invalid base', async () => {
    const {base, headers, host} = await start();
    expect((await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'bad', base:'ftp://example.com'})})).status).toBe(400);
    expect((await fetch(`${base}/api/v1/hosts/${host.id}`, {method:'DELETE', headers})).status).toBe(200);
    expect((await (await fetch(`${base}/api/v1/hosts`, {headers})).json()).data).toEqual([]);
    expect((await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`, {headers})).status).toBe(404);
    // Deleting it again says "not there" in a way the browser can tell from "could not reach it", so a
    // cascade that failed halfway can be retried without reporting the part that already succeeded.
    const again = await fetch(`${base}/api/v1/hosts/${host.id}`, {method:'DELETE', headers});
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe('HOST_NOT_FOUND');
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
    expect(JSON.parse(messages[0]).protocol).toBe(`access-token.${TARGET_TOKEN}`);
    expect(messages[1]).toBe('echo:ping');
  });

  it('relays without a pairing code when neither end asks for one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi2web-relay-noauth-'));
    server = new RemotePiServer({port:0, dataDir:dir, noAuth:true});
    const address = await server.start();
    target = await startTarget(null);
    const base = `http://127.0.0.1:${address!.port}`;
    const created = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'local', base:target.base})});
    expect(created.status).toBe(201);
    const host = (await created.json()).data;
    expect(host.hasToken).toBe(false);

    expect((await fetch(`${base}/api/v1/hosts/${host.id}/api/v1/agents`)).status).toBe(200);
    // Nothing to authenticate with and nothing to invent: the target must see no Authorization header.
    expect(target!.requests.at(-1)!.authorization).toBeUndefined();
  });

  it('carries a reply larger than the limit on commands coming the other way', async () => {
    const {base, token, host} = await start();
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/hosts/${host.id}/api/v1/ws`, [`access-token.${token}`]);
    // An Agent snapshot with large tool results passes straight to a direct browser, so it must pass here.
    const received = await new Promise<number|string>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('close', code => resolve(`closed ${code}`));
      socket.on('message', data => { if (String(data).startsWith('B')) resolve(String(data).length) });
      socket.on('open', () => socket.send('snapshot'));
    });
    socket.close();
    expect(received).toBe(3 * 1024 * 1024);
  });

  it('does not let a target that never answers hold the browser or the shutdown', async () => {
    const {base, headers, token} = await start();
    // Accepts the connection and then says nothing at all, the one case with no error to react to.
    const pending:net.Socket[] = [];
    const silent = net.createServer(socket => { pending.push(socket) });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as {port:number}).port;
    const created = await fetch(`${base}/api/v1/hosts`, {method:'POST', headers, body:JSON.stringify({name:'silent', base:`http://127.0.0.1:${port}`})});
    const host = (await created.json()).data;

    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/hosts/${host.id}/api/v1/ws`, [`access-token.${token}`]);
    socket.on('error', () => {});
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(socket.readyState).toBe(WebSocket.CONNECTING);

    // A handshake nobody will ever answer must not hold the shutdown with it.
    const started = Date.now();
    await server!.stop();
    server = undefined;
    expect(Date.now() - started).toBeLessThan(2000);

    for (const socket of pending) socket.destroy();
    await new Promise<void>(resolve => silent.close(() => resolve()));
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
