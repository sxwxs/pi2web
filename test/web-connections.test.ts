import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/backend-state.js', import.meta.url), 'utf8');

function loadBackendState(initial: Record<string, string> = {}) {
  const localStorage = {
    ...initial,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(this, key)
        ? String((this as Record<string, unknown>)[key])
        : null;
    }
  };
  const window: Record<string, unknown> = {};
  runInNewContext(source, {window});
  const api = window.RemotePiBackendState as any;
  return {api, localStorage};
}

describe('backend state', () => {
  it('keeps an explicitly stored empty connection list authoritative', () => {
    const {api, localStorage} = loadBackendState({rpConnections: '[]', rpToken: 'legacy-token'});
    expect(api.loadStoredBackends(localStorage, 'http://localhost')).toEqual([]);
  });

  it('migrates the legacy connection and keyboard binding format', () => {
    const {api, localStorage} = loadBackendState({
      rpBase: 'http://localhost:11318',
      rpToken: 'legacy-token',
      rpAgentId: 'agent-a',
      rpTerminalId: 'terminal-a',
      rpWorkspaceId: 'workspace-a',
      'rpSeq:agent-a': '42',
      rpSessionKeyboardBindings: JSON.stringify([{agentId: 'agent-a', slot: 0}])
    });
    const [backend] = api.loadStoredBackends(localStorage, 'http://localhost');
    expect(backend).toMatchObject({
      id: 'bk-main',
      name: '本机',
      base: 'http://localhost:11318',
      token: 'legacy-token',
      saved: true,
      status: 'off'
    });
    expect(JSON.parse(localStorage.rpSessionKeyboardBindings)).toEqual([
      {agentId: 'bk-main:agent-a', slot: 0}
    ]);
    expect(localStorage.rpAgentId).toBe('bk-main:agent-a');
    expect(localStorage.rpTerminalId).toBe('bk-main:terminal-a');
    expect(localStorage.rpWorkspaceId).toBe('bk-main:workspace-a');
    expect(localStorage['rpSeq:bk-main:agent-a']).toBe('42');
    expect(localStorage['rpSeq:agent-a']).toBeUndefined();
  });

  it('migrates a connection whose pairing code was never saved', () => {
    const {api, localStorage} = loadBackendState({
      rpBase: 'http://localhost:11318',
      rpAgentId: 'agent-a',
      rpSessionKeyboardBindings: JSON.stringify([{agentId: 'agent-a', slot: 0}])
    });
    const [backend] = api.loadStoredBackends(localStorage, 'http://localhost');
    expect(backend).toMatchObject({id: 'bk-main', base: 'http://localhost:11318', token: '', saved: false});
    expect(localStorage.rpAgentId).toBe('bk-main:agent-a');
    expect(JSON.parse(localStorage.rpSessionKeyboardBindings)).toEqual([
      {agentId: 'bk-main:agent-a', slot: 0}
    ]);
  });

  it('uses reversible composite resource keys', () => {
    const {api} = loadBackendState();
    const key = api.resourceKey('backend-a', 'agent:with:colons');
    expect(key).toBe('backend-a:agent:with:colons');
    expect(api.splitResourceKey(key)).toEqual({backendId: 'backend-a', remoteId: 'agent:with:colons'});
  });

  it('derives resources only from connected backends and clears caches on deactivation', () => {
    const {api, localStorage} = loadBackendState({rpConnections: '[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    const first = registry.add({id: 'one', name: 'One', base: 'http://one', token: 'token-one', saved: true});
    const second = registry.add({
      id: 'two',
      name: 'Two',
      base: 'http://two',
      token: 'token-two',
      saved: true
    });
    first.status = 'connected';
    second.status = 'off';
    first.agents = [{agentId: 'one:a'}];
    second.agents = [{agentId: 'two:b'}];
    expect(JSON.parse(JSON.stringify(registry.resources('agents')))).toEqual([{agentId: 'one:a'}]);
    registry.deactivate(first, 'error', 'expired');
    expect(first).toMatchObject({
      status: 'error',
      error: 'expired',
      agents: [],
      terminals: [],
      workspaces: []
    });
    expect(registry.resources('agents')).toEqual([]);
  });

  it('stamps remote ids once at the backend boundary', () => {
    const {api, localStorage} = loadBackendState({rpConnections: '[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    const backend = registry.add({
      id: 'home',
      name: 'Home',
      base: 'http://home',
      token: 'token-home',
      saved: true
    });
    expect(registry.stamp(backend, {agentId: 'agent-a', status: 'idle'}, 'agentId')).toMatchObject({
      backendId: 'home',
      backendName: 'Home',
      remoteId: 'agent-a',
      agentId: 'home:agent-a',
      status: 'idle'
    });
  });

  it('matches a cwd to the deepest owning workspace and to nothing outside it', () => {
    const {api} = loadBackendState();
    const workspaces = [
      {id: 'outer', rootPath: '/home/dev'},
      {id: 'inner', rootPath: '/home/dev/project'},
      {id: 'other', rootPath: '/srv/app'}
    ];
    expect(api.matchWorkspace(workspaces, '/home/dev/project/src')).toMatchObject({id: 'inner'});
    expect(api.matchWorkspace(workspaces, '/home/dev/notes')).toMatchObject({id: 'outer'});
    expect(api.matchWorkspace(workspaces, 'C:\\home\\dev\\project')).toBeNull();
    expect(api.matchWorkspace(workspaces, '/home/development')).toBeNull();
    expect(api.matchWorkspace([], '/home/dev')).toBeNull();
  });

  it('shares one saved connection list between the console and the collaboration page', () => {
    const {api, localStorage} = loadBackendState({rpBase: 'http://localhost:11318', rpToken: 'legacy-token'});
    // The collaboration page sees the console's single-backend pairing...
    expect(api.selectConnection(localStorage, 'http://localhost')).toMatchObject({
      base: 'http://localhost:11318',
      token: 'legacy-token'
    });
    // ...and a Backend it pairs itself stays visible to the console.
    api.rememberConnection(localStorage, {
      base: 'https://work.example.com/',
      token: 'work-token',
      name: 'Work',
      remember: true
    });
    expect(
      api
        .loadStoredBackends(localStorage, 'http://localhost')
        .map((item: any) => [item.base, item.token, item.saved])
    ).toEqual([
      ['http://localhost:11318', 'legacy-token', true],
      ['https://work.example.com', 'work-token', true]
    ]);
    expect(api.selectConnection(localStorage, 'http://localhost', 'https://work.example.com')).toMatchObject({
      name: 'Work',
      token: 'work-token'
    });
  });

  it('updates a connection in place and never keeps a code the user declined to save', () => {
    const {api, localStorage} = loadBackendState({
      rpConnections: JSON.stringify([
        {id: 'one', name: 'One', base: 'http://one', token: 'token-one'},
        {id: 'two', name: 'Two', base: 'http://two', token: 'token-two'}
      ])
    });
    api.rememberConnection(localStorage, {base: 'http://two', token: 'rotated', remember: true});
    expect(JSON.parse(localStorage.rpConnections)).toEqual([
      {id: 'one', name: 'One', base: 'http://one', token: 'token-one'},
      {id: 'two', name: 'Two', base: 'http://two', token: 'rotated'}
    ]);
    api.rememberConnection(localStorage, {base: 'http://two', token: 'rotated', remember: false});
    expect(JSON.parse(localStorage.rpConnections)[1]).toEqual({
      id: 'two',
      name: 'Two',
      base: 'http://two',
      token: ''
    });
  });

  it('drops the migrated single-backend code once the shared list owns the connection', () => {
    const {api, localStorage} = loadBackendState({rpBase: 'http://localhost:11318', rpToken: 'legacy-token'});
    api.rememberConnection(localStorage, {
      base: 'http://localhost:11318',
      token: 'legacy-token',
      remember: false
    });
    expect(localStorage.rpToken).toBeUndefined();
    expect(api.savedConnections(localStorage, 'http://localhost')).toEqual([
      {id: 'bk-main', name: '本机', base: 'http://localhost:11318', token: ''}
    ]);
  });

  it('persists tokens only for connections the user chose to save', () => {
    const {api, localStorage} = loadBackendState({rpConnections: '[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    registry.add({id: 'saved', name: 'Saved', base: 'http://saved/', token: 'saved-token', saved: true});
    registry.add({id: 'memory', name: 'Memory', base: 'http://memory/', token: 'memory-token', saved: false});
    registry.persist();
    expect(JSON.parse(localStorage.rpConnections)).toEqual([
      {id: 'saved', name: 'Saved', base: 'http://saved', token: 'saved-token'},
      {id: 'memory', name: 'Memory', base: 'http://memory', token: ''}
    ]);
  });

  it('leaves no migrated pairing code behind once the list is written', () => {
    const {api, localStorage} = loadBackendState({rpBase: 'http://localhost:11318', rpToken: 'legacy-token'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    registry.remove(registry.find('bk-main'));
    registry.persist();
    expect(JSON.parse(localStorage.rpConnections)).toEqual([]);
    expect(localStorage.rpToken).toBeUndefined();
  });
});
