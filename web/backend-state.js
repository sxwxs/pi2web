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
      voiceEnabled: false,
      voiceSttEnabled: false,
      agents: [],
      terminals: [],
      workspaces: [],
      ws: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      manuallyClosed: false,
      reconnecting: false,
    };
  }

  function createBackendId() {
    return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function resourceKey(backendId, remoteId) {
    return `${backendId}:${remoteId}`;
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
      storage.rpSessionKeyboardBindings = JSON.stringify(bindings.map(binding => {
        const agentId = String(binding?.agentId || '');
        return {...binding, agentId:agentId.includes(':') ? agentId : resourceKey(LEGACY_BACKEND_ID, agentId)};
      }));
    } catch {}
  }

  function loadStoredBackends(storage, origin) {
    const stored = storage.getItem(CONNECTIONS_KEY);
    try {
      if (stored !== null) {
        const entries = JSON.parse(stored);
        if (Array.isArray(entries)) {
          return entries
            .filter(entry => entry && typeof entry.id === 'string' && typeof entry.base === 'string')
            .map(createBackend);
        }
      }
    } catch {}

    if (!storage.rpToken) return [];
    migrateLegacySelections(storage);
    return [createBackend({
      id: LEGACY_BACKEND_ID,
      name: '本机',
      base: storage.rpBase || origin,
      token: storage.rpToken,
      saved: true,
    })];
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
      this.storage[CONNECTIONS_KEY] = JSON.stringify(this.items.map(backend => ({
        id: backend.id,
        name: backend.name,
        base: backend.base,
        token: backend.saved ? backend.token : '',
      })));
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
        [idProperty]: resourceKey(backend.id, remoteId),
      };
    }
  }

  window.RemotePiBackendState = {
    BackendRegistry,
    CONNECTIONS_KEY,
    LEGACY_BACKEND_ID,
    loadStoredBackends,
    createBackendId,
    resourceKey,
    splitResourceKey,
  };
})();
