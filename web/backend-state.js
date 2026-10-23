(() => {
  'use strict';

  const CONNECTIONS_KEY = 'rpConnections';
  const LEGACY_BACKEND_ID = 'bk-main';

  function createBackend(entry) {
    return {
      id: entry.id,
      name: String(entry.name || ''),
      base: String(entry.base || '').replace(/\/$/, ''),
      token: String(entry.token || ''),
      saved: Boolean(entry.saved ?? entry.token),
      status: 'off',
      error: '',
      serverInfo: '',
      statusInfo: null,
      authRequired: true,
      agents: [],
      terminals: [],
      workspaces: [],
      ws: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      manuallyClosed: false,
      reconnecting: false
    };
  }

  function createBackendId() {
    return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function resourceKey(backendId, remoteId) {
    return `${backendId}:${remoteId}`;
  }

  const normalizePath = value =>
    String(value || '')
      .split('\\')
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/';
  const isInsidePath = (file, dir) => file === dir || file.startsWith(`${dir}/`);

  /**
   * Picks the Workspace that actually owns a cwd. Callers must pass the Workspaces of one
   * Backend only: identical paths on two machines are different directories. The deepest
   * matching root wins so nested Workspaces resolve to the closest one.
   */
  function matchWorkspace(workspaces, cwd) {
    const target = normalizePath(cwd);
    let best = null,
      bestLength = -1;
    for (const workspace of workspaces || []) {
      const root = normalizePath(workspace.rootPath);
      if (!isInsidePath(target, root)) continue;
      if (root.length > bestLength) {
        best = workspace;
        bestLength = root.length;
      }
    }
    return best;
  }

  function splitResourceKey(key) {
    const value = String(key || '');
    const separator = value.indexOf(':');
    if (separator < 0) return {backendId: '', remoteId: value};
    return {backendId: value.slice(0, separator), remoteId: value.slice(separator + 1)};
  }

  function migrateLegacySelections(storage) {
    const selectedAgentId = String(storage.rpAgentId || '');
    if (selectedAgentId && !selectedAgentId.includes(':')) {
      const compositeId = resourceKey(LEGACY_BACKEND_ID, selectedAgentId);
      storage.rpAgentId = compositeId;
      const cursorKey = `rpSeq:${selectedAgentId}`;
      if (storage[cursorKey] !== undefined) {
        storage[`rpSeq:${compositeId}`] = storage[cursorKey];
        delete storage[cursorKey];
      }
    }
    for (const key of ['rpTerminalId', 'rpWorkspaceId']) {
      const value = String(storage[key] || '');
      if (value && !value.includes(':')) storage[key] = resourceKey(LEGACY_BACKEND_ID, value);
    }
    try {
      const bindings = JSON.parse(storage.rpSessionKeyboardBindings || '[]');
      if (!Array.isArray(bindings)) return;
      storage.rpSessionKeyboardBindings = JSON.stringify(
        bindings.map(binding => {
          const agentId = String(binding?.agentId || '');
          return {
            ...binding,
            agentId: agentId.includes(':') ? agentId : resourceKey(LEGACY_BACKEND_ID, agentId)
          };
        })
      );
    } catch {}
  }

  const normalizeBase = value => String(value || '').replace(/\/$/, '');

  function storedConnections(storage) {
    const stored = storage.getItem(CONNECTIONS_KEY);
    if (stored === null) return null;
    try {
      const entries = JSON.parse(stored);
      if (!Array.isArray(entries)) return null;
      return entries
        .filter(entry => entry && typeof entry.id === 'string' && typeof entry.base === 'string')
        .map(entry => ({
          id: entry.id,
          name: String(entry.name || ''),
          base: normalizeBase(entry.base),
          token: String(entry.token || '')
        }));
    } catch {
      return null;
    }
  }

  /**
   * The console and the collaboration page share one saved connection list, so neither page
   * may read a private format. An explicitly stored list stays authoritative, including when
   * it is empty; the single-backend format is migrated only when no list exists yet.
   */
  function savedConnections(storage, origin) {
    const stored = storedConnections(storage);
    if (stored) return stored;
    // A user who declined to save the pairing code still has a base, selections and keyboard bindings.
    // Migrating without a code keeps their Backend id, so those keep matching after pairing again.
    if (!storage.rpToken && !storage.rpBase) return [];
    migrateLegacySelections(storage);
    return [
      {
        id: LEGACY_BACKEND_ID,
        name: '本机',
        base: normalizeBase(storage.rpBase || origin),
        token: String(storage.rpToken || '')
      }
    ];
  }

  /** Connection a page should offer first: the one for `base`, else any with a saved pairing code. */
  function selectConnection(storage, origin, base = '') {
    const items = savedConnections(storage, origin);
    const wanted = normalizeBase(base);
    return (
      (wanted && items.find(item => item.base === wanted)) ||
      items.find(item => item.token) ||
      items[0] ||
      null
    );
  }

  /** Upserts a connection without touching the other entries. The code is stored only on request. */
  function rememberConnection(storage, {base, token = '', name = '', remember = false} = {}) {
    const value = normalizeBase(base);
    if (!value) return null;
    const items = savedConnections(storage, value);
    const existing = items.find(item => item.base === value);
    const entry = existing || {id: createBackendId(), name: '', base: value, token: ''};
    if (name) entry.name = String(name);
    if (!entry.name) entry.name = value;
    entry.token = remember ? String(token || '') : '';
    const next = existing ? items : [...items, entry];
    storage[CONNECTIONS_KEY] = JSON.stringify(
      next.map(item => ({id: item.id, name: item.name, base: item.base, token: item.token}))
    );
    // The list is authoritative from here on, so the migrated single-backend copy of the code must not
    // survive: keeping it would leave a pairing code behind that the user just asked to forget.
    delete storage.rpToken;
    return entry;
  }

  function loadStoredBackends(storage, origin) {
    return savedConnections(storage, origin).map(entry =>
      createBackend({...entry, saved: Boolean(entry.token)})
    );
  }

  class BackendRegistry {
    constructor(storage, origin) {
      this.storage = storage;
      this.items = loadStoredBackends(storage, origin);
    }

    find(id) {
      return this.items.find(backend => backend.id === id);
    }

    findByBase(base) {
      return this.items.find(backend => backend.base === base);
    }

    connected() {
      return this.items.filter(backend => backend.status === 'connected');
    }

    primary() {
      return this.connected()[0] || null;
    }

    add(entry) {
      const backend = createBackend(entry);
      this.items.push(backend);
      return backend;
    }

    remove(backend) {
      const index = this.items.indexOf(backend);
      if (index >= 0) this.items.splice(index, 1);
    }

    persist() {
      this.storage[CONNECTIONS_KEY] = JSON.stringify(
        this.items.map(backend => ({
          id: backend.id,
          name: backend.name,
          base: backend.base,
          token: backend.saved ? backend.token : ''
        }))
      );
      // The list is authoritative now, so the migrated single-backend copy of the code must not survive.
      delete this.storage.rpToken;
    }

    deactivate(backend, status = 'off', error = '') {
      backend.status = status;
      backend.error = error;
      backend.reconnecting = false;
      backend.agents = [];
      backend.terminals = [];
      backend.workspaces = [];
    }

    resources(property, filterBackendId = '') {
      return this.connected()
        .filter(backend => !filterBackendId || backend.id === filterBackendId)
        .flatMap(backend => backend[property]);
    }

    stamp(backend, item, idProperty) {
      const remoteId = item[idProperty];
      return {
        ...item,
        backendId: backend.id,
        backendName: backend.name,
        remoteId,
        [idProperty]: resourceKey(backend.id, remoteId)
      };
    }
  }

  window.RemotePiBackendState = {
    BackendRegistry,
    CONNECTIONS_KEY,
    LEGACY_BACKEND_ID,
    loadStoredBackends,
    savedConnections,
    selectConnection,
    rememberConnection,
    createBackendId,
    resourceKey,
    splitResourceKey,
    normalizePath,
    isInsidePath,
    matchWorkspace
  };
})();
