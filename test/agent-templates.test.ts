import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';
import {AgentTemplateStore, formatTemplateFile} from '../src/agent-templates.js';

const temp = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));

describe('AgentTemplateStore', () => {
  it('round-trips templates as shareable Markdown files and picks up hand-written ones', async () => {
    const dir = path.join(await temp('pi2web-templates-'), 'agent-templates'),
      store = new AgentTemplateStore(dir);
    expect(store.list()).toEqual({templates: [], errors: []});
    const saved = store.save('reviewer', {
      name: 'Code: "reviewer"',
      description: 'Reviews diffs',
      mode: 'replace',
      systemPrompt: 'You review code.\n\n---\nNever edit files.'
    });
    expect(saved).toMatchObject({id: 'reviewer', name: 'Code: "reviewer"', mode: 'replace'});
    expect(saved.systemPrompt).toBe('You review code.\n\n---\nNever edit files.');
    expect(await readFile(path.join(dir, 'reviewer.md'), 'utf8')).toContain('mode: replace');
    await writeFile(path.join(dir, 'shared.md'), '---\nname: Shared\nmode: append\n---\nBe brief.\n');
    await writeFile(path.join(dir, 'plain.md'), 'Just text, no front matter.');
    await writeFile(path.join(dir, 'notes.txt'), 'ignored');
    const {templates, errors} = store.list();
    expect(errors).toEqual([]);
    expect(templates.map(t => [t.id, t.name, t.mode])).toEqual([
      ['reviewer', 'Code: "reviewer"', 'replace'],
      ['plain', 'plain', 'append'],
      ['shared', 'Shared', 'append']
    ]);
    expect(store.snapshot('shared')).toEqual({
      id: 'shared',
      name: 'Shared',
      mode: 'append',
      systemPrompt: 'Be brief.'
    });
    store.remove('plain');
    expect(store.list().templates).toHaveLength(2);
  });
  it('rejects unsafe ids and invalid input', async () => {
    const store = new AgentTemplateStore(await temp('pi2web-templates-'));
    for (const id of ['../x', 'a/b', '', 'default', '.hidden'])
      expect(() => store.save(id, {mode: 'append', systemPrompt: 'x'})).toThrow();
    expect(() => store.save('ok', {mode: 'other', systemPrompt: 'x'})).toThrow(/mode/);
    expect(() => store.save('ok', {mode: 'append', systemPrompt: '  '})).toThrow(/systemPrompt/);
    expect(() => store.get('missing')).toThrow(expect.objectContaining({code: 'TEMPLATE_NOT_FOUND'}));
  });
  it('formats files that parse back to the same values', () => {
    expect(formatTemplateFile({name: 'a: b', description: '', mode: 'append', systemPrompt: ' hi \n'})).toBe(
      '---\nname: "a: b"\nmode: append\n---\n\nhi\n'
    );
  });
});

