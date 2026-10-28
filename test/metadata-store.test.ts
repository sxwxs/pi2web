import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MetadataStore} from '../src/metadata-store.js';
import type {AgentRecord} from '../src/agents.js';

const stores: MetadataStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const open = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-pi-db-')),
    store = new MetadataStore(dir);
  store.init();
  stores.push(store);
  return {dir, store};
};
const agent = (id: string, workspaceId: string, lastActiveAt: string): AgentRecord => ({
  agentId: id,
  workspaceId,
  sessionId: `session-${id}`,
  cwd: tmpdir(),
  status: 'unloaded',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt
});

describe('SQLite metadata store', () => {
  it('persists workspaces and orders active agents by indexed activity time', async () => {
    const {dir, store} = await open(),
      workspace = {
        id: 'workspace-1',
        label: 'Workspace',
        rootPath: tmpdir(),
        createdAt: '2026-01-01T00:00:00.000Z'
      };
    store.saveWorkspace(workspace);
    store.saveAgent(agent('older', workspace.id, '2026-01-02T00:00:00.000Z'));
    store.saveAgent(agent('newer', workspace.id, '2026-01-03T00:00:00.000Z'));
    expect(store.listAgents().map(item => item.agentId)).toEqual(['newer', 'older']);
    store.archiveAgent(agent('newer', workspace.id, '2026-01-03T00:00:00.000Z'));
    expect(store.listAgents().map(item => item.agentId)).toEqual(['older']);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new MetadataStore(dir);
    reopened.init();
    stores.push(reopened);
    expect(reopened.listWorkspaces()).toMatchObject([{id: workspace.id, label: workspace.label}]);
    expect(reopened.listAgents().map(item => item.agentId)).toEqual(['older']);
  });
  it('does not resurrect an archived agent through a delayed write', async () => {
    const {store} = await open(),
      workspace = {
        id: 'workspace-1',
        label: 'Workspace',
        rootPath: tmpdir(),
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      record = agent('archived', workspace.id, '2026-01-03T00:00:00.000Z');
    store.saveWorkspace(workspace);
    store.saveAgent(record);
    store.archiveAgent(record);
    store.scheduleAgent({...record, lastActiveAt: '2026-01-04T00:00:00.000Z'});
    store.flush();
    expect(store.listAgents()).toEqual([]);
  });
  it('keeps the committed template safe from ordinary saves and delayed state writes', async () => {
    const {dir, store} = await open();
    const workspace = {id: 'w', label: 'w', rootPath: dir, createdAt: '2026-01-01T00:00:00.000Z'};
    store.saveWorkspace(workspace);
    const first = {id: 'a', name: 'A', mode: 'append' as const, systemPrompt: 'Original'};
    const second = {id: 'b', name: 'B', mode: 'append' as const, systemPrompt: 'Chosen'};
    const original = {...agent('agent', workspace.id, '2026-01-02T00:00:00.000Z'), template: first};
    store.saveAgent(original);
    store.scheduleAgent(original);
    const chosen = {...original, sessionId: 'replacement', template: second};
    store.commitAgentTemplate(chosen);
    store.flush();
    expect(store.listAgents()[0]).toMatchObject({sessionId: 'replacement', template: second});
    store.saveAgent(original);
    store.scheduleAgent(original);
    store.flush();
    expect(store.listAgents()[0].template).toEqual(second);
    store.commitAgentTemplate({...chosen, template: undefined});
    store.saveAgent(original);
    store.scheduleAgent(original);
    store.close();
    const reopened = new MetadataStore(dir);
    reopened.init();
    stores.push(reopened);
    expect(reopened.listAgents()[0].template).toBeUndefined();
  });

  it('commits template and session metadata atomically', async () => {
    const {dir, store} = await open();
    const workspace = {id: 'w', label: 'w', rootPath: dir, createdAt: '2026-01-01T00:00:00.000Z'};
    store.saveWorkspace(workspace);
    const original = agent('agent', workspace.id, '2026-01-02T00:00:00.000Z');
    store.saveAgent(original);
    const before = store.listAgents();
    expect(() =>
      store.commitAgentTemplate({
        ...original,
        workspaceId: 'missing',
        template: {id: 'b', name: 'B', mode: 'append', systemPrompt: 'New'}
      })
    ).toThrow();
    expect(store.listAgents()).toEqual(before);
    store.archiveAgent(original);
    expect(() => store.commitAgentTemplate(original)).toThrow(
      expect.objectContaining({code: 'AGENT_NOT_FOUND'})
    );
    expect(store.listAgents()).toEqual([]);
  });

  it('indexes session files and returns the newest page through SQL', async () => {
    const {dir, store} = await open(),
      workspace = {
        id: 'workspace-1',
        label: 'Workspace',
        rootPath: dir,
        createdAt: '2026-01-01T00:00:00.000Z'
      };
    store.saveWorkspace(workspace);
    const first = path.join(dir, 'first.jsonl'),
      second = path.join(dir, 'second.jsonl');
    await Promise.all([writeFile(first, '{}\n'), writeFile(second, '{}\n')]);
    store.syncSessions(workspace.id, dir, [
      {
        path: first,
        id: 'first',
        cwd: dir,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-02T00:00:00.000Z'),
        messageCount: 1,
        firstMessage: 'first',
        allMessagesText: 'first'
      },
      {
        path: second,
        id: 'second',
        cwd: dir,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-03T00:00:00.000Z'),
        messageCount: 2,
        firstMessage: 'second',
        allMessagesText: 'second'
      }
    ]);
    expect(store.listSessions(dir, 1)).toMatchObject([{id: 'second', messageCount: 2}]);
    expect(store.hasSession(dir, first)).toBe(true);
  });
});
