import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {once} from 'node:events';
import {Check} from 'typebox/value';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend, type AgentEvent, type AgentProfile} from '../src/agents.js';
import {createOrchestratorExtension} from '../src/orchestrator/pi-extension.js';
import schema from '../packages/protocol/websocket.schema.json' with {type: 'json'};

class ScriptedBackend extends MockBackend {
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
  emitCustom(event: AgentEvent) {
    (this as any).emit(event);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setupServer() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi2web-orch-'));
  const dataDir = path.join(root, 'data');
  const wsDir = path.join(root, 'repo');
  const subDir = path.join(wsDir, 'packages', 'api');
  await mkdir(subDir, {recursive: true});
  await writeFile(path.join(subDir, 'index.ts'), 'export const ok = true;\n');

  const workspaces = new WorkspaceStore();
  const backends = new Map<string, {backend: ScriptedBackend; profile?: AgentProfile}>();
  const agents = new AgentManager(workspaces, (id, cwd, sessionFile, profile, options) => {
    const backend = new ScriptedBackend(id, cwd, sessionFile, options);
    backends.set(id, {backend, profile});
    return backend;
  });

  const server = new RemotePiServer({
    port: 0,
    dataDir,
    workspaces,
    agents,
    orchestratorDebounceMs: 30,
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

  const wsRes = await call('POST', '/api/v1/workspaces', {label: 'repo', rootPath: wsDir});
  expect(wsRes.status).toBe(201);

  return {root, dataDir, wsDir, subDir, workspace: wsRes.data, server, backends, base, token, call};
}

describe('orchestrator agents and tools', () => {
  it('creates workspace-independent orchestrator agents, persists them across restarts, and loads built-in review template', async () => {
    const {dataDir, server, call} = await setupServer();

    const templatesRes = await call('GET', '/api/v1/agent-templates?includeBuiltIn=true');
    expect(templatesRes.status).toBe(200);
    expect(templatesRes.data.builtIn.map((t: any) => t.id)).toContain('multi-agent-review');

    const preview = await call(
      'GET',
      '/api/v1/system-prompt/preview?profile=orchestrator&templateId=multi-agent-review'
    );
    expect(preview.status).toBe(200);
    expect(preview.data.systemPrompt).toContain('多模型并行代码评审');

    const created = await call('POST', '/api/v1/agents', {
      profile: 'orchestrator',
      sessionName: 'Main Orchestrator',
      templateId: 'multi-agent-review'
    });
    expect(created.status).toBe(201);
    expect(created.data.profile).toBe('orchestrator');
    expect(created.data.workspaceId).toBeUndefined();
    expect(created.data.sessionName).toBe('Main Orchestrator');
    expect(created.data.template.id).toBe('multi-agent-review');

    await server.stop();

    // Restart with a fresh server instance against the same DB.
    const restarted = new RemotePiServer({
      port: 0,
      dataDir,
      agents: new AgentManager(
        new WorkspaceStore(),
        (id, cwd, sessionFile, _p, opts) => new ScriptedBackend(id, cwd, sessionFile, opts)
      )
    });
    // Use default workspaces wired to metadata via server.
    await restarted.stop();
    const workspaces2 = new WorkspaceStore();
    const agents2 = new AgentManager(
      workspaces2,
      (id, cwd, sessionFile, _p, opts) => new ScriptedBackend(id, cwd, sessionFile, opts)
    );
    const server2 = new RemotePiServer({port: 0, dataDir, workspaces: workspaces2, agents: agents2});
    cleanups.push(async () => server2.stop());
    await server2.start();

    const restored = server2.agents.list().find(a => a.agentId === created.data.agentId);
    expect(restored).toBeDefined();
    expect(restored!.profile).toBe('orchestrator');
    expect(restored!.workspaceId).toBeUndefined();
    expect(restored!.sessionName).toBe('Main Orchestrator');
  });

  it('exposes pi2web_* tools via inline extension and supports list, search, read, create, send, and control', async () => {
    const {subDir, workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator', sessionName: 'Boss'})).data;

    const registeredTools: Record<string, any> = {};
    let systemPromptHandler: ((ev: {systemPrompt: string}) => {systemPrompt: string}) | undefined;
    createOrchestratorExtension(
      orch.agentId,
      server.orchestratorToolBridge()
    )({
      on: (name: string, fn: any) => {
        if (name === 'before_agent_start') systemPromptHandler = fn;
      },
      registerTool: (tool: any) => {
        registeredTools[tool.name] = tool;
      }
    } as any);

    expect(Object.keys(registeredTools)).toEqual(
      expect.arrayContaining([
        'pi2web_list_workspaces',
        'pi2web_list_models',
        'pi2web_list_agents',
        'pi2web_search_sessions',
        'pi2web_read_session',
        'pi2web_create_agent',
        'pi2web_send_message',
        'pi2web_watch_agents',
        'pi2web_control_agent',
        'pi2web_list_schedules',
        'pi2web_create_schedule'
      ])
    );
    expect(systemPromptHandler?.({systemPrompt: 'base'}).systemPrompt).toContain('Pi2Web Orchestrator Role');

    const runTool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await registeredTools[name].execute('call-1', args);
      return JSON.parse(result.content[0].text);
    };

    const wsList = await runTool('pi2web_list_workspaces');
    expect(wsList.workspaces).toHaveLength(1);
    expect(wsList.workspaces[0].id).toBe(workspace.id);

    // Create a code agent by absolute cwd (auto-matches workspace) and launch initialPrompt.
    const created = await runTool('pi2web_create_agent', {
      cwd: subDir,
      sessionName: 'API Worker',
      initialPrompt: 'Inspect index.ts'
    });
    expect(created.agent.workspaceId).toBe(workspace.id);
    expect(created.agent.profile).toBe('default');
    expect(created.agent.sessionName).toBe('API Worker');

    await vi.waitFor(() => {
      expect(backends.get(created.agent.agentId)?.backend.prompts).toContain('Inspect index.ts');
    });

    // Wait for worker turn to finish, then read & search its session.
    await vi.waitFor(() => {
      expect(server.agents.get(created.agent.agentId).record.status).toBe('idle');
    });

    const list = await runTool('pi2web_list_agents');
    expect(list.agents.map((a: any) => a.agentId)).toEqual([created.agent.agentId]);

    const searched = await runTool('pi2web_search_sessions', {query: 'API Worker'});
    expect(searched.agents).toHaveLength(1);
    expect(searched.agents[0].agentId).toBe(created.agent.agentId);

    const read = await runTool('pi2web_read_session', {agentId: created.agent.agentId, limit: 10});
    expect(
      read.items.some((item: any) => item.kind === 'user' && item.text.includes('Inspect index.ts'))
    ).toBe(true);
    expect(
      read.items.some(
        (item: any) => item.kind === 'assistant' && item.text.includes('Mock response: Inspect index.ts')
      )
    ).toBe(true);

    // Prevent self-messaging and orchestrator-to-orchestrator messaging.
    await expect(runTool('pi2web_send_message', {agentId: orch.agentId, message: 'loop'})).rejects.toThrow(
      /cannot send messages to itself/i
    );

    // Control: rename & archive.
    await runTool('pi2web_control_agent', {
      agentId: created.agent.agentId,
      action: 'rename',
      sessionName: 'API Worker Renamed'
    });
    expect(server.agents.get(created.agent.agentId).record.sessionName).toBe('API Worker Renamed');

    await runTool('pi2web_control_agent', {agentId: created.agent.agentId, action: 'archive'});
    expect(server.agents.list().some(a => a.agentId === created.agent.agentId)).toBe(false);
  });

  it('pushes reverse completion notifications (single & notifyGroup barrier) and streams watch state over WS', async () => {
    const {workspace, server, backends, base, token, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator', sessionName: 'Lead'})).data;
    const orchBackend = backends.get(orch.agentId)!.backend;

    // Subscribe over WebSocket to validate orchestrator_watches matches the published schema.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, {
      headers: {authorization: `Bearer ${token}`}
    });
    cleanups.push(async () => ws.terminate());
    const wsMessages: any[] = [];
    ws.on('message', raw => wsMessages.push(JSON.parse(String(raw))));
    await once(ws, 'open');
    ws.send(JSON.stringify({type: 'subscribe_all'}));
    await vi.waitFor(() => expect(wsMessages.some(m => m.type === 'subscribed_all')).toBe(true));

    // Create two workers in the same notifyGroup, holding their turns so we can verify barrier behavior.
    const w1 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'Reviewer 1'}))
      .data;
    const w2 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'Reviewer 2'}))
      .data;
    const release1 = backends.get(w1.agentId)!.backend.holdNextTurn();
    const release2 = backends.get(w2.agentId)!.backend.holdNextTurn();

    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w1.agentId,
      message: 'Review PR part 1',
      notifyOnComplete: true,
      notifyGroup: 'review-r1',
      notifyLabel: 'model-A'
    });
    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w2.agentId,
      message: 'Review PR part 2',
      notifyOnComplete: true,
      notifyGroup: 'review-r1',
      notifyLabel: 'model-B'
    });

    await vi.waitFor(() =>
      expect(
        wsMessages.some(
          m => m.type === 'orchestrator_watches' && m.agentId === orch.agentId && m.watches.length === 2
        )
      ).toBe(true)
    );
    const watchFrame = wsMessages.find(
      m => m.type === 'orchestrator_watches' && m.agentId === orch.agentId && m.watches.length === 2
    );
    expect(Check(schema as any, watchFrame)).toBe(true);

    // Finishing only worker 1 must NOT wake the orchestrator yet (group barrier).
    release1();
    await new Promise(r => setTimeout(r, 120));
    expect(orchBackend.prompts).toHaveLength(0);

    // Finishing worker 2 wakes the orchestrator ONCE with both results.
    release2();
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(1));
    expect(orchBackend.prompts[0]).toContain('[pi2web completion notification]');
    expect(orchBackend.prompts[0]).toContain('Reviewer 1');
    expect(orchBackend.prompts[0]).toContain('Reviewer 2');
    expect(orchBackend.prompts[0]).toContain('Mock response: Review PR part 1');
    expect(orchBackend.prompts[0]).toContain('Mock response: Review PR part 2');
    expect(server.orchestratorHub.listFor(orch.agentId)).toEqual([]);
  });

  it('clears orchestrator watches via REST API and when orchestrator is unloaded', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator'})).data;
    const worker = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id})).data;
    const release = backends.get(worker.agentId)!.backend.holdNextTurn();

    const sent = await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: worker.agentId,
      message: 'Work',
      notifyOnComplete: true
    });
    expect(server.orchestratorHub.listFor(orch.agentId)).toHaveLength(1);

    const del = await call('DELETE', `/api/v1/agents/${orch.agentId}/watches/${sent.watch!.id}`);
    expect(del.status).toBe(200);
    expect(del.data.removed).toBe(1);
    expect(server.orchestratorHub.listFor(orch.agentId)).toEqual([]);

    release();
  });

  it('reuses orchestrator tools for scheduled task CRUD and handles dialog waiting_for_user alerts', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator', sessionName: 'Mgr'})).data;
    const orchBackend = backends.get(orch.agentId)!.backend;

    // 1. Schedule CRUD via orchestrator service (same path the tools call).
    const sched = await server.orchestratorService.createSchedule(orch.agentId, {
      name: 'Morning Report',
      scheduleKind: 'cron',
      scheduleExpr: '0 9 * * *',
      prompt: 'Summarize recent commits',
      notifyMode: 'orchestrator'
    });
    expect(sched.notifyOrchestratorId).toBe(orch.agentId);
    expect(server.orchestratorService.listSchedules().map(s => s.id)).toContain(sched.id);
    const updated = await server.orchestratorService.updateSchedule(orch.agentId, sched.id, {enabled: false});
    expect(updated.enabled).toBe(false);
    expect(server.orchestratorService.deleteSchedule(sched.id)).toEqual({deleted: true, id: sched.id});

    // 2. Worker enters waiting_for_user -> orchestrator is notified promptly even inside a notifyGroup.
    const w1 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'W1'})).data;
    const w2 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'W2'})).data;
    const release1 = backends.get(w1.agentId)!.backend.holdNextTurn();
    const release2 = backends.get(w2.agentId)!.backend.holdNextTurn();

    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w1.agentId,
      message: 'Step 1',
      notifyOnComplete: true,
      notifyGroup: 'g-alert'
    });
    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w2.agentId,
      message: 'Step 2',
      notifyOnComplete: true,
      notifyGroup: 'g-alert'
    });

    backends.get(w1.agentId)!.backend.emitCustom({
      type: 'extension_ui_request',
      requestId: 'req-1',
      kind: 'confirm',
      title: 'Allow destructive migration?'
    });
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(1));
    expect(orchBackend.prompts[0]).toContain('waiting_for_user');
    expect(orchBackend.prompts[0]).toContain('Allow destructive migration?');

    // Both group members still finish and fire the group completion notification cleanly.
    backends.get(w1.agentId)!.backend.emitCustom({type: 'extension_ui_response', requestId: 'req-1'});
    release1();
    release2();
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(2));
    expect(orchBackend.prompts[1]).toContain('W1');
    expect(orchBackend.prompts[1]).toContain('W2');
  });

  it('prevents orchestrator notification from racing while orchestrator is busy streaming', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator'})).data;
    const orchBackend = backends.get(orch.agentId)!.backend;
    const worker = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'Fast'}))
      .data;

    // Hold orchestrator's own turn while worker runs and completes.
    const releaseOrch = orchBackend.holdNextTurn();
    const orchRun = server.agents.command(orch.agentId, 'prompt', 'User asks orchestrator');
    await vi.waitFor(() => expect(server.agents.get(orch.agentId).record.status).toBe('streaming'));

    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: worker.agentId,
      message: 'Quick task',
      notifyOnComplete: true
    });
    await vi.waitFor(() => expect(server.agents.get(worker.agentId).record.status).toBe('idle'));
    await new Promise(r => setTimeout(r, 80));
    // Orchestrator is still streaming its first turn, so notification must wait.
    expect(orchBackend.prompts).toHaveLength(1);

    // Once orchestrator finishes its turn, queued notification is delivered automatically.
    releaseOrch();
    await orchRun;
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(2));
    expect(orchBackend.prompts[1]).toContain('[pi2web completion notification]');
    expect(orchBackend.prompts[1]).toContain('Quick task');
  });

  it('keeps a notifyGroup open while the orchestrator is still streaming so a fast first worker cannot split the group', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator'})).data;
    const orchBackend = backends.get(orch.agentId)!.backend;
    const w1 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'Fast-1'}))
      .data;
    const w2 = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, sessionName: 'Slow-2'}))
      .data;

    // Orchestrator is mid-turn while dispatching reviewer 1 and reviewer 2 into the same group.
    const releaseOrch = orchBackend.holdNextTurn();
    const orchRun = server.agents.command(orch.agentId, 'prompt', 'Run parallel review');
    await vi.waitFor(() => expect(server.agents.get(orch.agentId).record.status).toBe('streaming'));

    // Reviewer 1 finishes immediately BEFORE reviewer 2 is even registered.
    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w1.agentId,
      message: 'Review A',
      notifyOnComplete: true,
      notifyGroup: 'grp-race'
    });
    await vi.waitFor(() => expect(server.agents.get(w1.agentId).record.status).toBe('idle'));
    await new Promise(r => setTimeout(r, 60));

    // Now orchestrator registers reviewer 2 (held) into the same group and finishes its own turn.
    const release2 = backends.get(w2.agentId)!.backend.holdNextTurn();
    await server.orchestratorService.sendMessage(orch.agentId, {
      agentId: w2.agentId,
      message: 'Review B',
      notifyOnComplete: true,
      notifyGroup: 'grp-race'
    });
    releaseOrch();
    await orchRun;
    await new Promise(r => setTimeout(r, 80));

    // Must still wait for reviewer 2 rather than firing a partial notification for reviewer 1.
    expect(orchBackend.prompts).toHaveLength(1);
    expect(server.orchestratorHub.listFor(orch.agentId)).toHaveLength(2);

    release2();
    await vi.waitFor(() => expect(orchBackend.prompts).toHaveLength(2));
    expect(orchBackend.prompts[1]).toContain('Fast-1');
    expect(orchBackend.prompts[1]).toContain('Slow-2');
  });

  it('archives metadata when createWorker fails during initialPrompt preflight', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator'})).data;
    const origCreate = server.agents.create.bind(server.agents);
    vi.spyOn(server.agents, 'create').mockImplementationOnce(async (...args) => {
      const rec = await origCreate(...args);
      backends.get(rec.agentId)!.backend.prompt = async () => {
        throw new Error('preflight rejected');
      };
      return rec;
    });

    await expect(
      server.orchestratorService.createWorker(orch.agentId, {
        workspaceId: workspace.id,
        sessionName: 'Doomed',
        initialPrompt: 'fail now'
      })
    ).rejects.toThrow('preflight rejected');

    expect(server.agents.list().some(a => a.sessionName === 'Doomed')).toBe(false);
    expect(server.metadata.listAgents().some(a => a.sessionName === 'Doomed')).toBe(false);
  });

  it('rejects explicit watch on idle agent, surfaces existing dialog on watch, drops pending notice on unwatch, and slices long itemId bodies', async () => {
    const {workspace, server, backends, call} = await setupServer();
    const orch = (await call('POST', '/api/v1/agents', {profile: 'orchestrator'})).data;
    const orchBackend = backends.get(orch.agentId)!.backend;
    const worker = (
      await call('POST', '/api/v1/agents', {
        workspaceId: workspace.id,
        relativeCwd: 'packages/api',
        sessionName: 'API'
      })
    ).data;

    // 1. Explicit watch rejects idle worker; unwatch requires an explicit target/watchId.
    expect(() =>
      server.orchestratorService.watchAgents(orch.agentId, {action: 'watch', agentId: worker.agentId})
    ).toThrow(/no active run to watch/i);
    expect(() => server.orchestratorService.watchAgents(orch.agentId, {action: 'unwatch'})).toThrow(
      /watchId or agentId is required/i
    );

    // 2. Search with workspace-relative cwd and partial prefix works without failing.
    const byRel = await server.orchestratorService.searchSessions(orch.agentId, {
      workspaceId: workspace.id,
      cwd: 'packages/api'
    });
    expect(byRel.agents.map(a => a.agentId)).toContain(worker.agentId);
    const byPrefix = await server.orchestratorService.searchSessions(orch.agentId, {
      workspaceId: workspace.id,
      cwd: 'packages/ap'
    });
    expect(byPrefix.agents.map(a => a.agentId)).toContain(worker.agentId);

    // 3. Long itemId body returns unmodified slices with offset/hasMore/nextOffset.
    const longText = 'line1\n  indented   spaces\n' + 'X'.repeat(500);
    await server.agents.command(worker.agentId, 'prompt', longText);
    const page = await server.orchestratorService.readSession({agentId: worker.agentId, limit: 10});
    const userItem = page.items!.find((i: any) => i.kind === 'user') as any;
    const slice1 = await server.orchestratorService.readSession({
      agentId: worker.agentId,
      itemId: userItem.id,
      offset: 0,
      maxChars: 120
    });
    expect(slice1.hasMore).toBe(true);
    expect(slice1.body).toBe(longText.slice(0, 120));
    const slice2 = await server.orchestratorService.readSession({
      agentId: worker.agentId,
      itemId: userItem.id,
      offset: slice1.nextOffset,
      maxChars: 1000
    });
    expect(slice2.hasMore).toBe(false);
    expect(`${slice1.body}${slice2.body}`).toBe(longText);

    // 4. Adding a watch after a worker already entered waiting_for_user surfaces the existing dialog,
    //    and unwatching while the orchestrator is busy purges that queued dialog notice.
    const releaseOrch = orchBackend.holdNextTurn();
    const orchRun = server.agents.command(orch.agentId, 'prompt', 'Busy orchestrator');
    await vi.waitFor(() => expect(server.agents.get(orch.agentId).record.status).toBe('streaming'));

    const releaseWorker = backends.get(worker.agentId)!.backend.holdNextTurn();
    const workerRun = server.agents.command(worker.agentId, 'prompt', 'Need confirm');
    await vi.waitFor(() => expect(server.agents.get(worker.agentId).record.status).toBe('streaming'));
    backends.get(worker.agentId)!.backend.emitCustom({
      type: 'extension_ui_request',
      requestId: 'pre-dialog',
      kind: 'confirm',
      title: 'Existing dialog?'
    });
    await vi.waitFor(() => expect(server.agents.get(worker.agentId).record.status).toBe('waiting_for_user'));

    const {watch} = server.orchestratorService.watchAgents(orch.agentId, {
      action: 'watch',
      agentId: worker.agentId
    });
    // Cancel the watch before the orchestrator finishes; queued dialog notification must also be purged.
    server.orchestratorService.watchAgents(orch.agentId, {action: 'unwatch', watchId: watch!.id});
    releaseOrch();
    await orchRun;
    await new Promise(r => setTimeout(r, 100));
    expect(orchBackend.prompts).toHaveLength(1);

    backends
      .get(worker.agentId)!
      .backend.emitCustom({type: 'extension_ui_response', requestId: 'pre-dialog'});
    releaseWorker();
    await workerRun;
  });
});
