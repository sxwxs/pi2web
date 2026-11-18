import {afterEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, realpath, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';

let server: RemotePiServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('workspace creation', () => {
  it('does not persist a workspace when its root directory does not exist', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'remote-pi-'));
    server = new RemotePiServer({port: 0, dataDir});
    const auth = await server.auth.init();
    const address = await server.start();
    const response = await fetch(`http://127.0.0.1:${address!.port}/api/v1/workspaces`, {
      method: 'POST',
      headers: {authorization: `Bearer ${auth.token}`, 'content-type': 'application/json'},
      body: JSON.stringify({label: 'missing', rootPath: path.join(dataDir, 'missing')})
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({error: {code: 'WORKSPACE_ROOT_NOT_FOUND'}});
    expect(server.workspaces.list()).toEqual([]);
    expect(server.metadata.listWorkspaces()).toEqual([]);
  });
});

/** Clients find a cwd's Workspace by path prefix, so a root must prefix the cwds resolved inside it. */
describe('workspace root canonical form', () => {
  const project = async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'remote-pi-')));
    const real = path.join(base, 'Project');
    await mkdir(path.join(real, 'pkg'), {recursive: true});
    return {base, real};
  };
  const expectPrefixesCwd = async (store: WorkspaceStore, rootPath: string) => {
    const workspace = store.list()[0]!;
    expect(workspace.rootPath).toBe(rootPath);
    expect(await store.resolve(workspace, 'pkg')).toBe(path.join(workspace.rootPath, 'pkg'));
  };

  it('stores a linked root as the directory its cwds resolve to', async () => {
    const {base, real} = await project();
    const link = path.join(base, 'link');
    await symlink(real, link, 'junction');
    const store = new WorkspaceStore();
    store.add('linked', link);
    await expectPrefixesCwd(store, real);
  });

  it.runIf(process.platform === 'win32')('stores a root typed in other case with its real case', async () => {
    const {real} = await project();
    const store = new WorkspaceStore();
    store.add('typed', real.toLowerCase());
    await expectPrefixesCwd(store, real);
  });

  it('canonicalizes stored roots on load and keeps a missing root loadable', async () => {
    const {base, real} = await project();
    const link = path.join(base, 'link');
    await symlink(real, link, 'junction');
    const missing = path.join(base, 'missing');
    const store = new WorkspaceStore();
    store.replace([
      {id: 'linked', label: 'linked', rootPath: link, createdAt: ''},
      {id: 'gone', label: 'gone', rootPath: missing, createdAt: ''}
    ]);
    expect(store.get('linked')!.rootPath).toBe(real);
    expect(store.get('gone')!.rootPath).toBe(missing);
  });
});
