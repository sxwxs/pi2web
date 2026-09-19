import {describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentManager, MockBackend, type AgentRecord} from '../src/agents.js';
import {WorkspaceStore} from '../src/workspaces.js';

const temp = () => mkdtemp(path.join(tmpdir(), 'pi2web-missing-cwd-'));

describe('agents whose working directory was deleted', () => {
  it('keeps the session visible and loads its transcript through the workspace root', async () => {
    const root = await temp();
    const missingCwd = path.join(root, 'deleted-project');
    const sessionFile = path.join(root, 'session.jsonl');
    await mkdir(missingCwd);
    await writeFile(sessionFile, '{}\n');

    const workspaces = new WorkspaceStore();
    const workspace = workspaces.add('workspace', root);
    const saved:AgentRecord = {
      agentId:'agent-missing',
      workspaceId:workspace.id,
      sessionId:'session-missing',
      sessionFile,
      sessionName:'Preserved session',
      cwd:missingCwd,
      status:'idle',
      profile:'default',
      createdAt:'2026-01-01T00:00:00.000Z',
      lastActiveAt:'2026-01-01T00:00:00.000Z',
    };
    await rm(missingCwd, {recursive:true});

    const backendCwds:string[] = [];
    const agents = new AgentManager(workspaces, (id, cwd) => {
      backendCwds.push(cwd);
      return new MockBackend(id, cwd, saved.sessionId);
    });
    await agents.restore([saved]);

    expect(agents.list()).toMatchObject([{agentId:saved.agentId, cwd:missingCwd, status:'unloaded'}]);
    expect(await agents.messages(saved.agentId)).toEqual([]);
    expect(backendCwds).toEqual([root]);
    expect(agents.list()[0].cwd).toBe(missingCwd);
    expect((await agents.sessionInfo(saved.agentId)).sessionName).toBe(saved.sessionName);
    await expect(agents.command(saved.agentId, 'prompt', 'continue')).rejects.toMatchObject({code:'AGENT_CWD_MISSING'});
    await expect(agents.runBash(saved.agentId, 'pwd')).rejects.toMatchObject({code:'AGENT_CWD_MISSING'});
  });

  it('does not restore a persisted cwd outside its workspace', async () => {
    const root = await temp(), outside = await temp();
    const workspaces = new WorkspaceStore(), workspace = workspaces.add('workspace', root);
    const agents = new AgentManager(workspaces);
    await agents.restore([{
      agentId:'agent-outside', workspaceId:workspace.id, sessionId:'session-outside', cwd:outside,
      status:'idle', profile:'default', createdAt:'2026-01-01T00:00:00.000Z', lastActiveAt:'2026-01-01T00:00:00.000Z',
    }]);
    expect(agents.list()).toEqual([]);
  });
});
