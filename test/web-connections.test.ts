import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/backend-state.js', import.meta.url), 'utf8');

function loadBackendState(initial:Record<string,string> = {}) {
  const localStorage = {
    ...initial,
    getItem(key:string) {
      return Object.prototype.hasOwnProperty.call(this, key)
        ? String((this as Record<string, unknown>)[key])
        : null;
    },
  };
  const window:Record<string,unknown> = {};
  runInNewContext(source, {window});
  const api = window.RemotePiBackendState as any;
  return {api, localStorage};
}

describe('backend state', () => {
  it('keeps an explicitly stored empty connection list authoritative', () => {
    const {api, localStorage} = loadBackendState({rpConnections:'[]', rpToken:'legacy-token'});
    expect(api.loadStoredBackends(localStorage, 'http://localhost')).toEqual([]);
  });

  it('migrates the legacy connection and keyboard binding format', () => {
    const {api, localStorage} = loadBackendState({
      rpBase:'http://localhost:11318',
      rpToken:'legacy-token',
      rpAgentId:'agent-a',
      rpTerminalId:'terminal-a',
      rpWorkspaceId:'workspace-a',
      'rpSeq:agent-a':'42',
      rpSessionKeyboardBindings:JSON.stringify([{agentId:'agent-a', slot:0}]),
    });
    const [backend] = api.loadStoredBackends(localStorage, 'http://localhost');
    expect(backend).toMatchObject({id:'bk-main', name:'本机', base:'http://localhost:11318', token:'legacy-token', saved:true, status:'off'});
    expect(JSON.parse(localStorage.rpSessionKeyboardBindings)).toEqual([{agentId:'bk-main:agent-a', slot:0}]);
    expect(localStorage.rpAgentId).toBe('bk-main:agent-a');
    expect(localStorage.rpTerminalId).toBe('bk-main:terminal-a');
    expect(localStorage.rpWorkspaceId).toBe('bk-main:workspace-a');
    expect(localStorage['rpSeq:bk-main:agent-a']).toBe('42');
    expect(localStorage['rpSeq:agent-a']).toBeUndefined();
  });

  it('uses reversible composite resource keys', () => {
    const {api} = loadBackendState();
    const key = api.resourceKey('backend-a', 'agent:with:colons');
    expect(key).toBe('backend-a:agent:with:colons');
    expect(api.splitResourceKey(key)).toEqual({backendId:'backend-a', remoteId:'agent:with:colons'});
  });

  it('derives resources only from connected backends and clears caches on deactivation', () => {
    const {api, localStorage} = loadBackendState({rpConnections:'[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    const first = registry.add({id:'one', name:'One', base:'http://one', token:'token-one', saved:true});
    const second = registry.add({id:'two', name:'Two', base:'http://two', token:'token-two', saved:true});
    first.status = 'connected';
    second.status = 'off';
    first.agents = [{agentId:'one:a'}];
    second.agents = [{agentId:'two:b'}];
    expect(JSON.parse(JSON.stringify(registry.resources('agents')))).toEqual([{agentId:'one:a'}]);
    registry.deactivate(first, 'error', 'expired');
    expect(first).toMatchObject({status:'error', error:'expired', agents:[], terminals:[], workspaces:[]});
    expect(registry.resources('agents')).toEqual([]);
  });

  it('stamps remote ids once at the backend boundary', () => {
    const {api, localStorage} = loadBackendState({rpConnections:'[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    const backend = registry.add({id:'home', name:'Home', base:'http://home', token:'token-home', saved:true});
    expect(registry.stamp(backend, {agentId:'agent-a', status:'idle'}, 'agentId')).toMatchObject({
      backendId:'home', backendName:'Home', remoteId:'agent-a', agentId:'home:agent-a', status:'idle',
    });
  });

  it('persists tokens only for connections the user chose to save', () => {
    const {api, localStorage} = loadBackendState({rpConnections:'[]'});
    const registry = new api.BackendRegistry(localStorage, 'http://localhost');
    registry.add({id:'saved', name:'Saved', base:'http://saved/', token:'saved-token', saved:true});
    registry.add({id:'memory', name:'Memory', base:'http://memory/', token:'memory-token', saved:false});
    registry.persist();
    expect(JSON.parse(localStorage.rpConnections)).toEqual([
      {id:'saved', name:'Saved', base:'http://saved', token:'saved-token'},
      {id:'memory', name:'Memory', base:'http://memory', token:''},
    ]);
  });
});
