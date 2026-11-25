import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {once} from 'node:events';
import {Check} from 'typebox/value';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';
import {MailNotifier} from '../src/mail-notifier.js';
import {computeNextRun, parseCronExpression, parseIntervalMs} from '../src/schedules.js';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};

class TrackingBackend extends MockBackend {
  prompts: string[] = [];
  private gate?: {resolve: () => void};
  override async prompt(message: string, onAccepted?: () => void) {
    this.prompts.push(message);
    await super.prompt(message, onAccepted);
    (this as any).emit({type: 'agent_settled', aborted: false});
  }
  override async abort() {
    const wasStreaming = (await this.getState()).status === 'streaming';
    await super.abort();
    if (wasStreaming) (this as any).emit({type: 'agent_settled', aborted: true});
  }
  holdNextTurn() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
      resolve = r;
    });
    this.gate = {resolve};
    this.runTurn = () => promise;
    return () => {
      this.gate?.resolve();
      this.runTurn = () => new Promise<void>(r => setTimeout(r, 0));
    };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('schedule expression parser', () => {
  it('parses cron and interval expressions and computes the next local trigger', () => {
    const cron = parseCronExpression('30 9 * * 1-5');
    expect(cron.minutes.has(30)).toBe(true);
    expect(cron.hours.has(9)).toBe(true);
    expect(cron.weekdays.has(1)).toBe(true);
    expect(cron.weekdays.has(0)).toBe(false);

    // Sunday 2026-05-03 08:00 local -> next Mon 2026-05-04 09:30 local
    const base = new Date(2026, 4, 3, 8, 0, 0, 0).getTime();
    const next = computeNextRun('cron', '30 9 * * 1-5', base)!;
    const d = new Date(next);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);

    expect(parseIntervalMs('15m')).toBe(15 * 60_000);
    expect(parseIntervalMs('2h')).toBe(2 * 3_600_000);
    expect(() => parseIntervalMs('5s')).toThrow();
    expect(() => parseCronExpression('bad')).toThrow();

    // Quartz-style numeric/step expands through the field's upper bound.
    const stepped = parseCronExpression('0/15 2/6 * * *');
    expect([...stepped.minutes]).toEqual([0, 15, 30, 45]);
    expect([...stepped.hours]).toEqual([2, 8, 14, 20]);
  });
});