describe('system prompt and template API', () => {
  let server: RemotePiServer | undefined, previousAgentDir: string | undefined;
  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  });
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const boot = async (dataDir: string) => {
    const workspaces = new WorkspaceStore(),
      agents = new AgentManager(
        workspaces,
        (id, cwd, session, _profile, options) => new MockBackend(id, cwd, session, options)
      );
    server = new RemotePiServer({port: 0, noAuth: true, dataDir, workspaces, agents});
    const address = await server.start(),
      base = `http://127.0.0.1:${address!.port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(base + url, {
        method,
        headers: {'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      const payload: any = await response.json();
      return {status: response.status, data: payload.data, error: payload.error};
    };
    return call;
  };

  it('fixes the template on an Agent at creation, across edits, forks and restarts', async () => {
    const dataDir = await temp('pi2web-data-'),
      root = await temp('pi2web-ws-');
    let call = await boot(dataDir);
    const workspace = (await call('POST', '/api/v1/workspaces', {label: 'w', rootPath: root})).data;
    expect((await call('GET', '/api/v1/agent-templates')).data).toEqual({
      dir: path.join(dataDir, 'agent-templates'),
      templates: [],
      errors: []
    });
    const saved = await call('PUT', '/api/v1/agent-templates/reviewer', {
      name: 'Reviewer',
      mode: 'replace',
      systemPrompt: 'You are a reviewer.'
    });
    expect(saved.status).toBe(200);
    expect(await stat(path.join(dataDir, 'agent-templates', 'reviewer.md'))).toBeTruthy();

    const preview = await call(
      'GET',
      `/api/v1/system-prompt/preview?workspaceId=${workspace.id}&templateId=reviewer`
    );
    expect(preview.data.systemPrompt).toContain('You are a reviewer.');
    expect(preview.data.template).toMatchObject({id: 'reviewer', mode: 'replace'});

    expect(
      (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, templateId: 'missing'})).status
    ).toBe(404);
    const plain = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id})).data;
    expect(plain.template).toBeUndefined();
    const agent = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id, templateId: 'reviewer'}))
      .data;
    expect(agent.template).toEqual({
      id: 'reviewer',
      name: 'Reviewer',
      mode: 'replace',
      systemPrompt: 'You are a reviewer.'
    });
    // The list names the template but leaves the (possibly long) text to the system-prompt endpoint.
    const listed = (await call('GET', '/api/v1/agents')).data.find((a: any) => a.agentId === agent.agentId);
    expect(listed.template).toEqual({id: 'reviewer', name: 'Reviewer', mode: 'replace'});

    await call('PUT', '/api/v1/agent-templates/reviewer', {
      name: 'Reviewer v2',
      mode: 'append',
      systemPrompt: 'Changed later.'
    });
    const prompt = (await call('GET', `/api/v1/agents/${agent.agentId}/system-prompt`)).data;
    expect(prompt.systemPrompt).toContain('You are a reviewer.');
    expect(prompt.systemPrompt).not.toContain('Changed later.');
    expect(prompt.template.name).toBe('Reviewer');

    // Restart: the snapshot is restored from the database and used when the Agent loads again.
    await server!.stop();
    call = await boot(dataDir);
    const restored = (await call('GET', `/api/v1/agents/${agent.agentId}`)).data;
    expect(restored.template.systemPrompt).toBe('You are a reviewer.');
    expect((await call('GET', `/api/v1/agents/${agent.agentId}/system-prompt`)).data.systemPrompt).toContain(
      'You are a reviewer.'
    );
    expect((await call('GET', `/api/v1/agents/${plain.agentId}`)).data.template).toBeUndefined();
    expect(server!.metadata.file).toBe(path.join(dataDir, 'pi2web.db'));

    expect((await call('DELETE', '/api/v1/agent-templates/reviewer')).status).toBe(200);
    expect((await call('GET', '/api/v1/agent-templates/reviewer')).status).toBe(404);
    expect((await call('GET', `/api/v1/agents/${agent.agentId}/system-prompt`)).data.template.id).toBe(
      'reviewer'
    );
  });

  it('switches an empty Agent prompt, persists it, and refuses after the first message', async () => {
    const dataDir = await temp('pi2web-data-');
    const call = await boot(dataDir);
    const root = await temp('pi2web-ws-');
    const workspace = (await call('POST', '/api/v1/workspaces', {label: 'w', rootPath: root})).data;
    await call('PUT', '/api/v1/agent-templates/reviewer', {
      name: 'Reviewer',
      mode: 'append',
      systemPrompt: 'Review only.'
    });
    const agent = (await call('POST', '/api/v1/agents', {workspaceId: workspace.id})).data;
    const url = `/api/v1/agents/${agent.agentId}`;
    expect((await call('POST', `${url}/system-prompt`, {templateId: 'reviewer'})).data.template.id).toBe(
      'reviewer'
    );
    expect((await call('GET', `${url}/system-prompt`)).data.systemPrompt).toContain('Review only.');
    expect((await call('POST', `${url}/system-prompt`, {templateId: ''})).data.template).toBeNull();
    expect((await call('GET', `${url}/system-prompt`)).data.systemPrompt).not.toContain('Review only.');
    await call('POST', `${url}/prompt`, {message: 'begin'});
    const rejected = await call('POST', `${url}/system-prompt`, {templateId: 'reviewer'});
    expect(rejected.status).toBe(400);
    expect(rejected.error.code).toBe('SESSION_STARTED');
  });

  it('forks keep the template of their source Agent', async () => {
    const dataDir = await temp('pi2web-data-'),
      root = await temp('pi2web-ws-');
    const workspaces = new WorkspaceStore();
    const agents = new AgentManager(
      workspaces,
      (id, cwd, session, _profile, options) => new MockBackend(id, cwd, session, options)
    );
    await workspaces.add('w', root);
    const workspace = workspaces.list()[0];
    const template = {id: 't', name: 'T', mode: 'append' as const, systemPrompt: 'Extra rules.'};
    const source = await agents.create(workspace.id, '.', undefined, 'default', template);
    (agents.get(source.agentId).backend as any).fork = async () => ({
      sessionFile: path.join(dataDir, 'f.jsonl')
    });
    const {agent} = await agents.fork(source.agentId, 'entry');
    expect(agent.template).toEqual(template);
    expect((await agents.systemPrompt(agent.agentId)).systemPrompt).toContain('Extra rules.');
  });

  it('reads and writes Pi global SYSTEM.md / APPEND_SYSTEM.md', async () => {
    const agentDir = await temp('pi2web-agentdir-');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const call = await boot(await temp('pi2web-data-'));
    let files = (await call('GET', '/api/v1/system-prompt')).data;
    expect(files.agentDir).toBe(agentDir);
    expect(files.system).toEqual({path: path.join(agentDir, 'SYSTEM.md'), exists: false, content: ''});
    files = (await call('PUT', '/api/v1/system-prompt', {kind: 'append', content: 'Always answer in haiku.'}))
      .data;
    expect(files.append.exists).toBe(true);
    expect(await readFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'utf8')).toBe('Always answer in haiku.');
    files = (await call('PUT', '/api/v1/system-prompt', {kind: 'append', content: '  '})).data;
    expect(files.append.exists).toBe(false);
    expect((await call('PUT', '/api/v1/system-prompt', {kind: 'other', content: 'x'})).status).toBe(400);
  });
});

describe('SDK backend system prompt', () => {
  it('applies replace/append templates and can show Pi built-in prompt', async () => {
    const {createSdkBackend} = await import('../src/sdk-backend.js');
    const agentDir = await temp('pi2web-agentdir-'),
      cwd = await temp('pi2web-cwd-'),
      previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, {recursive: true});
    await writeFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL-APPEND-MARKER');
    const promptOf = async (options: Parameters<typeof createSdkBackend>[5]) => {
      const backend = await createSdkBackend('t', cwd, undefined, 'default', undefined, options).catch(
        (error: any) => (error.code === 'PI_MODEL_UNAVAILABLE' ? undefined : Promise.reject(error))
      );
      if (!backend) return undefined;
      try {
        return (await backend.getSystemPrompt()).systemPrompt;
      } finally {
        await backend.dispose();
      }
    };
    try {
      const effective = await promptOf({});
      if (effective === undefined) return; // No model configured in this environment.
      expect(effective).toContain('GLOBAL-APPEND-MARKER');
      expect(effective).toContain('expert coding assistant');
      const builtin = await promptOf({piDefaultPrompt: true});
      expect(builtin).not.toContain('GLOBAL-APPEND-MARKER');
      expect(builtin).toContain('expert coding assistant');
      const replaced = await promptOf({
        template: {id: 'r', name: 'R', mode: 'replace', systemPrompt: 'REPLACED-MARKER'}
      });
      expect(replaced).toContain('REPLACED-MARKER');
      expect(replaced).not.toContain('expert coding assistant');
      expect(replaced).toContain('GLOBAL-APPEND-MARKER');
      const appended = await promptOf({
        template: {id: 'a', name: 'A', mode: 'append', systemPrompt: 'APPENDED-MARKER'}
      });
      expect(appended).toContain('expert coding assistant');
      expect(appended!.indexOf('APPENDED-MARKER')).toBeGreaterThan(appended!.indexOf('GLOBAL-APPEND-MARKER'));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 60_000);
});