describe('scheduled agents', () => {
  it('runs a fresh-context agent, archives outputs to runs/ and latest.md, notifies orchestrator, and archives transient agent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi2web-sched-'));
    const dataDir = path.join(root, 'data');
    const workspaces = new WorkspaceStore();
    const backends = new Map<string, TrackingBackend>();
    const agents = new AgentManager(workspaces, (id, cwd, sessionFile, _profile, opts) => {
      const backend = new TrackingBackend(id, cwd, sessionFile, opts);
      backends.set(id, backend);
      return backend;
    });

    const server = new RemotePiServer({
      port: 0,
      dataDir,
      workspaces,
      agents,
      schedulerTickMs: 60_000
    });
    cleanups.push(async () => {
      await server.stop();
      await rm(root, {recursive: true, force: true});
    });

    const {token} = await server.auth.init();
    const address = await server.start();
    const base = `http://127.0.0.1:${address!.port}`;
    const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(base + url, {
        method,
        headers,
        ...(body !== undefined ? {body: JSON.stringify(body)} : {})
      });
      return {status: res.status, ...(await res.json())};
    };

    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator', sessionName: 'HQ'})).data;

    // Create a standalone scheduled task notifying the orchestrator.
    const created = await call('POST', '/api/v1/schedules', {
      name: 'Inbox Check',
      scheduleKind: 'interval',
      scheduleExpr: '30m',
      prompt: 'Check inbox for urgent items',
      notifyMode: 'orchestrator',
      notifyOrchestratorId: orch.agentId
    });
    expect(created.status).toBe(201);
    const task = created.data;
    expect(task.historyDir).toContain(task.id);
    expect(existsSync(path.join(task.historyDir, 'runs'))).toBe(true);

    // Trigger manual run.
    const runRes = await call('POST', `/api/v1/schedules/${task.id}/run`);
    expect(runRes.status).toBe(200);
    const run = runRes.data;

    // Wait for completion, archive of output files, archive of transient agent, and notification to orchestrator.
    await vi.waitFor(async () => {
      const list = (await call('GET', `/api/v1/schedules/${task.id}/runs`)).data.runs;
      expect(list[0].status).toBe('completed');
    });

    const latestPath = path.join(task.historyDir, 'latest.md');
    expect(existsSync(latestPath)).toBe(true);
    const latestText = await readFile(latestPath, 'utf8');
    expect(latestText).toContain('Inbox Check');
    expect(latestText).toContain('Mock response:');
    expect(latestText).toContain('Check inbox for urgent items');

    // Transient agent is archived out of the active sidebar list.
    await vi.waitFor(() => {
      expect(server.agents.list().some(a => a.agentId === run.agentId)).toBe(false);
    });

    // Orchestrator received the scheduled task result.
    const orchBackend = backends.get(orch.agentId)!;
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(1));
    expect(orchBackend.prompts[0]).toContain('[pi2web scheduled task result]');
    expect(orchBackend.prompts[0]).toContain('Inbox Check');

    // Update & delete task via REST.
    const updated = await call('PUT', `/api/v1/schedules/${task.id}`, {enabled: false});
    expect(updated.status).toBe(200);
    expect(updated.data.enabled).toBe(false);

    const deleted = await call('DELETE', `/api/v1/schedules/${task.id}`);
    expect(deleted.status).toBe(200);
    expect((await call('GET', '/api/v1/schedules')).data.tasks).toHaveLength(0);
    // Archived files on disk stay intact.
    expect(existsSync(latestPath)).toBe(true);
  });

  it('migrates legacy agents table with NOT NULL workspace_id so orchestrators can be saved', async () => {
    const Database = (await import('better-sqlite3')).default;
    const {MetadataStore} = await import('../src/metadata-store.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'pi2web-mig-'));
    cleanups.push(async () => rm(dir, {recursive: true, force: true}));

    // Create a legacy schema where agents.workspace_id is NOT NULL.
    const dbFile = path.join(dir, 'pi2web.db');
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, label TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, session_file TEXT,
        session_name TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, profile TEXT NOT NULL DEFAULT 'default',
        template TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, archived_at INTEGER,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO workspaces VALUES('w1', 'W1', '/tmp/w1', 1000);
      INSERT INTO agents VALUES('a1', 'w1', 's1', NULL, 'Old', '/tmp/w1', 'idle', 'default', NULL, 1000, 2000, NULL);
    `);
    legacy.close();

    const store = new MetadataStore(dir);
    store.init();
    try {
      store.saveAgent({
        agentId: 'orch-1',
        sessionId: 'sess-orch',
        sessionName: 'Global',
        cwd: dir,
        status: 'idle',
        profile: 'orchestrator',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-02T00:00:00.000Z'
      });
      const all = store.listAgents();
      expect(all.map(a => a.agentId)).toEqual(['orch-1', 'a1']);
      expect(all.find(a => a.agentId === 'orch-1')?.workspaceId).toBeUndefined();
      expect(all.find(a => a.agentId === 'a1')?.workspaceId).toBe('w1');
    } finally {
      store.close();
    }
  });

  it('aborts timed-out scheduled runs, records timed_out status, alerts WS/mail regardless of collabEscalations, and supports clearing workspace + stopping mid-run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi2web-sched-edge-'));
    const dataDir = path.join(root, 'data');
    const wsDir = path.join(root, 'ws');
    await mkdir(wsDir, {recursive: true});

    const sentMails: any[] = [];
    const mailNotifier = new MailNotifier(
      {endpoint: 'http://mail.test/send', apiKey: 'k', recipient: 'me@test'},
      (async (_url, init) => {
        sentMails.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ok: true}), {status: 200});
      }) as typeof fetch
    );
    // Explicitly disable legacy collabEscalations to verify schedule mail still goes through.
    mailNotifier.updateSettings({enabled: true, collabEscalations: false});

    const workspaces = new WorkspaceStore();
    const backends = new Map<string, TrackingBackend>();
    let holdNext = false;
    const agents = new AgentManager(workspaces, (id, cwd, sessionFile, _profile, opts) => {
      const backend = new TrackingBackend(id, cwd, sessionFile, opts);
      if (holdNext) {
        backend.holdNextTurn();
        holdNext = false;
      }
      backends.set(id, backend);
      return backend;
    });

    const server = new RemotePiServer({
      port: 0,
      dataDir,
      workspaces,
      agents,
      mailNotifier,
      schedulerTickMs: 60_000
    });
    cleanups.push(async () => {
      await server.stop();
      await rm(root, {recursive: true, force: true});
    });

    const {token} = await server.auth.init();
    const address = await server.start();
    const base = `http://127.0.0.1:${address!.port}`;
    const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(base + url, {
        method,
        headers,
        ...(body !== undefined ? {body: JSON.stringify(body)} : {})
      });
      return {status: res.status, ...(await res.json())};
    };

    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, {
      headers: {authorization: `Bearer ${token}`}
    });
    cleanups.push(async () => ws.terminate());
    const wsMessages: any[] = [];
    ws.on('message', raw => wsMessages.push(JSON.parse(String(raw))));
    await once(ws, 'open');
    ws.send(JSON.stringify({type: 'subscribe_all'}));
    await vi.waitFor(() => expect(wsMessages.some(m => m.type === 'subscribed_all')).toBe(true));

    const workspace = (await call('POST', '/api/v1/workspaces', {label: 'ws', rootPath: wsDir})).data;
    const task = (
      await call('POST', '/api/v1/schedules', {
        name: 'Slow Job',
        scheduleKind: 'interval',
        scheduleExpr: '10m',
        workspaceId: workspace.id,
        relativeCwd: '.',
        timeoutSeconds: 1,
        prompt: 'Hang forever',
        notifyMode: 'none'
      })
    ).data;
    expect(task.workspaceId).toBe(workspace.id);

    // Clearing workspaceId via empty string detaches the task from the Workspace.
    const cleared = (await call('PUT', `/api/v1/schedules/${task.id}`, {workspaceId: '', relativeCwd: ''}))
      .data;
    expect(cleared.workspaceId).toBeUndefined();

    // 1. Trigger a run that stalls until the 1s timeout kills it.
    holdNext = true;
    const runRes = await call('POST', `/api/v1/schedules/${task.id}/run`);
    expect(runRes.status).toBe(200);

    // Concurrent manual run while active must be rejected.
    const dup = await call('POST', `/api/v1/schedules/${task.id}/run`);
    expect(dup.status).toBe(400);

    await vi.waitFor(
      async () => {
        const runs = (await call('GET', `/api/v1/schedules/${task.id}/runs`)).data.runs;
        expect(runs[0].status).toBe('timed_out');
      },
      {timeout: 3000}
    );

    // Timeout produces both a schema-valid WS schedule_event and a direct email (even with collabEscalations=false).
    await vi.waitFor(() => expect(wsMessages.some(m => m.type === 'schedule_event')).toBe(true));
    const schedFrame = wsMessages.find(m => m.type === 'schedule_event');
    expect(Check(schema as any, schedFrame)).toBe(true);
    expect(schedFrame.event.run.status).toBe('timed_out');

    await vi.waitFor(() => expect(sentMails.length).toBeGreaterThanOrEqual(1));
    expect(sentMails[0].subject).toContain('超时已中止');

    // 2. Stopping (unloading) a running scheduled Agent finalizes the run as aborted instead of locking the task.
    await call('PUT', `/api/v1/schedules/${task.id}`, {timeoutSeconds: 0});
    holdNext = true;
    const run2 = (await call('POST', `/api/v1/schedules/${task.id}/run`)).data;
    await call('DELETE', `/api/v1/agents/${run2.agentId}`);
    await vi.waitFor(async () => {
      const runs = (await call('GET', `/api/v1/schedules/${task.id}/runs`)).data.runs;
      expect(runs[0].id).toBe(run2.id);
      expect(runs[0].status).toBe('aborted');
    });
  });
});
