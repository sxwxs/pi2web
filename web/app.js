(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {BackendRegistry, createBackendId, resourceKey, splitResourceKey, normalizePath, isInsidePath, matchWorkspace, backendWire, relayChildren} = window.RemotePiBackendState;
  const backendRegistry = new BackendRegistry(localStorage, location.origin);
  // The registry owns backend connections and their resource caches. This object
  // only keeps cross-backend UI selections and transient view state.
  const state = {
    backends: backendRegistry.items,
    backendFilter: localStorage.rpBackendFilter || '',
    workspace: null,
    treePath: '.',
    filePath: null, fileOffset: 0, fileSize: 0, fileLimit: 64 * 1024,
    agent: null, agents: [], terminals: [], terminal: null, selectedKind: 'agent',
    terminalWs: null, terminalEmulator: null, terminalAssetsPromise: null, terminalConnectAttempt: 0, fitAddon: null, resizeObserver: null,
    streams: new Map(), contextTarget: null,
    mentionPath: '.', mentionStart: null, mentionEnd: null, mentionPrefix: '', mentionOptions: [], mentionFiltered: [], mentionIndex: 0, mentionRequest: 0,
    extensionStatus: new Map(), widgets: new Map(), contexts: new Map(), mobileView: 'home',
    queues: new Map(), toolCards: new Map(), commands: [], commandsAgentId: null, commandFiltered: [], commandIndex: 0, commandRequest: 0,
    agentPageSize: Number(localStorage.rpAgentPageSize || 10), agentVisibleCount: Number(localStorage.rpAgentPageSize || 10), messagePageStart: 0, messageTotal: 0, messagePageSize: 25,
    voiceEnabled: false, voiceSttEnabled: false, voicePlaybackEnabled: localStorage.rpVoicePlayback === 'true', voiceAudio: {context:null,nextTime:0,playbackId:null,backendId:null,sources:new Set(),decodeChain:Promise.resolve(),generation:0}, mediaRecorder:null, mediaChunks:[], mediaStream:null, mediaTimer:null, mediaAgentId:null,
    mailBackendId: null, mailRequest: 0, mailNotificationsAvailable:false,
    mailSettings:{enabled:false,aggregationDelaySeconds:0,includeResponse:true,includeSessionDetails:true,collabEscalations:true},
  };
  $('pairBase').value = state.backends[0]?.base || location.origin;
  $('pairName').value = state.backends[0]?.name || '';

  const clean = normalizePath;
  const joinPath = (base, name) => base === '.' ? name : `${base}/${name}`;
  const parentPath = value => { const p = value.split('/'); p.pop(); return p.join('/') || '.'; };
  const absolutePath = relative => clean(`${state.workspace.rootPath}/${relative === '.' ? '' : relative}`);
  const isInside = isInsidePath;
  /** A cwd only belongs to a Workspace of the same Backend: the same path on two machines is two directories. */
  const ownsPath = (workspace, item) => !!workspace && workspace.backendId === item.backendId && isInside(clean(item.cwd), clean(workspace.rootPath));
  const relativeTo = (file, dir) => file === dir ? '.' : file.slice(dir.length + 1);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toast = text => { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 3000); };
  const backendOf = id => backendRegistry.find(id);
  const wireOf = backend => backendWire(backend, backendOf(backend.relayVia));
  /** Every call to a Backend goes through here, so a relayed one can never fall back to its own address. */
  const requireWire = backend => {
    const wire = wireOf(backend);
    if (!wire) throw Error(`请先连接中继 Backend「${backendOf(backend.relayVia)?.name || backend.relayVia}」`);
    return wire;
  };
  const relayName = backend => backend.relayHostId ? `经「${backendOf(backend.relayVia)?.name || '?'}」中继` : '';
  const connectedBackends = () => backendRegistry.connected();
  const primaryBackend = () => backendRegistry.primary();
  const hasConnection = () => connectedBackends().length > 0;
  const requireConnection = () => { if (!hasConnection()) { openPair(state.backends[0] || null); return false; } return true; };
  const mobileMedia = matchMedia('(max-width: 700px)');
  const isMobile = () => mobileMedia.matches;
  function setMobileView(view, {push = false, replace = false} = {}) {
    if (!['home','workspace','file','agent'].includes(view)) view = 'home';
    const changed = state.mobileView !== view;
    state.mobileView = view; document.body.dataset.mobileView = view;
    $('workspaceHeading').textContent = view === 'home' ? 'Workspace' : state.workspace?.label || 'Workspace';
    $('mobileAgentActions').closest('.toolbar')?.classList.remove('actions-open');
    if (!isMobile()) return;
    const historyState = {...(history.state || {}), rpView:view};
    if (replace) history.replaceState(historyState, '');
    else if (push && (changed || history.state?.rpView !== view)) history.pushState(historyState, '');
  }
  const navigateMobile = view => { if (isMobile()) setMobileView(view, {push:true}); };
  const mobileBack = fallback => { if (isMobile() && history.state?.rpView === state.mobileView && state.mobileView !== 'home') history.back(); else setMobileView(fallback, {replace:true}); };

  async function request(base, token, url, options = {}, onUnauthorized) {
    const headers = {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers};
    const response = await fetch(base + url, {...options, headers});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      // Status and code travel with the error: a caller cleaning up may need to tell "already gone"
      // from "could not reach it", which the message alone does not say.
      throw Object.assign(Error(body.error?.message || `HTTP ${response.status}`), {status:response.status, code:body.error?.code});
    }
    return body.data;
  }
  async function backendRequiresAuth(base) {
    try { return (await request(base, '', '/health')).authRequired !== false; } catch { return true; }
  }
  async function requestBackend(backendId, url, options = {}) {
    const backend = backendOf(backendId);
    if (!backend) throw Error('Backend 不存在');
    if (backend.status !== 'connected') throw Error(`Backend「${backend.name || backendId}」未连接`);
    const wire = requireWire(backend);
    return request(wire.prefix, wire.token, url, options, () => {
      if (backend.status === 'connected') void deactivateBackend(backend, {status:'error', error:'配对码无效或已失效'});
    });
  }
  const postBackend = (backendId, url, body = {}) => requestBackend(backendId, url, {method:'POST', body:JSON.stringify(body)});
  const requestAgent = (agentId, suffix = '', options = {}) => {
    const {backendId, remoteId} = splitResourceKey(agentId);
    return requestBackend(backendId, `/api/v1/agents/${encodeURIComponent(remoteId)}${suffix}`, options);
  };
  const postAgent = (agentId, suffix = '', body = {}) => requestAgent(agentId, suffix, {method:'POST', body:JSON.stringify(body)});
  /**
   * Deletes the relay records of Backends that are about to be forgotten here. Every record holds a
   * target's address and pairing code, so one that cannot be deleted is reported rather than leaked
   * silently, and one failure does not stop the records after it from being deleted.
   *
   * A record the relay no longer has counts as deleted, so retrying a half-finished cascade can
   * actually finish instead of failing on the part that already succeeded.
   */
  async function deleteRelayRecords(items) {
    const failed = [];
    for (const item of items) {
      if (!item.relayHostId) continue;
      try {
        await requestBackend(item.relayVia, `/api/v1/hosts/${encodeURIComponent(item.relayHostId)}`, {method:'DELETE'});
      } catch (error) {
        if (error.status !== 404 && error.code !== 'HOST_NOT_FOUND') failed.push({backend:item, error});
      }
    }
    return failed;
  }

  function openPair(backend = null) {
    if ($('pairDialog').open) return;
    if ($('configDialog').open) $('configDialog').close();
    $('pairDialog').dataset.backendId = backend?.id || '';
    $('pairName').value = backend?.name || '';
    $('pairBase').value = backend?.base || location.origin;
    $('pairToken').value = backend?.token || '';
    renderRelayOptions(backend);
    if (!$('pairDialog').open) $('pairDialog').showModal();
  }
  function persistConnections() {
    backendRegistry.persist();
  }

  /** Only a connected direct Backend can relay: it is the one that will reach the target and store its code. */
  function renderRelayOptions(backend = null) {
    const select = $('pairRelayVia'), connected = connectedBackends().filter(item => !item.relayHostId && item.id !== backend?.id);
    // The Backend's own relay stays on the list while it is offline: dropping it would leave the route
    // silently set to 直连, so editing a name would try to reach the target the browser cannot reach.
    const current = backend?.relayVia ? backendOf(backend.relayVia) : null;
    const relays = current && !connected.includes(current) ? [...connected, current] : connected;
    const direct = document.createElement('option'); direct.value = ''; direct.textContent = '直连';
    select.replaceChildren(direct, ...relays.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = `经「${item.name || item.base}」中继${item.status === 'connected' ? '' : '（未连接）'}`; return option;
    }));
    select.value = relays.some(item => item.id === backend?.relayVia) ? backend.relayVia : '';
    select.closest('label').hidden = !relays.length;
  }

  function updateHeaderStatus() {
    const connected = connectedBackends();
    const reconnecting = connected.some(backend => backend.reconnecting);
    if (!connected.length) {
      $('status').className = 'bad';
      $('status').textContent = '未配对';
      $('serverInfo').textContent = '';
      return;
    }
    $('status').className = 'ok';
    $('status').textContent = state.backends.length > 1 ? `已连接 ${connected.length}/${state.backends.length}` : '已配对';
    if (reconnecting) $('status').textContent += ' · 重连中';
    $('serverInfo').textContent = connected.map(backend => backend.name).join(' · ');
  }

  function closeBackendSocket(backend) {
    clearTimeout(backend.reconnectTimer);
    backend.manuallyClosed = true;
    backend.reconnecting = false;
    backend.ws?.close();
    backend.ws = null;
  }

  function clearWorkspaceSelection(backendId) {
    if (backendId && state.workspace?.backendId !== backendId) return;
    state.workspace = null;
    localStorage.removeItem('rpWorkspaceId');
    $('filePanel').hidden = true;
    $('tree').innerHTML = '<div class="muted">请添加 Workspace</div>';
    $('workspaceHeading').textContent = 'Workspace';
  }

  function cancelVoiceRecording(backendId) {
    if (!state.mediaAgentId) return;
    if (backendId && splitResourceKey(state.mediaAgentId).backendId !== backendId) return;
    clearTimeout(state.mediaTimer);
    if (state.mediaRecorder) {
      state.mediaRecorder.onstop = null;
      if (state.mediaRecorder.state === 'recording') state.mediaRecorder.stop();
    }
    state.mediaStream?.getTracks().forEach(track => track.stop());
    state.mediaRecorder = null;
    state.mediaStream = null;
    state.mediaChunks = [];
    state.mediaAgentId = null;
    $('voiceInput').textContent = '🎙';
    $('voiceInput').classList.remove('recording');
  }

  function clearAgentSelection(backendId) {
    cancelVoiceRecording(backendId);
    if (backendId && state.agent?.backendId !== backendId) return;
    state.agent = null;
    localStorage.removeItem('rpAgentId');
    $('agentTitle').textContent = '请选择 Agent';
    $('agentStatus').textContent = '';
    $('agentStateBadge').textContent = '未选择';
    $('agentStateBadge').className = 'state-badge state-none';
    $('contextUsage').hidden = true;
    $('messages').innerHTML = '<div class="empty">选择或创建 Agent 开始对话</div>';
    state.extensionStatus.clear();
    state.widgets.clear();
    renderExtensionStatus();
    renderWidgets();
  }

  function clearTerminalSelection(backendId) {
    if (backendId && state.terminal?.backendId !== backendId) return;
    state.terminalConnectAttempt++;
    state.terminalWs?.close();
    state.terminalWs = null;
    state.terminal = null;
    localStorage.removeItem('rpTerminalId');
    if (state.selectedKind === 'terminal') {
      state.selectedKind = 'agent';
      localStorage.rpSelectedKind = 'agent';
      showAgentView();
    }
  }

  function deactivateBackendState(backend, status, error = '') {
    closeBackendSocket(backend);
    if (state.voiceAudio.backendId === backend.id) stopVoiceAudio();
    backendRegistry.deactivate(backend, status, error);
    clearWorkspaceSelection(backend.id);
    clearAgentSelection(backend.id);
    clearTerminalSelection(backend.id);
    // A relayed Backend only exists through its relay, so it goes down with it.
    for (const relayed of relayChildren(state.backends, backend.id)) if (relayed.status === 'connected') deactivateBackendState(relayed, status, error);
  }

  async function deactivateBackend(backend, {status = 'off', error = ''} = {}) {
    deactivateBackendState(backend, status, error);
    syncSessionLists();
    updateVoiceAvailability();
    updateHeaderStatus();
    renderBackendList();
    renderBackendFilter();
    await renderWorkspaces();
    await loadPrimaryMailSettings();
    updateConfigUi();
  }

  async function disconnectAll(reason = '已断开全部连接') {
    for (const backend of state.backends) deactivateBackendState(backend, 'off');
    clearWorkspaceSelection();
    clearAgentSelection();
    clearTerminalSelection();
    syncSessionLists();
    updateVoiceAvailability();
    updateHeaderStatus();
    renderBackendList();
    renderBackendFilter();
    await renderWorkspaces();
    await loadPrimaryMailSettings();
    updateConfigUi();
    if (reason) {
      $('status').className = 'bad';
      $('status').textContent = reason;
    }
  }

  function updateVoiceAvailability() {
    const backends = connectedBackends();
    state.voiceEnabled = backends.some(backend => backend.voiceEnabled);
    state.voiceSttEnabled = backends.some(backend => backend.voiceSttEnabled);
    $('voicePlayback').hidden = !state.voiceEnabled;
    $('voiceInput').hidden = !state.voiceSttEnabled;
    if (!state.voiceEnabled) stopVoiceAudio();
    updateVoiceButton();
  }
  async function connectBackend(entry, {confirmSave = true, pair = true} = {}) {
    const base = String(entry.base || '').trim().replace(/\/$/, '') || location.origin;
    let token = String(entry.token || '').trim();
    const wire = requireWire({...entry, base, token});
    // A relayed Backend holds no code in this browser: the relay authenticates for it, whether or not
    // the target asks for one. Only a direct one has to find out whether this server still wants a code.
    if (!entry.relayHostId && !token && await backendRequiresAuth(wire.prefix)) {
      if (pair) openPair(entry);
      throw Error('请先输入配对码');
    }

    const statusInfo = await request(wire.prefix, wire.token, '/api/v1/system/status');
    if (statusInfo.protocolVersion !== 1) {
      throw Error(`不支持的协议版本 ${statusInfo.protocolVersion}（需要 1）`);
    }
    const authRequired = statusInfo.authRequired !== false;
    if (!authRequired) token = '';

    let backend = backendOf(entry.id);
    if (!backend) {
      backend = backendRegistry.add({
        id: entry.id || createBackendId(),
        name: '', base: '', token: '', saved: false,
      });
    }

    closeBackendSocket(backend);
    Object.assign(backend, {
      name: String(entry.name || '').trim() || base,
      base,
      token,
      relayHostId: entry.relayHostId || '',
      relayVia: entry.relayVia || '',
      status: 'connected',
      error: '',
      statusInfo,
      authRequired,
      serverInfo: `v${statusInfo.version} · Pi ${statusInfo.piVersion}`,
      reconnectAttempt: 0,
      voiceEnabled: Boolean(statusInfo.voiceCapabilities?.tts ?? statusInfo.voiceEnabled),
      voiceSttEnabled: Boolean(statusInfo.voiceCapabilities?.stt ?? statusInfo.voiceEnabled),
    });

    try {
      await refreshBackendData(backend);
    } catch (error) {
      if (backend.status !== 'error') await deactivateBackend(backend, {status:'error', error:error.message});
      throw error;
    }

    // A relayed Backend keeps no secret in this browser, so there is nothing to ask about saving.
    if (entry.saved || backend.relayHostId) backend.saved = true;
    if (confirmSave && authRequired && !backend.saved && confirm(`是否将「${backend.name}」的配对码保存到浏览器本地存储？\n\n请仅在可信设备上保存。`)) {
      backend.saved = true;
    }
    persistConnections();
    connectSocket(backend);
    updateVoiceAvailability();
    updateHeaderStatus();
    renderBackendList();
    renderBackendFilter();
    await renderWorkspaces();
    await restorePreviousSelection();
    await loadPrimaryMailSettings();
    updateConfigUi();
    return backend;
  }

  async function refreshBackendData(backend) {
    const [workspaces, agents, terminals] = await Promise.all([
      requestBackend(backend.id, '/api/v1/workspaces'),
      requestBackend(backend.id, '/api/v1/agents'),
      requestBackend(backend.id, '/api/v1/terminals'),
    ]);
    if (backend.status !== 'connected') return;
    backend.workspaces = workspaces.map(workspace => ({
      ...workspace,
      backendId: backend.id,
      backendName: backend.name,
    }));
    backend.agents = agents.map(agent => backendRegistry.stamp(backend, agent, 'agentId'));
    backend.terminals = terminals.map(terminal => backendRegistry.stamp(backend, terminal, 'terminalId'));
    syncSessionLists();
  }

  async function refreshBackendWorkspaces(backend) {
    const workspaces = await requestBackend(backend.id, '/api/v1/workspaces');
    if (backend.status !== 'connected') return;
    backend.workspaces = workspaces.map(workspace => ({
      ...workspace,
      backendId: backend.id,
      backendName: backend.name,
    }));
  }

  async function restorePreviousSelection() {
    if (state.agent || state.terminal) return;
    const terminal = state.terminals.find(item => item.terminalId === localStorage.rpTerminalId);
    const agent = state.agents.find(item => item.agentId === localStorage.rpAgentId);
    if (localStorage.rpSelectedKind === 'terminal' && terminal) await selectTerminal(terminal, false);
    else if (agent) await selectAgent(agent, false);
  }

  const visibleWorkspaces = () => backendRegistry.resources('workspaces', state.backendFilter);
  const workspaceKey = workspace => resourceKey(workspace.backendId, workspace.id);
  const workspaceLabel = workspace => connectedBackends().length > 1 ? `${workspace.backendName} · ${workspace.label}` : workspace.label;
  async function renderWorkspaces() {
    const workspaces = visibleWorkspaces();
    $('workspaces').replaceChildren(...workspaces.map(workspace => {
      const option = document.createElement('option');
      option.value = workspaceKey(workspace);
      option.textContent = `${workspaceLabel(workspace)} (${workspace.rootPath})`;
      return option;
    }));
    renderMobileWorkspaces();
    if (workspaces.length) {
      const wanted = state.workspace ? workspaceKey(state.workspace) : localStorage.rpWorkspaceId;
      const values = workspaces.map(workspaceKey);
      if (values.includes(wanted)) { $('workspaces').value = wanted; if (!state.workspace) await selectWorkspace(); }
      else { $('workspaces').value = values[0]; await selectWorkspace(); }
    } else {
      clearWorkspaceSelection();
    }
  }
  function renderBackendFilter() {
    const select = $('backendFilter');
    if (!select) return;
    // Every saved Backend is listed, not only the connected ones: this also runs before the automatic
    // connections start, where dropping the filter of a still disconnected Backend would discard the
    // stored choice on every reload. Removing a Backend clears the filter where it is removed.
    select.replaceChildren(...state.backends.map(backend => {
      const option = document.createElement('option'); option.value = backend.id; option.textContent = backend.name || backend.base; return option;
    }));
    const all = document.createElement('option'); all.value = ''; all.textContent = '全部 Backend';
    select.prepend(all);
    select.value = state.backendFilter;
    select.hidden = state.backends.length < 2;
  }
  function renderBackendList() {
    const list = $('backendList');
    if (!list) return;
    list.replaceChildren(...state.backends.map(backend => {
      const row = document.createElement('div'); row.className = 'backend-row';
      const info = document.createElement('div'); info.className = 'backend-row-info';
      const name = document.createElement('b'); name.textContent = backend.name || backend.base;
      const detail = document.createElement('small');
      const statusText = backend.status === 'connected' ? (backend.reconnecting ? '已连接 · 重连中' : `已连接 · ${backend.authRequired === false ? '无需认证 · ' : ''}${backend.serverInfo}`) : backend.status === 'error' ? `连接失败 · ${backend.error || ''}` : '未连接';
      detail.textContent = [backend.base, relayName(backend), statusText].filter(Boolean).join(' · ');
      info.append(name, detail);
      const actions = document.createElement('div'); actions.className = 'backend-row-actions';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = backend.status === 'connected' ? '断开' : '连接';
      toggle.onclick = async () => {
        toggle.disabled = true;
        try {
          if (backend.status === 'connected') {
            await deactivateBackend(backend);
          } else {
            await connectBackend(backend, {confirmSave: false});
            toast(`已连接 ${backend.name}`);
          }
        } catch (error) {
          if (backend.status !== 'error') await deactivateBackend(backend, {status:'error', error:error.message});
          toast(error.message);
        } finally {
          toggle.disabled = false;
        }
      };
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '修改';
      edit.onclick = () => openPair(backend);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-action'; remove.textContent = '删除';
      remove.onclick = async () => {
        const relayed = relayChildren(state.backends, backend.id), removed = [backend, ...relayed];
        const question = backend.relayHostId ? `删除 backend「${backend.name}」？中继记录也会从「${backendOf(backend.relayVia)?.name || '中继节点'}」上删除。`
          : relayed.length ? `删除 backend「${backend.name}」？通过它中继的 ${relayed.length} 个 backend 也会一并删除。`
          : `删除 backend「${backend.name}」？只影响这个页面，不会停止该机器上的服务。`;
        if (!confirm(question)) return;
        // Each relay record holds a target's address and pairing code, so it has to go before the relay
        // is forgotten here and becomes unreachable. The children's records live on the relay too.
        const failed = await deleteRelayRecords(removed);
        if (failed.length) {
          const detail = failed.map(entry => `「${entry.backend.name || entry.backend.base}」：${entry.error.message}`).join('\n');
          // Answering no keeps every entry, which is what makes the deletion retryable once the relay is back.
          if (!confirm(`以下中继记录删除失败：\n${detail}\n\n仍然从这个浏览器移除吗？这些目标配对码会留在中继服务器上，只能到中继那台机器上手动清理。`)) return;
        }
        const agentIds = removed.flatMap(item => item.agents.map(agent => agent.agentId));
        for (const item of removed) { deactivateBackendState(item, 'off'); backendRegistry.remove(item); }
        persistConnections();
        for (const agentId of agentIds) sessionKeyboard.unbind(agentId);
        if (removed.some(item => item.id === state.backendFilter)) {
          state.backendFilter = '';
          localStorage.removeItem('rpBackendFilter');
        }
        syncSessionLists();
        updateVoiceAvailability();
        updateHeaderStatus();
        renderBackendFilter();
        await renderWorkspaces();
        await loadPrimaryMailSettings();
        updateConfigUi();
        toast('已删除 backend');
      };
      actions.append(toggle, edit, remove); row.append(info, actions);
      return row;
    }));
  }

  async function refreshWs() {
    if (!requireConnection()) return;
    await Promise.allSettled(connectedBackends().map(refreshBackendWorkspaces));
    await renderWorkspaces();
  }
  function renderMobileWorkspaces() {
    $('mobileWorkspaces').replaceChildren(...visibleWorkspaces().map(workspace => {
      const button=document.createElement('button');button.type='button';button.className='workspace-card';
      const name=document.createElement('b'),path=document.createElement('small');name.textContent=workspaceLabel(workspace);path.textContent=workspace.rootPath;button.append(name,path);
      button.onclick=async()=>{try{$('workspaces').value=workspaceKey(workspace);await selectWorkspace();navigateMobile('workspace');}catch(error){toast(error.message);}};return button;
    }));
  }
  async function selectWorkspace(selectedKey = $('workspaces').value) {
    const {backendId, remoteId} = splitResourceKey(selectedKey);
    state.workspace = backendOf(backendId)?.workspaces.find(workspace => workspace.id === remoteId) || null;
    if (!state.workspace) return;
    // A Backend filter can hide the owning Workspace from the picker; the selection still has to follow it.
    if ([...$('workspaces').options].some(option => option.value === selectedKey)) $('workspaces').value = selectedKey;
    localStorage.rpWorkspaceId = selectedKey;
    state.treePath = '.';
    $('agentCwd').value = '.';
    $('filePanel').hidden = true;
    $('workspaceHeading').textContent = isMobile() && state.mobileView !== 'home' ? workspaceLabel(state.workspace) : 'Workspace';
    await loadTree();
  }
  async function loadTree() {
    const workspace = state.workspace;
    const treePath = state.treePath;
    if (!workspace) return;
    $('treePath').textContent = absolutePath(treePath);
    try {
      const items = await requestBackend(workspace.backendId, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/tree?path=${encodeURIComponent(treePath)}`);
      if (!state.workspace || workspaceKey(state.workspace) !== workspaceKey(workspace) || state.treePath !== treePath) return;
      $('tree').replaceChildren(...items.map(item => {
        const el = document.createElement('div'); el.className = `entry ${item.type === 'directory' ? 'dir' : 'file-entry'}`;
        el.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`;
        const relativePath = joinPath(treePath, item.name);
        el.onclick = () => item.type === 'directory' ? openDirectory(relativePath) : openFile(relativePath, 0);
        const contextTarget={relativePath,type:item.type};el.oncontextmenu=event=>showContextMenu(event,contextTarget);enableLongPressMenu(el,event=>showContextMenu(event,contextTarget));return el;
      }));
    } catch (error) { $('tree').textContent = error.message; }
  }
  async function openDirectory(relativePath) { state.treePath = relativePath; $('filePanel').hidden = true; await loadTree(); }
  async function openFile(relativePath, offset, showView = true) {
    const workspace = state.workspace;
    if (!workspace) return;
    try {
      const file = await requestBackend(workspace.backendId, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(relativePath)}&offset=${offset}&limit=${state.fileLimit}`);
      if (!state.workspace || workspaceKey(state.workspace) !== workspaceKey(workspace)) return;
      state.filePath = relativePath; state.fileOffset = file.offset; state.fileSize = file.size;
      $('filePanel').hidden = false; $('fileName').textContent = relativePath;
      $('file').textContent = file.binary ? `[二进制文件，${file.size} bytes，无法预览]` : file.content;
      $('filePage').textContent = `${file.offset.toLocaleString()}–${Math.min(file.offset + file.limit, file.size).toLocaleString()} / ${file.size.toLocaleString()} bytes`;
      $('filePrev').disabled = file.offset <= 0; $('fileNext').disabled = file.binary || file.offset + file.limit >= file.size;
      if (showView) navigateMobile('file');
    } catch (error) { toast(error.message); }
  }
  function showContextMenu(event, target) {
    event.preventDefault(); state.contextTarget = target; const isDirectory = target.type === 'directory'; $('menuStartAgent').hidden = !isDirectory; $('menuSetCwd').hidden = !isDirectory; $('menuOpenTerminal').hidden = !isDirectory;
    const menu = $('contextMenu'); menu.hidden = false; const margin=8;menu.style.left=`${Math.max(margin,Math.min(event.clientX,innerWidth-menu.offsetWidth-margin))}px`;menu.style.top=`${Math.max(margin,Math.min(event.clientY,innerHeight-menu.offsetHeight-margin))}px`;
  }
  function enableLongPressMenu(element, openMenu) {
    let timer=null,pointerId=null,startX=0,startY=0,suppressClickUntil=0;
    const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;pointerId=null;element.classList.remove('long-press-pending');};
    element.classList.add('long-press-menu');
    element.addEventListener('pointerdown',event=>{
      if(!isMobile()||event.pointerType==='mouse'||event.button!==0||!event.isPrimary)return;
      cancel();pointerId=event.pointerId;startX=event.clientX;startY=event.clientY;element.classList.add('long-press-pending');
      timer=setTimeout(()=>{timer=null;suppressClickUntil=Date.now()+700;element.classList.remove('long-press-pending');navigator.vibrate?.(15);openMenu({preventDefault(){},clientX:startX,clientY:startY});},550);
    });
    element.addEventListener('pointermove',event=>{if(event.pointerId===pointerId&&Math.hypot(event.clientX-startX,event.clientY-startY)>10)cancel();});
    element.addEventListener('pointerup',event=>{if(event.pointerId===pointerId)cancel();});
    element.addEventListener('pointercancel',cancel);element.addEventListener('pointerleave',event=>{if(event.pointerId===pointerId)cancel();});
    element.addEventListener('click',event=>{if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
  function mentionContext() {
    const input=$('input'),end=input.selectionStart,before=input.value.slice(0,end),match=before.match(/(^|\s)@(?:"([^"]*)"?|([^\s]*))$/);
    if(!match)return null;const token=match[0].slice(match[1]?.length||0),start=end-token.length,replacementEnd=end+(token.startsWith('@"')&&input.value[end]==='"'?1:0);return {start,end,replacementEnd,query:match[2]??match[3]??''};
  }
  function mentionValue(relativePath, directory=false) {
    const target=absolutePath(relativePath),cwd=clean(state.agent?.cwd||absolutePath($('agentCwd').value.trim()||'.'));
    let value=isInside(target,cwd)?relativeTo(target,cwd):target;if(directory&&value!=='.')value+='/';return value;
  }
  function writeMention(relativePath,{directory=false,close=true}={}) {
    if(!state.workspace)return;const input=$('input'),context=mentionContext(),from=state.mentionStart??context?.start??input.selectionStart,to=state.mentionEnd??context?.replacementEnd??input.selectionStart;
    const value=mentionValue(relativePath,directory),quoted=value.includes(' '),mention=`@${quoted?`"${value}"`:value}`;input.setRangeText(`${mention}${close?' ':''}`,from,to,'end');state.mentionStart=from;state.mentionEnd=from+mention.length;if(directory&&!close&&quoted)input.setSelectionRange(state.mentionEnd-1,state.mentionEnd-1);input.focus();if(close)closeMention();
  }
  function insertMention(relativePath) { state.mentionStart=null;state.mentionEnd=null;writeMention(relativePath); }
  function setMentionSelection(index) {
    const count=state.mentionFiltered.length;if(!count){state.mentionIndex=0;return;}state.mentionIndex=(index+count)%count;
    $('mentionItems').querySelectorAll('.picker-item').forEach((element,i)=>element.classList.toggle('selected',i===state.mentionIndex));
    $('mentionItems').querySelector('.picker-item.selected')?.scrollIntoView({block:'nearest'});
  }
  function browseMention(path) { writeMention(path,{directory:true,close:false});state.mentionPrefix=mentionValue(path,true);void openMention(path,''); }
  function chooseMention(option,close) {
    if(!option)return;if(option.type==='directory'&&!close&&!option.current){browseMention(option.path);return;}
    writeMention(option.path,{close});if(!close)state.mentionPrefix='';
  }
  function renderMentionItems(filter='') {
    const query=filter.toLocaleLowerCase(),options=state.mentionOptions.filter(option=>!query||(!option.current&&(option.name.toLocaleLowerCase().includes(query)||option.path.toLocaleLowerCase().includes(query))));
    state.mentionFiltered=options;state.mentionIndex=0;
    if(!options.length){const empty=document.createElement('div');empty.className='picker-empty muted';empty.textContent='没有匹配的文件或目录';$('mentionItems').replaceChildren(empty);return;}
    $('mentionItems').replaceChildren(...options.map((option,index)=>{const el=document.createElement('div');el.className=`picker-item ${option.type==='directory'?'dir':'file-entry'}${index===0?' selected':''}`;el.textContent=option.label;el.onmouseenter=()=>setMentionSelection(index);el.onclick=()=>chooseMention(option,option.type!=='directory'||option.current);return el;}));
  }
  async function openMention(path=state.treePath,filter='') {
    if(!state.workspace)return;const request=++state.mentionRequest;state.mentionPath=path;$('mentionPicker').hidden=false;$('mentionPath').textContent=absolutePath(path);
    try {
      const items=await requestBackend(state.workspace.backendId, `/api/v1/workspaces/${encodeURIComponent(state.workspace.id)}/tree?path=${encodeURIComponent(path)}`);if(request!==state.mentionRequest)return;
      state.mentionOptions=[{name:'引用当前目录',path,type:'directory',current:true,label:'📁 引用当前目录'},...items.map(item=>({name:item.name,path:joinPath(path,item.name),type:item.type,current:false,label:`${item.type==='directory'?'📁':'📄'} ${item.name}`}))];renderMentionItems(filter);
    } catch(error){if(request===state.mentionRequest)$('mentionItems').textContent=error.message;}
  }
  function closeMention(){state.mentionRequest++;state.mentionStart=null;state.mentionEnd=null;state.mentionPrefix='';$('mentionPicker').hidden=true;}

  // Slash commands: prompt templates and skills are expanded by the Pi session itself
  // (AgentSession.prompt() expands them by default), so the composer only has to help discover them.
  function commandContext() {
    const input=$('input'),end=input.selectionStart,before=input.value.slice(0,end);
    const match=before.match(/^\/([^\s]*)$/);return match?{end,query:match[1]}:null;
  }
  async function loadCommands(agentId) {
    if(state.commandsAgentId===agentId)return state.commands;
    const commands=await requestAgent(agentId,'/commands');return Array.isArray(commands)?commands:[];
  }
  function setCommandSelection(index) {
    const count=state.commandFiltered.length;if(!count){state.commandIndex=0;return;}state.commandIndex=(index+count)%count;
    $('commandItems').querySelectorAll('.picker-item').forEach((element,i)=>element.classList.toggle('selected',i===state.commandIndex));
    $('commandItems').querySelector('.picker-item.selected')?.scrollIntoView({block:'nearest'});
  }
  function chooseCommand(option) {
    if(!option)return;const input=$('input'),context=commandContext();
    input.setRangeText(`/${option.name} `,0,context?context.end:input.value.length,'end');closeCommandPicker();input.focus();
  }
  function renderCommandItems(query='') {
    const filter=query.toLocaleLowerCase(),options=state.commands.filter(command=>!filter||command.name.toLocaleLowerCase().includes(filter));
    state.commandFiltered=options;state.commandIndex=0;
    if(!options.length){const empty=document.createElement('div');empty.className='picker-empty muted';empty.textContent=state.commands.length?'没有匹配的命令':'当前目录没有 prompt template 或 skill';$('commandItems').replaceChildren(empty);return;}
    $('commandItems').replaceChildren(...options.map((option,index)=>{
      const el=document.createElement('div');el.className=`picker-item${index===0?' selected':''}`;
      const name=document.createElement('b');name.textContent=`/${option.name}${option.argumentHint?` ${option.argumentHint}`:''}`;
      const description=document.createElement('small');description.className='muted';description.textContent=`${option.source==='skill'?'skill':'prompt'}${option.description?` · ${option.description}`:''}`;
      el.append(name,description);el.onmouseenter=()=>setCommandSelection(index);el.onclick=()=>chooseCommand(option);return el;
    }));
  }
  async function openCommandPicker(query='') {
    if(!state.agent)return;const agentId=state.agent.agentId,request=++state.commandRequest;$('commandPicker').hidden=false;
    if(state.commandsAgentId!==agentId){state.commands=[];$('commandItems').textContent='正在加载命令…';}
    try{const commands=await loadCommands(agentId);if(request!==state.commandRequest||state.agent?.agentId!==agentId||$('commandPicker').hidden)return;state.commands=commands;state.commandsAgentId=agentId;renderCommandItems(query);}
    catch(error){if(request===state.commandRequest&&state.agent?.agentId===agentId){state.commands=[];$('commandItems').textContent='无法加载命令';console.error('Unable to load slash commands',error);}}
  }
  function closeCommandPicker(){state.commandRequest++;$('commandPicker').hidden=true;state.commandFiltered=[];state.commandIndex=0;}

  function agentName(agent) { return agent.sessionName || agent.name; }
  function agentLabel(agent) { return agentName(agent) || agent.cwd || agent.agentId; }
  function agentSubtitle(agent) { return agentName(agent) ? agent.cwd : agent.agentId; }
  function updateKeyboardUi(connection) {
    const connected=connection?.connected??sessionKeyboard.connected,name=connection?.name||sessionKeyboard.device?.productName||'Codex Micro';
    $('keyboardConnect').hidden=connected;$('keyboardDisconnect').hidden=!connected;
    const unavailable=!window.isSecureContext?'需要 HTTPS 或 localhost':!navigator.hid?'当前浏览器不支持 WebHID':'';
    $('keyboardConnect').disabled=Boolean(unavailable);$('keyboardConnect').title=unavailable;
    $('keyboardStatus').textContent=connected?`已连接 ${name} · LLM 慢速呼吸，Tool 中速呼吸，Retry 快速呼吸，等待输入浅呼吸，空闲常亮`:unavailable||'未连接 · 绑定保存在当前浏览器';
    renderKeyboardBindings();
  }
  function renderKeyboardBindings() {
    const slots = $('keyboardSlots');
    if (!slots) return;
    const focusedId = slots.contains(document.activeElement) ? document.activeElement.id : '';
    const agents = new Map(state.agents.map(agent => [agent.agentId, agent]));
    const canBind = hasConnection() && state.agents.some(agent => !sessionKeyboard.getBinding(agent.agentId));
    slots.replaceChildren(...Array.from({length:6}, (_, slot) => {
      const binding = sessionKeyboard.getSlot(slot), agent = binding && agents.get(binding.agentId);
      const el = document.createElement('div'); el.className = 'keyboard-slot';
      el.style.setProperty('--key-color', binding?.color || '#586174');
      const title = document.createElement('b'); title.textContent = `键 ${slot+1}${binding ? ' · '+binding.color : ''}`;
      const detail = document.createElement('small'); detail.textContent = binding ? (agent ? agentLabel(agent) : 'Session 当前不可用') : '未绑定';
      const actions = document.createElement('div'); actions.className = 'keyboard-slot-actions';
      if (binding) {
        const color = document.createElement('button'); color.type = 'button'; color.textContent = '颜色…';
        color.id = `keyboardSlot${slot}Color`; color.setAttribute('aria-label', `更换按键 ${slot+1} 的颜色`);
        color.onclick = () => changeKeyboardColor(binding).catch(error => toast(error.message));
        actions.append(color);
      }
      const action = document.createElement('button'); action.type = 'button';
      action.id = `keyboardSlot${slot}Binding`; action.textContent = binding ? '取消绑定' : '绑定 Session…';
      action.setAttribute('aria-label', `${binding ? '取消' : '设置'}按键 ${slot+1} 的绑定`);
      action.disabled = !binding && !canBind;
      action.onclick = async () => {
        try {
          if (binding) { sessionKeyboard.unbind(binding.agentId); toast('已取消键盘按键绑定'); }
          else await bindKeyboard({slot});
        } catch (error) { toast(error.message); }
      };
      actions.append(action); el.append(title, detail, actions);
      return el;
    }));
    if (focusedId) $(focusedId)?.focus();
  }
  const sessionKeyboard = new window.SessionKeyboardController({
    onKey:binding=>{
      const agent=state.agents.find(item=>item.agentId===binding.agentId);
      if(!agent)return toast(`按键 ${binding.slot+1} 绑定的 Session 当前不可用`);
      if(state.selectedKind==='agent'&&state.agent?.agentId===agent.agentId)return navigateMobile('agent');
      selectAgent(agent).catch(error=>toast(error.message));
    },
    onStateChange:updateKeyboardUi,
    onBindingsChange:()=>{renderAgentList();renderKeyboardBindings();},
    onError:error=>{console.error('Session keyboard error',error);toast(`键盘：${error.message}`);}
  });
  const formatTokens = value => { const n=Number(value); if(!Number.isFinite(n)||n<=0)return '0'; if(n>=1e6)return `${(n/1e6).toFixed(1)}M`;if(n>=1e3)return `${(n/1e3).toFixed(n>=1e4?0:1)}k`;return String(Math.round(n)); };
  const usageLevel = usage => Number(usage?.percent)>90?'usage-danger':Number(usage?.percent)>70?'usage-warning':'';
  const usageText = usage => { if(!usage||!Number(usage.contextWindow))return 'Context ?';const percent=usage.percent==null?'?':`${Number(usage.percent).toFixed(1)}%`;return `${percent} · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`; };
  const costText = usage => { const cost=Number(usage?.cost);if(!Number.isFinite(cost))return 'Session cost ?';return `Session cost ~$${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`; };
  const sessionUsage = session => ({...(session.contextUsage||{}),cost:session.stats?.cost});
  function renderAgentList() {
    const recent=(value,fallback)=>{const time=Date.parse(value||fallback||'');return Number.isFinite(time)?time:0;};
    let allItems=[...state.agents.map(item=>({kind:'agent',item})),...state.terminals.map(item=>({kind:'terminal',item}))].sort((a,b)=>recent(b.item.lastActiveAt,b.item.createdAt)-recent(a.item.lastActiveAt,a.item.createdAt));
    if(state.backendFilter)allItems=allItems.filter(entry=>entry.item.backendId===state.backendFilter);
    const items=allItems.slice(0,state.agentVisibleCount);
    $('agents').replaceChildren(...items.map(({kind,item}) => {
      const isAgent=kind==='agent',id=isAgent?item.agentId:item.terminalId,selected=state.selectedKind===kind&&(isAgent?state.agent?.agentId:state.terminal?.terminalId)===id;
      const el=document.createElement('div');el.dataset.itemId=id;el.className=`agent ${item.status}${selected?' selected':''}`;
      if(isAgent){const usage=state.contexts.get(item.agentId),binding=sessionKeyboard.getBinding(item.agentId);el.innerHTML=`<div class="agent-top"><b>${esc(agentLabel(item))}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(agentSubtitle(item))}</small><div class="agent-context ${usageLevel(usage)}"><span>Context</span><div class="mini-track"><i style="width:${Math.min(100,Math.max(0,Number(usage?.percent)||0))}%"></i></div><span>${esc(usageText(usage))} · ${esc(costText(usage))}</span></div>`;if(binding){const badge=document.createElement('span');badge.className='key-binding';badge.style.setProperty('--key-color',binding.color);badge.textContent=`K${binding.slot+1}`;badge.title=`键盘按键 ${binding.slot+1} · ${binding.color}`;el.querySelector('.agent-top').append(badge);}}
      else el.innerHTML=`<div class="agent-top"><span class="terminal-kind">&gt;_</span><b>${esc(item.title||'Terminal')}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(item.cwd)}</small>`;
      if(connectedBackends().length>1){const tag=document.createElement('span');tag.className='backend-tag';tag.textContent=item.backendName;tag.title=`来自 backend ${item.backendName}`;el.querySelector('.agent-top').append(tag);}
      el.onclick=()=>isAgent?selectAgent(item):selectTerminal(item);el.oncontextmenu=event=>showItemContextMenu(event,kind,item);return el;
    }));
    $('agentListCount').textContent=`已显示 ${items.length} / ${allItems.length}`;$('loadMoreAgents').hidden=items.length>=allItems.length;$('loadMoreAgents').disabled=items.length>=allItems.length;
  }
  async function loadAgentContexts(agents = state.agents) {
    await Promise.allSettled(agents.map(async agent => {
      const session = await requestAgent(agent.agentId, '/session?summary=true');
      agent.sessionName = session.sessionName || undefined;
      let lastMessageAt = 0;
      for (const entry of session.entries || []) {
        if (entry.type !== 'message') continue;
        const time = Date.parse(entry.timestamp || '');
        if (Number.isFinite(time)) lastMessageAt = Math.max(lastMessageAt, time);
      }
      if (lastMessageAt) agent.lastActiveAt = new Date(lastMessageAt).toISOString();
      state.contexts.set(agent.agentId, sessionUsage(session));
    }));
    renderAgentList();
    if (state.agent) updateAgentHeader();
  }

  function stampNewItem(backendId, item) {
    const backend = backendOf(backendId);
    const idProperty = item.terminalId ? 'terminalId' : 'agentId';
    return backendRegistry.stamp(backend, item, idProperty);
  }

  async function refreshBackendSessions(backend) {
    const [agents, terminals] = await Promise.all([
      requestBackend(backend.id, '/api/v1/agents'),
      requestBackend(backend.id, '/api/v1/terminals'),
    ]);
    if (backend.status !== 'connected') return;
    backend.agents = agents.map(agent => backendRegistry.stamp(backend, agent, 'agentId'));
    backend.terminals = terminals.map(terminal => backendRegistry.stamp(backend, terminal, 'terminalId'));
  }

  function syncSessionLists() {
    state.agents = backendRegistry.resources('agents');
    state.terminals = backendRegistry.resources('terminals');
    if (state.agent) {
      const current = state.agents.find(agent => agent.agentId === state.agent.agentId);
      if (current) Object.assign(state.agent, current);
      else clearAgentSelection(state.agent.backendId);
    }
    if (state.terminal) {
      const current = state.terminals.find(terminal => terminal.terminalId === state.terminal.terminalId);
      if (current) Object.assign(state.terminal, current);
      else clearTerminalSelection(state.terminal.backendId);
    }
    sessionKeyboard.setAgents(state.agents);
    renderAgentList();
    renderKeyboardBindings();
  }

  async function refreshAgents(selectPrevious = false) {
    if (!hasConnection()) return;
    const previousAgentId = state.agent?.agentId || localStorage.rpAgentId;
    const previousTerminalId = state.terminal?.terminalId || localStorage.rpTerminalId;
    await Promise.allSettled(connectedBackends().map(refreshBackendSessions));
    syncSessionLists();

    renderAgentList();
    if (!selectPrevious) return;
    const terminal = state.terminals.find(item => item.terminalId === previousTerminalId);
    const agent = state.agents.find(item => item.agentId === previousAgentId);
    if (localStorage.rpSelectedKind === 'terminal' && terminal) await selectTerminal(terminal, false);
    else if (agent) await selectAgent(agent, false);
  }
  function setAgentStatus(agentId,status) {
    const agent=state.agents.find(x=>x.agentId===agentId);if(!agent){void refreshAgents();return null;}
    // Every event reports the status, so an unchanged one must not rebuild the list for each delta.
    if(agent.status===status)return agent;
    agent.status=status;if(state.agent?.agentId===agentId)state.agent.status=status;sessionKeyboard.updateAgent(agent);renderAgentList();updateAgentHeader();return agent;
  }
  function updateAgentHeader(agent = state.agent) {
    if (!agent) return;
    $('agentTitle').textContent = agentLabel(agent); $('agentStatus').textContent = agentSubtitle(agent);
    const badge=$('agentStateBadge');badge.textContent=agent.status;badge.className=`state-badge state-${agent.status}`;
    const usage=state.contexts.get(agent.agentId),panel=$('contextUsage');panel.hidden=false;$('contextText').textContent=`Context ${usageText(usage)} · ${costText(usage)}`;const percent=Math.min(100,Math.max(0,Number(usage?.percent)||0));$('contextBar').style.width=`${percent}%`;panel.className=`context-usage ${usageLevel(usage)}`;
  }
  function showAgentView(){
    $('agentToolbar').hidden=false;$('terminalToolbar').hidden=true;$('terminalView').hidden=true;$('widgets').hidden=false;$('messages').hidden=false;$('prompt').hidden=false;
  }
  const loadTerminalStyle=()=>new Promise((resolve,reject)=>{
    const id='xterm-styles',loaded=document.getElementById(id);if(loaded?.dataset.loaded==='true')return resolve();
    const link=loaded||document.createElement('link');link.id=id;link.rel='stylesheet';link.href='/vendor/xterm.css';link.onload=()=>{link.dataset.loaded='true';resolve();};link.onerror=()=>{link.remove();reject(Error('无法加载 /vendor/xterm.css'));};if(!loaded)document.head.append(link);
  });
  const loadTerminalScript=(id,src)=>new Promise((resolve,reject)=>{
    const loaded=document.getElementById(id);if(loaded?.dataset.loaded==='true')return resolve();
    const script=loaded||document.createElement('script');script.id=id;script.src=src;script.async=true;script.onload=()=>{script.dataset.loaded='true';resolve();};script.onerror=()=>{script.remove();reject(Error(`无法加载 ${src}`));};if(!loaded)document.head.append(script);
  });
  function loadTerminalAssets(){
    if(window.Terminal&&window.FitAddon?.FitAddon)return Promise.resolve();
    if(!state.terminalAssetsPromise)state.terminalAssetsPromise=(async()=>{
      await Promise.all([loadTerminalStyle(),loadTerminalScript('xterm-script','/vendor/xterm.js')]);
      await loadTerminalScript('xterm-fit-script','/vendor/addon-fit.js');
      if(typeof window.Terminal!=='function'||typeof window.FitAddon?.FitAddon!=='function')throw Error('xterm.js 初始化失败');
    })().catch(error=>{state.terminalAssetsPromise=null;throw error;});
    return state.terminalAssetsPromise;
  }
  async function ensureTerminalEmulator(){
    if(state.terminalEmulator)return state.terminalEmulator;
    await loadTerminalAssets();if(state.terminalEmulator)return state.terminalEmulator;
    const term=new window.Terminal({cursorBlink:true,convertEol:false,fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',fontSize:14,scrollback:5000,theme:{background:'#111111',foreground:'#d8dee9',cursor:'#88c0d0'}}),fit=new window.FitAddon.FitAddon();
    term.loadAddon(fit);term.open($('terminal'));term.onData(data=>{if(state.terminalWs?.readyState===WebSocket.OPEN)state.terminalWs.send(JSON.stringify({type:'input',data}));});
    term.onResize(size=>{if(state.terminalWs?.readyState===WebSocket.OPEN)state.terminalWs.send(JSON.stringify({type:'resize',cols:size.cols,rows:size.rows}));});
    state.resizeObserver=new ResizeObserver(()=>{if(!$('terminalView').hidden)try{fit.fit();}catch{}});state.resizeObserver.observe($('terminalView'));state.terminalEmulator=term;state.fitAddon=fit;return term;
  }
  async function connectTerminalSocket(terminal){
    state.terminalWs?.close();state.terminalWs=null;const terminalId=terminal.terminalId,attempt=++state.terminalConnectAttempt;$('terminalStatus').textContent=`${terminal.cwd} · 正在加载 Terminal…`;
    try{
      const term=await ensureTerminalEmulator();if(attempt!==state.terminalConnectAttempt||state.selectedKind!=='terminal'||state.terminal?.terminalId!==terminalId)return;term.reset();term.clear();$('terminalStatus').textContent=`${terminal.cwd} · 正在连接…`;
      const terminalBackend=backendOf(terminal.backendId);if(!terminalBackend||terminalBackend.status!=='connected')throw Error(`Backend「${terminal.backendName||terminal.backendId}」未连接`);
      const terminalWire=requireWire(terminalBackend);const ws=new WebSocket(terminalWire.prefix.replace(/^http/,'ws')+`/api/v1/terminals/${encodeURIComponent(terminal.remoteId)}/ws`,['access-token.'+terminalWire.token]);state.terminalWs=ws;
      ws.onopen=()=>{if(ws!==state.terminalWs)return;requestAnimationFrame(()=>{try{state.fitAddon.fit();ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));term.focus();}catch{}});};
      ws.onmessage=event=>{if(ws!==state.terminalWs)return;try{const message=JSON.parse(event.data);if(message.type==='snapshot'){term.reset();if(message.data)term.write(message.data);terminal.status=message.record.status;updateTerminalHeader();renderAgentList();}else if(message.type==='output')term.write(message.data);else if(message.type==='exit'){terminal.status='exited';terminal.exitCode=message.exitCode;updateTerminalHeader();renderAgentList();void refreshAgents();}else if(message.type==='error')toast(message.message);}catch(error){console.error(error);}};
      ws.onerror=()=>{};ws.onclose=()=>{if(ws===state.terminalWs&&terminal.status==='running')$('terminalStatus').textContent=`${terminal.cwd} · 连接已断开`;};
    }catch(error){if(attempt===state.terminalConnectAttempt&&state.selectedKind==='terminal'&&state.terminal?.terminalId===terminalId){$('terminalStatus').textContent=`${terminal.cwd} · Terminal 加载失败`;toast(`Terminal 加载失败：${error.message}`);}}
  }
  function updateTerminalHeader(){const terminal=state.terminal;if(!terminal)return;$('terminalTitle').textContent=terminal.title||'Terminal';$('terminalStatus').textContent=`${terminal.cwd}${terminal.exitCode===undefined?'':` · exit ${terminal.exitCode}`}`;const badge=$('terminalStateBadge');badge.textContent=terminal.status;badge.className=`state-badge state-${terminal.status}`;}
  /**
   * Mentions, cwd defaults and "start agent here" all read the selected Workspace, so selecting a
   * session on another Backend must move the file browser with it. Without this the browser keeps
   * pointing at the previous machine and inserts its paths into prompts sent elsewhere.
   *
   * Never await this from a selection: the Workspace is committed synchronously and only the tree
   * load is asynchronous, so waiting for it would let a slow tree restore the older selection.
   */
  async function syncWorkspaceForSelection(item) {
    const backend = backendOf(item.backendId);
    if (!backend || backend.status !== 'connected') return;
    if (ownsPath(state.workspace, item)) return;
    const match = matchWorkspace(backend.workspaces, item.cwd)
      || (state.workspace?.backendId === item.backendId ? state.workspace : backend.workspaces[0]);
    if (!match) { clearWorkspaceSelection(); return; }
    if (state.workspace && workspaceKey(state.workspace) === workspaceKey(match)) return;
    await selectWorkspace(workspaceKey(match));
  }
  async function selectTerminal(terminal,openView=true){
    state.selectedKind='terminal';state.terminal=terminal;localStorage.rpTerminalId=terminal.terminalId;localStorage.rpSelectedKind='terminal';$('agentToolbar').hidden=true;$('terminalToolbar').hidden=false;$('terminalView').hidden=false;$('widgets').hidden=true;$('messages').hidden=true;$('prompt').hidden=true;updateTerminalHeader();renderAgentList();if(openView)navigateMobile('agent');void syncWorkspaceForSelection(terminal);void connectTerminalSocket(terminal);
  }
  const autoBindNewSession=agent=>sessionKeyboard.autoBind(agent.agentId);
  async function startAgent(relativePath) {
    if (!state.workspace) return toast('请先选择 Workspace');
    $('contextMenu').hidden = true;
    try {
      const backendId = state.workspace.backendId;
      const created = await postBackend(backendId, '/api/v1/agents', {workspaceId:state.workspace.id, relativeCwd:relativePath});
      const agent = stampNewItem(backendId, created);
      const binding = autoBindNewSession(agent);
      $('agentCwd').value = relativePath;
      await refreshAgents();
      await selectAgent(agent);
      if (binding) toast(`新 Session 已自动绑定到按键 ${binding.slot+1}`);
    } catch (error) {
      toast(error.message);
    }
  }
  async function openTerminal(relativePath) {
    if (!state.workspace) return toast('请先选择 Workspace');
    try {
      const backend = backendOf(state.workspace.backendId);
      const created = await postBackend(backend.id, '/api/v1/terminals', {workspaceId:state.workspace.id, relativeCwd:relativePath});
      const terminal = backendRegistry.stamp(backend, created, 'terminalId');
      backend.terminals.unshift(terminal);
      syncSessionLists();
      $('contextMenu').hidden = true;
      await selectTerminal(terminal);
    } catch (error) {
      toast(error.message);
    }
  }
  async function closeTerminal(terminal = state.terminal) {
    if (!terminal) return;
    try {
      await requestBackend(terminal.backendId, `/api/v1/terminals/${encodeURIComponent(terminal.remoteId)}`, {method:'DELETE'});
      const backend = backendOf(terminal.backendId);
      if (backend) backend.terminals = backend.terminals.filter(item => item.terminalId !== terminal.terminalId);
      if (state.terminal?.terminalId === terminal.terminalId) clearTerminalSelection(terminal.backendId);
      syncSessionLists();
      toast('Terminal 已关闭');
    } catch (error) {
      toast(error.message);
    }
  }
  async function selectAgent(agent, openView = true) {
    state.selectedKind='agent';state.terminalWs?.close();state.terminalWs=null;state.agent = agent; localStorage.rpAgentId = agent.agentId;localStorage.rpSelectedKind='agent';showAgentView();updateAgentHeader();
    if (openView) navigateMobile('agent');
    void syncWorkspaceForSelection(agent);
    if (ownsPath(state.workspace, agent)) $('agentCwd').value = relativeTo(clean(agent.cwd), clean(state.workspace.rootPath));
    $('messages').replaceChildren(); discardStreams();state.messagePageStart=0;state.messageTotal=0;closeCommandPicker();state.commands=[];state.commandsAgentId=null;renderQueueBar();
    try { await loadMessagePage(agent.agentId,undefined,true); await loadSessionIdentity(); } catch (error) { addCard('加载消息失败', error.message, 'error', true); }
    renderAgentList();
    const backend=backendOf(agent.backendId);
    if(backend)subscribeAgent(backend,agent);
  }
  async function loadSessionIdentity() {
    if (!state.agent) return;
    const session = await requestAgent(state.agent.agentId,'/session?summary=true');
    state.agent.sessionName=session.sessionName||undefined;state.contexts.set(state.agent.agentId,sessionUsage(session));renderAgentList();updateAgentHeader();
  }

  function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking || part.text : part?.type === 'toolCall' ? `${part.name || 'Tool'}\n${JSON.stringify(part.arguments || {}, null, 2)}` : '').filter(Boolean).join('\n');
  }
  // Pi persists failed provider responses as empty assistant messages with
  // stopReason="error" and errorMessage. They have no content to render, so
  // handle the error metadata explicitly instead of silently dropping them.
  function assistantError(message) {
    if(message?.role!=='assistant'||(message.stopReason!=='error'&&!message.errorMessage))return '';
    const detail=String(message.errorMessage||'LLM request failed').trim();
    const source=[message.provider,message.model].filter(Boolean).join(' · ');
    return source?`${detail}\n\n${source}`:detail;
  }
  function renderCardBody(body, content, markdown = false) {
    const value=String(content??'');body.classList.toggle('markdown',markdown);
    if(markdown&&window.marked&&window.DOMPurify){body.innerHTML=DOMPurify.sanitize(marked.parse(value,{gfm:true,breaks:true}));for(const link of body.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}}
    else body.textContent=value;
  }
  // The transcript only shows what a human reads linearly: prompts, answers, thinking, dialogs and errors.
  // Everything else (tool calls, bash output, retries, extension chatter) is folded into one collapsed
  // activity group per stretch of activity, whose summary tracks the most recent item while it streams.
  const TRANSCRIPT_KINDS = new Set(['user','assistant','thinking','dialog','voice','error']);
  function activityGroup(target) {
    const last=target.lastElementChild;
    if (last?.classList?.contains('activity-group')) return last;
    const group=document.createElement('details'); group.className='msg activity-group';
    const summary=document.createElement('summary'),text=document.createElement('span'),count=document.createElement('span'),time=document.createElement('span');
    text.className='summary-text';text.textContent='活动';count.className='activity-count';time.className='event-time';
    summary.append(text,count,time);
    const items=document.createElement('div');items.className='activity-items';
    group.append(summary,items);target.append(group);return group;
  }
  const eventTime = timestamp => {const value=Number(timestamp);return Number.isFinite(value)&&value>0?new Date(value>1e12?value:value*1000).toLocaleTimeString():'';};
  function updateActivityGroup(group, title, timestamp) {
    const count=group.querySelector('.activity-items').childElementCount;
    group.querySelector('.summary-text').textContent=title||'活动';
    group.querySelector('.activity-count').textContent=`${count} 项`;
    const time=eventTime(timestamp);if(time)group.querySelector('.event-time').textContent=time;
  }
  // `grouped` is false for cards that already live inside another card, such as nested tool calls.
  function addCard(title, content, kind = 'system', open = false, timestamp, target = $('messages'), autoScroll = true, grouped = true) {
    const derivedTitle=!title,details=document.createElement('details'); details.className = `msg ${kind}${derivedTitle?' derived-title':''}`; details.open = open;
    const summary=document.createElement('summary'),summaryText=document.createElement('span'),summaryLabel=document.createElement('span');summaryText.className='summary-text';summaryText.textContent=title||String(content).trim()||kind;summaryLabel.className='summary-label';summaryLabel.textContent=kind==='user'?'You':kind==='assistant'?'Assistant':kind;summary.append(summaryText,summaryLabel);
    const time=document.createElement('span'); time.className='event-time'; time.textContent=eventTime(timestamp); summary.append(time);
    const body = document.createElement('div'); body.className = 'msg-content';renderCardBody(body,content,kind==='assistant');
    details.append(summary, body);
    const group=!grouped||TRANSCRIPT_KINDS.has(kind)?null:activityGroup(target);
    (group?group.querySelector('.activity-items'):target).append(details);
    if(group)updateActivityGroup(group,title||kind,timestamp);
    if(autoScroll&&target===$('messages'))$('messages').scrollTop = $('messages').scrollHeight;
    return {details, summary, summaryText, summaryTime:time, body, group, content:String(content??'')};
  }
  /** One card per tool call: `tool_execution_start` opens it, updates stream into it and `tool_execution_end` closes it. */
  function upsertToolCard(ev, timestamp) {
    const key=`tool:${ev.toolCallId||ev.toolName||'tool'}`,existing=state.toolCards.get(key);
    const args=ev.args&&Object.keys(ev.args).length?JSON.stringify(ev.args,null,2):'';
    // Pi 0.99+ runs tools from other tools (codemode scripts, MCP batches). Such calls carry
    // `parentToolCallId`; show them inside the caller instead of as separate activity entries.
    const parent=ev.parentToolCallId?state.toolCards.get(`tool:${ev.parentToolCallId}`):null;
    const newCard=()=>parent?addCard(`🔧 ${ev.toolName||'Tool'}`,args,'tool',false,timestamp,nestedContainer(parent),false,false)
      :addCard(`🔧 ${ev.toolName||'Tool'}`,args,'tool',false,timestamp);
    if (ev.type==='tool_execution_start') {
      // A replayed start can follow a restored pending card for the same call; keep that card so
      // the end event finishes it rather than a duplicate.
      if(existing){existing.summaryTime.textContent=eventTime(timestamp);return existing;}
      const card=newCard();card.toolName=ev.toolName||'Tool';card.args=args;state.toolCards.set(key,card);return card;
    }
    const card=existing||newCard();
    if(!existing){card.toolName=ev.toolName||'Tool';card.args=args;state.toolCards.set(key,card);}
    if (ev.type==='tool_execution_update') {
      const partial=textContent(ev.partialResult?.content??ev.partialResult)||(ev.partialResult?JSON.stringify(ev.partialResult):'');
      if(partial)renderCardBody(card.body,`${card.args}\n\n— 输出 —\n${partial}`);
      card.summaryTime.textContent=eventTime(timestamp);
      if(card.group)updateActivityGroup(card.group,`🔧 ${card.toolName}`,timestamp);
      return card;
    }
    const result=textContent(ev.result?.content??ev.result)||(ev.result&&!ev.result.content?JSON.stringify(ev.result,null,2):'')||(ev.isError?'执行失败':'执行完成');
    card.details.classList.toggle('tool-error',!!ev.isError);
    card.summaryText.textContent=`${ev.isError?'✗':'✓'} ${card.toolName}`;
    setToolDuration(card,ev.durationMs);
    renderCardBody(card.body,`${card.args}\n\n— 结果 —\n${result}`);
    card.summaryTime.textContent=eventTime(timestamp);
    if(card.group)updateActivityGroup(card.group,card.summaryText.textContent,timestamp);
    state.toolCards.delete(key);
    return card;
  }
  /**
   * Nested calls live next to their caller's body, not inside it: the body is replaced whenever the
   * caller streams output or finishes.
   */
  function nestedContainer(card) {
    let box=card.details.querySelector('.nested-tools');
    if(!box){box=document.createElement('div');box.className='nested-tools';card.details.append(box);}
    return box;
  }
  /** Pi 0.99+ reports the recorded execution time of a finished tool call. */
  function setToolDuration(card, durationMs) {
    const value=Number(durationMs);
    if(!Number.isFinite(value)||value<0)return;
    const label=card.durationLabel||(card.durationLabel=Object.assign(document.createElement('span'),{className:'tool-duration'}));
    label.textContent=value<1000?`${Math.round(value)} ms`:value<60000?`${(value/1000).toFixed(1)} s`:`${Math.floor(value/60000)} 分 ${Math.round(value%60000/1000)} 秒`;
    card.summaryTime.before(label);
  }
  /** A tool call that has no toolResult yet: the only visible sign that a long tool is still running. */
  function addPendingToolCard(call, timestamp, target) {
    const name=call.name||'Tool',args=call.arguments&&Object.keys(call.arguments).length?JSON.stringify(call.arguments,null,2):'';
    const card=addCard(`⏳ ${name} · 执行中`,args,'tool',false,timestamp,target,false);
    card.toolName=name;card.args=args;
    // Keyed like upsertToolCard so the live tool_execution_update/end event finishes this very card.
    if(call.id)state.toolCards.set(`tool:${call.id}`,card);
    return card;
  }
  /** Session bash emits start, optional output deltas, and one completion event. */
  function updateBashCard(ev, timestamp) {
    const key=`bash:${ev.id||'default'}`;let card=state.toolCards.get(key);
    if(!card){card=addCard(ev.command?`$ ${ev.command}`:'$ bash','','tool',false,timestamp);card.content='';state.toolCards.set(key,card);}
    if(ev.type==='bash_execution_update')card.content+=String(ev.delta||'');
    else if(ev.type==='bash_execution_end') {
      card.content=String(ev.output??card.content);const failed=!!ev.isError||ev.cancelled||Number(ev.exitCode)>0;
      const status=ev.isError?ev.errorMessage:ev.cancelled?'已取消':ev.exitCode===undefined?'完成':`exit ${ev.exitCode}${ev.truncated?' · 输出已截断':''}`;
      card.details.classList.toggle('tool-error',failed);card.summaryText.textContent=`${failed?'✗':'✓'} ${ev.command?`$ ${ev.command}`:'bash'} · ${status}`;state.toolCards.delete(key);
    }
    renderCardBody(card.body,card.content);card.summaryTime.textContent=eventTime(timestamp);
    if(card.group)updateActivityGroup(card.group,card.summaryText.textContent,timestamp);
  }
  // `pending` is only safe for the newest page: an older page can end mid tool call whose result
  // lives in the next page, and that call is not actually running.
  function renderMessages(messages, target = $('messages'), showEmpty = true, pending = false) {
    if (!messages?.length) { if(showEmpty&&target===$('messages'))$('messages').innerHTML = '<div class="empty">尚无消息</div>'; return; }
    const resolved = pending ? new Set(messages.filter(m=>m?.role==='toolResult'&&m.toolCallId).map(m=>m.toolCallId)) : null;
    for (const message of messages) {
      const role=message.role||'event',timestamp=message.timestamp;
      if(role==='bashExecution'){
        const failed=message.cancelled||Number(message.exitCode)>0,status=message.cancelled?'已取消':message.exitCode===undefined?'完成':`exit ${message.exitCode}${message.truncated?' · 输出已截断':''}`;
        const card=addCard(`${failed?'✗':'✓'} $ ${message.command} · ${status}`,message.output||'','tool',false,timestamp,target,false);card.details.classList.toggle('tool-error',!!failed);
      } else if (Array.isArray(message.content) && role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) addCard(null,part.text,'assistant',false,timestamp,target,false);
          else if (part.type === 'thinking' && (part.thinking||part.text)) addCard('Thinking',part.thinking||part.text,'thinking',false,timestamp,target,false);
          // Completed historical tools are represented by their toolResult message below; only a tool
          // call still waiting for its result needs a card of its own.
          else if (part.type === 'toolCall' && resolved && !resolved.has(part.id)) addPendingToolCard(part,timestamp,target);
        }
        const error=assistantError(message);if(error)addCard('LLM Error',error,'error',true,timestamp,target,false);
      } else if(role==='toolResult'){
        const failed=!!message.isError,content=textContent(message.content)||(failed?'执行失败':'执行完成');
        const card=addCard(`${failed?'✗':'✓'} ${message.toolName||'Tool'}`,content,'tool',false,timestamp,target,false);card.details.classList.toggle('tool-error',failed);setToolDuration(card,message.durationMs);
      } else { const content=textContent(message.content);if(content)addCard(['user','assistant'].includes(role)?null:role,content,role==='user'?'user':role==='assistant'?'assistant':'system',false,timestamp,target,false); }
    }
    if(target===$('messages'))$('messages').scrollTop=$('messages').scrollHeight;
  }
  function updateMessageHistoryControl() {
    $('messageHistoryControls')?.remove();if(state.messagePageStart<=0)return;
    const controls=document.createElement('div');controls.id='messageHistoryControls';controls.className='message-history-controls';
    const older=document.createElement('button');older.id='loadOlderMessages';older.type='button';older.textContent=`加载更早的对话（还有 ${state.messagePageStart} 条）`;older.onclick=()=>state.agent&&loadMessagePage(state.agent.agentId,state.messagePageStart,false).catch(error=>toast(error.message));
    const all=document.createElement('button');all.id='loadAllMessages';all.type='button';all.textContent='加载全部对话';all.onclick=()=>state.agent&&loadAllMessages(state.agent.agentId,all).catch(error=>toast(error.message));controls.append(older,all);$('messages').prepend(controls);
  }
  async function loadAllMessages(agentId,button) {
    button.disabled=true;button.textContent='正在加载全部对话…';
    try { const messages=await requestAgent(agentId,'/messages');if(state.agent?.agentId!==agentId)return;const box=$('messages');box.replaceChildren();state.toolCards.clear();renderMessages(messages,box,true,true);state.messagePageStart=0;state.messageTotal=messages.length;updateMessageHistoryControl(); }
    finally { button.disabled=false;button.textContent='加载全部对话'; }
  }
  async function loadMessagePage(agentId,before,reset) {
    const query=new URLSearchParams({limit:String(state.messagePageSize)});if(before!==undefined)query.set('before',String(before));
    const page=await requestAgent(agentId,`/messages?${query}`);if(state.agent?.agentId!==agentId)return;
    const box=$('messages'),oldHeight=box.scrollHeight,oldTop=box.scrollTop,fragment=document.createDocumentFragment();
    if(reset)state.toolCards.clear();renderMessages(page.items,fragment,false,!!reset);
    if(reset){box.replaceChildren(fragment);state.messageTotal=page.total;}else{box.querySelector('#messageHistoryControls')?.remove();box.prepend(fragment);}
    state.messagePageStart=page.start;state.messageTotal=page.total;updateMessageHistoryControl();
    if(reset)box.scrollTop=box.scrollHeight;else box.scrollTop=oldTop+(box.scrollHeight-oldHeight);
    if(!page.total)box.innerHTML='<div class="empty">尚无消息</div>';
  }
  function ensureStream(key, title, kind) {
    if (!state.streams.has(key)) { const card=addCard(title,'',kind,true);card.kind=kind;card.renderFrame=null;state.streams.set(key,card); }
    return state.streams.get(key);
  }
  // Parsing and sanitizing the complete accumulated Markdown for every tiny
  // provider delta is O(n²) and can leave the browser minutes behind the agent.
  // Paint plain text at most once per animation frame and parse Markdown once
  // when the message finishes.
  function paintStream(card) {
    card.renderFrame=null;card.body.textContent=card.content;card.summaryText.textContent=(card.content.trim().split('\n')[0]||card.kind||'Assistant').slice(0,160);
    $('messages').scrollTop=$('messages').scrollHeight;
  }
  function scheduleStreamPaint(card) { if(card.renderFrame===null)card.renderFrame=requestAnimationFrame(()=>paintStream(card)); }
  function finalizeAgentStreams() {
    for(const key of ['assistant','thinking']){const card=state.streams.get(key);if(!card)continue;if(card.renderFrame!==null){cancelAnimationFrame(card.renderFrame);card.renderFrame=null;}renderCardBody(card.body,card.content,key==='assistant');card.summaryText.textContent=(card.content.trim().split('\n')[0]||key).slice(0,160);state.streams.delete(key);}
  }
  function discardStreams() { for(const card of state.streams.values())if(card.renderFrame!==null&&card.renderFrame!==undefined)cancelAnimationFrame(card.renderFrame);state.streams.clear();state.toolCards.clear(); }
  function extensionRequest(agentId, ev, timestamp) {
    if ($(`extension-request-${ev.requestId}`)) return;
    $('messages').querySelector('.empty')?.remove();
    const card = addCard(ev.title || `Extension ${ev.kind}`, ev.message || ev.placeholder || ev.prefill || '', 'dialog', true, timestamp);
    const controls = document.createElement('div'); controls.className = 'dialog-actions'; controls.id = `extension-request-${ev.requestId}`;
    const send = async value => { try { await postAgent(agentId,'/extension-response',{requestId:ev.requestId, value}); controls.replaceChildren(document.createTextNode('已响应')); } catch (e) { toast(e.message); } };
    if (ev.kind === 'select') for (const option of ev.options || []) { const b = document.createElement('button'); b.textContent = option; b.onclick = () => send(option); controls.append(b); }
    else if (ev.kind === 'confirm') { for (const [label, value] of [['否',false],['是',true]]) { const b=document.createElement('button');b.textContent=label;b.onclick=()=>send(value);controls.append(b); } }
    else { const input = ev.kind === 'editor' ? document.createElement('textarea') : document.createElement('input'); input.value = ev.prefill || ''; input.placeholder = ev.placeholder || ''; const b = document.createElement('button'); b.textContent = '提交'; b.onclick = () => send(input.value); controls.append(input,b); }
    card.body.append(controls);
  }
  /** Steering and follow-up messages Pi has queued for the running turn. */
  function setAgentQueue(agentId, queue) {
    const value={steering:queue?.steering||[], followUp:queue?.followUp||[]};
    if(value.steering.length||value.followUp.length)state.queues.set(agentId,value); else state.queues.delete(agentId);
    if(state.selectedKind==='agent'&&state.agent?.agentId===agentId)renderQueueBar();
  }
  function renderQueueBar() {
    const queue=state.agent?state.queues.get(state.agent.agentId):null,bar=$('queueBar');
    if(!queue){bar.hidden=true;return;}
    const parts=[];
    if(queue.steering.length)parts.push(`Steer ${queue.steering.length}`);
    if(queue.followUp.length)parts.push(`Follow-up ${queue.followUp.length}`);
    const preview=[...queue.steering,...queue.followUp][0]||'';
    $('queueText').textContent=`排队中：${parts.join(' · ')}${preview?` — ${preview.replace(/\s+/g,' ').slice(0,60)}`:''}`;
    bar.hidden=false;
  }
  function restoreExtensionRequests(agentId, activity) {
    if (state.selectedKind !== 'agent' || state.agent?.agentId !== agentId || !activity?.dialogRequests) return;
    const requests = activity.dialogRequests, ids = new Set(requests.map(request => `extension-request-${request.requestId}`));
    for (const controls of $('messages').querySelectorAll('.dialog-actions')) {
      if (!ids.has(controls.id)) controls.replaceChildren(document.createTextNode('已结束'));
    }
    for (const request of requests) extensionRequest(agentId, request);
  }
  function stopVoiceAudio() {
    state.voiceAudio.generation++;for(const source of state.voiceAudio.sources){try{source.stop();}catch{}}state.voiceAudio.sources.clear();state.voiceAudio.nextTime=0;state.voiceAudio.playbackId=null;state.voiceAudio.backendId=null;
  }
  async function ensureAudioContext() {
    const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw Error('当前浏览器不支持音频播放');
    state.voiceAudio.context??=new AudioContext();if(state.voiceAudio.context.state==='suspended')await state.voiceAudio.context.resume();return state.voiceAudio.context;
  }
  function playVoiceChunk(event, backendId) {
    if(!state.voicePlaybackEnabled||!event.audio)return;const generation=state.voiceAudio.generation;
    state.voiceAudio.decodeChain=state.voiceAudio.decodeChain.then(async()=>{
      const context=await ensureAudioContext();if(generation!==state.voiceAudio.generation)return;state.voiceAudio.playbackId=event.playbackId;state.voiceAudio.backendId=backendId;
      const raw=atob(event.audio),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));let buffer;
      if(event.encoding==='mp3')buffer=await context.decodeAudioData(bytes.buffer.slice(0));
      else{const samples=new Float32Array(Math.floor(bytes.length/2));for(let i=0;i<samples.length;i++){let value=bytes[i*2]|(bytes[i*2+1]<<8);if(value&0x8000)value-=0x10000;samples[i]=value/32768;}const rate=Number(event.sampleRate||24000);buffer=context.createBuffer(1,samples.length,rate);buffer.copyToChannel(samples,0);}
      if(generation!==state.voiceAudio.generation||state.voiceAudio.playbackId!==event.playbackId)return;const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);const start=Math.max(context.currentTime+0.03,state.voiceAudio.nextTime||0);source.start(start);state.voiceAudio.nextTime=start+buffer.duration;state.voiceAudio.sources.add(source);source.onended=()=>state.voiceAudio.sources.delete(source);
    }).catch(error=>toast(`语音播放失败：${error.message}`));
  }
  function handleVoiceEvent(message) {
    const ev=message.event||{},selected=state.selectedKind==='agent'&&state.agent?.agentId===message.agentId,key=`voice-${resourceKey(message.backendId,ev.playbackId||message.agentId)}`;
    if(ev.type==='voice_start'){if(state.voicePlaybackEnabled)void ensureAudioContext().catch(()=>{});if(selected){const c=ensureStream(key,'语音摘要','voice');c.content='';renderCardBody(c.body,'正在生成语音摘要…',false);}}
    else if(ev.type==='voice_summary_delta'){if(selected){const c=ensureStream(key,'语音摘要','voice');c.content+=ev.text||'';renderCardBody(c.body,c.content,false);c.summaryText.textContent='语音摘要';}}
    else if(ev.type==='voice_audio_chunk')playVoiceChunk({...ev,playbackId:resourceKey(message.backendId,ev.playbackId)},message.backendId);
    else if(ev.type==='voice_cancelled'){stopVoiceAudio();}
    else if(ev.type==='voice_error'){if(selected)addCard('语音服务',ev.message||'语音生成失败','error',true);}
    else if(ev.type==='voice_end'){if(selected)state.streams.delete(key);}
  }
  function updateVoiceButton(){const button=$('voicePlayback');button.textContent=state.voicePlaybackEnabled?'语音已启用':'启用语音';button.title=state.voicePlaybackEnabled?'点击关闭 Agent 语音摘要':'点击启用 Agent 语音摘要播放';}
  async function toggleVoicePlayback(){state.voicePlaybackEnabled=!state.voicePlaybackEnabled;localStorage.rpVoicePlayback=String(state.voicePlaybackEnabled);updateVoiceButton();if(state.voicePlaybackEnabled){try{await ensureAudioContext();toast('Agent 完成后将播放语音摘要');}catch(error){state.voicePlaybackEnabled=false;localStorage.rpVoicePlayback='false';updateVoiceButton();toast(error.message);}}else stopVoiceAudio();}
  async function toggleVoiceInput(){
    if(!state.voiceSttEnabled)return toast('服务端未启用语音识别');if(!state.agent)return toast('请先选择 Agent');
    if(state.mediaRecorder&&state.mediaRecorder.state==='recording'){state.mediaRecorder.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return toast('当前浏览器不支持麦克风录音');
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true}),preferred=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));state.mediaStream=stream;state.mediaChunks=[];state.mediaRecorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined);
      state.mediaRecorder.ondataavailable=event=>{if(event.data.size)state.mediaChunks.push(event.data)};
      state.mediaAgentId=state.agent.agentId;state.mediaRecorder.onstop=()=>void transcribeVoice();state.mediaRecorder.start(250);$('voiceInput').textContent='■';$('voiceInput').title='停止并识别';$('voiceInput').classList.add('recording');state.mediaTimer=setTimeout(()=>state.mediaRecorder?.state==='recording'&&state.mediaRecorder.stop(),60000);
    }catch(error){toast(`无法录音：${error.message}`);}
  }
  async function transcribeVoice(){
    clearTimeout(state.mediaTimer);const recorder=state.mediaRecorder,mime=recorder?.mimeType||'audio/webm',blob=new Blob(state.mediaChunks,{type:mime}),agentId=state.mediaAgentId;state.mediaStream?.getTracks().forEach(track=>track.stop());state.mediaRecorder=null;state.mediaStream=null;state.mediaChunks=[];state.mediaAgentId=null;$('voiceInput').textContent='…';$('voiceInput').classList.remove('recording');
    if(!agentId){$('voiceInput').textContent='🎙';return;}const {backendId,remoteId}=splitResourceKey(agentId),transcribeBackend=backendOf(backendId);if(!transcribeBackend){$('voiceInput').textContent='🎙';return toast('该 Session 的 backend 已断开');}try{const transcribeWire=requireWire(transcribeBackend);const response=await fetch(transcribeWire.prefix+`/api/v1/agents/${encodeURIComponent(remoteId)}/transcribe`,{method:'POST',headers:{Authorization:`Bearer ${transcribeWire.token}`,'Content-Type':mime,'X-Audio-Filename':mime.includes('mp4')?'recording.m4a':'recording.webm'},body:blob});const body=await response.json().catch(()=>({}));if(!response.ok)throw Error(body.error?.message||`HTTP ${response.status}`);const text=body.data?.text?.trim();if(text){const input=$('input'),prefix=input.value&& !/\s$/.test(input.value)?' ':'';input.value+=prefix+text;input.focus();toast('语音已转换为文字');}else toast('没有识别到语音');}catch(error){toast(`语音识别失败：${error.message}`);}finally{$('voiceInput').textContent='🎙';$('voiceInput').title='开始语音输入';}
  }
  function handleAgentEvent(message) {
    if(message.type==='voice_event'){handleVoiceEvent(message);return;}
    if (message.type === 'subscribed') {
      const key = `rpSeq:${message.agentId}`, saved = Number(localStorage[key] || 0), current = Number(message.currentSequence || 0);
      // Agent event sequences restart when the server restores an Agent. A cursor
      // from the previous process must not cause every new event to be discarded.
      if (saved > current) localStorage[key] = current;
      return;
    }
    if (message.type === 'agent_state') {
      const key = `rpSeq:${message.agentId}`, last = Number(localStorage[key] || 0);
      if (message.sequence < last) return;
      localStorage[key] = message.sequence;
      // This baseline follows replay. Keep recovered tool/LLM details while
      // replacing standalone operation IDs, without touching the transcript.
      sessionKeyboard.updateAgent({...message.state, agentId:message.agentId});
      setAgentStatus(message.agentId, message.state.status);
      setAgentQueue(message.agentId, message.state.activity?.queue);
      restoreExtensionRequests(message.agentId, message.state.activity);
      return;
    }
    if (message.type === 'agent_snapshot') {
      localStorage[`rpSeq:${message.agentId}`] = message.lastSequence;
      if (message.state) {
        sessionKeyboard.setAgentSnapshot({...message.state, agentId:message.agentId});
        setAgentStatus(message.agentId, message.state.status);
        setAgentQueue(message.agentId, message.state.activity?.queue);
      }
      if (state.agent?.agentId === message.agentId) {
        discardStreams(); $('messages').replaceChildren(); renderMessages(message.messages,$('messages'),true,true);
        state.messagePageStart = message.messagePage?.start || 0;
        state.messageTotal = message.messagePage?.total ?? message.messages?.length ?? 0;
        updateMessageHistoryControl();
        restoreExtensionRequests(message.agentId, message.state?.activity);
      }
      return;
    }
    if (message.type !== 'agent_event') return;
    const key = `rpSeq:${message.agentId}`, last = Number(localStorage[key] || 0); if (message.sequence <= last) return; localStorage[key] = message.sequence;
    const ev = message.event || {}, selected = state.selectedKind==='agent'&&state.agent?.agentId === message.agentId;
    sessionKeyboard.handleAgentEvent(message.agentId, ev);
    let eventAgent=state.agents.find(x=>x.agentId===message.agentId);
    if(eventAgent&&Number(message.timestamp)>0)eventAgent.lastActiveAt=new Date(Number(message.timestamp)*1000).toISOString();
    // The server sends the authoritative status with every event, including dialog waits. Backends
    // older than this field still report their lifecycle events, so those stand in for it.
    const liveStatus=message.status||(ev.type==='agent_start'||ev.type==='auto_retry_start'?'streaming':ev.type==='agent_end'?(ev.willRetry?'streaming':'idle'):ev.type==='agent_settled'?'idle':null);
    if (liveStatus) eventAgent=setAgentStatus(message.agentId, liveStatus)||eventAgent;
    if (ev.type === 'queue_update') { setAgentQueue(message.agentId, ev); return; }
    if (ev.type === 'agent_unloaded') {
      setAgentStatus(message.agentId, 'unloaded');
      setAgentQueue(message.agentId, null);
      restoreExtensionRequests(message.agentId, {dialogRequests:[]});
      return;
    }
    if (ev.type === 'agent_end') {
      if(!ev.willRetry){if(selected)finalizeAgentStreams();notifyComplete(eventAgent||{agentId:message.agentId},message.timestamp);if(eventAgent)void loadAgentContexts([eventAgent]);}
    } else if (ev.type === 'agent_settled') { if(eventAgent)void loadAgentContexts([eventAgent]); }
    else if (ev.type === 'session_info_changed') { if(eventAgent)eventAgent.sessionName=ev.name||undefined;if(selected)state.agent.sessionName=ev.name||undefined;renderAgentList();if(selected)updateAgentHeader(); }
    if (!selected) return;
    if (ev.type === 'agent_start') { $('messages').querySelector('.empty')?.remove(); }
    else if (ev.type === 'message_update') {
      const update = ev.assistantMessageEvent || {};
      if (update.type === 'text_delta') { const c=ensureStream('assistant',null,'assistant');c.content+=update.delta||'';scheduleStreamPaint(c); }
      else if (update.type === 'thinking_delta') {const c=ensureStream('thinking','Thinking','thinking');c.content+=update.delta||'';scheduleStreamPaint(c);}
    } else if (ev.type === 'message_end') {finalizeAgentStreams();const error=assistantError(ev.message);if(error)addCard('LLM Error',error,'error',true,message.timestamp);}
    else if (ev.type === 'tool_execution_start' || ev.type === 'tool_execution_update' || ev.type === 'tool_execution_end') upsertToolCard(ev, message.timestamp);
    else if (ev.type === 'bash_execution_start' || ev.type === 'bash_execution_update' || ev.type === 'bash_execution_end') updateBashCard(ev, message.timestamp);
    else if (ev.type === 'auto_retry_start' || ev.type === 'auto_retry_end') addCard('Retry', ev.errorMessage || ev.finalError || `${ev.type}${ev.attempt?` · attempt ${ev.attempt}`:''}`, 'system', false, message.timestamp);
    else if (String(ev.type).startsWith('summarization_retry')) addCard('Summarization Retry', ev.errorMessage || `${ev.type}${ev.attempt?` · ${ev.attempt}/${ev.maxAttempts}`:''}`, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_request') extensionRequest(message.agentId, ev, message.timestamp);
    else if (ev.type === 'extension_ui_response') $(`extension-request-${ev.requestId}`)?.replaceChildren(document.createTextNode('已结束'));
    else if (ev.type === 'extension_ui_notify') addCard(ev.notificationType || '通知', ev.message, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_status') { ev.text ? state.extensionStatus.set(ev.key, ev.text) : state.extensionStatus.delete(ev.key); renderExtensionStatus(); }
    else if (ev.type === 'extension_ui_widget') { ev.content ? state.widgets.set(ev.key, ev.content) : state.widgets.delete(ev.key); renderWidgets(); }
    else if (ev.type === 'extension_ui_title') { state.agent.sessionName = ev.title; updateAgentHeader(); }
    else if (ev.type === 'extension_ui_working_message') { ev.message ? state.extensionStatus.set('working',ev.message) : state.extensionStatus.delete('working'); renderExtensionStatus(); }
    else if (!['message_start','agent_end','agent_settled','session_info_changed','turn_start','turn_end','model_select','thinking_level_select','thinking_level_changed'].includes(ev.type)) addCard(ev.title || ev.type || 'Event', JSON.stringify(ev, null, 2), 'system', false, message.timestamp);
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  function renderExtensionStatus() { let row=$('extensionStatus'); if (!state.extensionStatus.size) { row?.remove(); return; } if(!row){row=document.createElement('div');row.id='extensionStatus';row.className='status-row';$('widgets').after(row);} row.textContent=[...state.extensionStatus.values()].join(' · '); }
  function renderWidgets() { $('widgets').replaceChildren(...[...state.widgets.entries()].map(([key,value])=>{const el=document.createElement('div');el.className='widget';el.dataset.key=key;el.textContent=Array.isArray(value)?value.map(x=>typeof x==='string'?x:x.text||'').join('\n'):String(value);return el;})); }

  function subscribeAgent(backend, agent) {
    if (backend.ws?.readyState !== WebSocket.OPEN) return;
    const key = `rpSeq:${agent.agentId}`, cursor = localStorage[key];
    backend.ws.send(JSON.stringify(cursor === undefined ? {type:'subscribe', agentId:agent.remoteId, fromNow:true, messageLimit:state.messagePageSize} : {type:'subscribe', agentId:agent.remoteId, lastSequence:Number(cursor), messageLimit:state.messagePageSize}));
  }
  function connectSocket(backend) {
    if (!backend || backend.status !== 'connected') return;
    clearTimeout(backend.reconnectTimer); backend.manuallyClosed = true; const previous = backend.ws; backend.ws = null; previous?.close(); backend.manuallyClosed = false;
    const wire = wireOf(backend);
    if (!wire) return;
    const ws = new WebSocket(wire.prefix.replace(/^http/, 'ws') + '/api/v1/ws', ['access-token.' + wire.token]); backend.ws = ws;
    ws.onopen = () => { if (ws !== backend.ws) return; backend.reconnectAttempt = 0; backend.reconnecting = false; updateHeaderStatus(); for (const agent of backend.agents) subscribeAgent(backend, agent); ws.send(JSON.stringify({type:'subscribe_all', fromNow:true})); };
    ws.onmessage = event => { if (ws !== backend.ws) return; try { const message = JSON.parse(event.data); if (typeof message.agentId === 'string') message.agentId = resourceKey(backend.id, message.agentId); message.backendId = backend.id; handleAgentEvent(message); } catch (error) { console.error(error); } };
    ws.onclose = () => { if (backend.ws !== ws || backend.manuallyClosed) return; backend.reconnecting = true; updateHeaderStatus(); const delays=[1000,2000,4000,8000,15000,30000], delay=delays[Math.min(backend.reconnectAttempt++, delays.length-1)]; backend.reconnectTimer = setTimeout(() => connectSocket(backend), delay); };
    ws.onerror = () => {};
  }
  function notificationUnavailableReason() {
    if (!window.isSecureContext) return '浏览器通知需要 HTTPS；仅 localhost 可使用 HTTP';
    if (!('Notification' in window) || typeof Notification.requestPermission !== 'function') return '当前浏览器不支持系统通知';
    return '';
  }
  function updateNotificationButton() {
    const button=$('notifications'),status=$('browserNotificationStatus'),unavailable=notificationUnavailableReason();
    // Keep the button clickable so unsupported/denied states can explain how to
    // fix the problem instead of silently ignoring the user's click.
    button.disabled=false;
    if (unavailable) { button.textContent='通知不可用'; button.title=unavailable;status.textContent=unavailable; return; }
    button.textContent=Notification.permission==='granted'?'通知已启用':Notification.permission==='denied'?'通知已禁用':'启用通知';
    button.title=Notification.permission==='denied'?'通知权限已被浏览器阻止，点击查看处理方式':'启用所有 Agent 的完成通知';status.textContent=Notification.permission==='granted'?'Agent 完成后会显示浏览器系统通知。':Notification.permission==='denied'?'通知权限已被浏览器阻止。':'尚未授予浏览器通知权限。';
  }
  async function enableNotifications() {
    const unavailable=notificationUnavailableReason();
    if (unavailable) return toast(unavailable);
    if (Notification.permission==='denied') return toast('通知权限已被阻止，请在地址栏的网站权限中允许通知后刷新页面');
    try {
      const permission=await Notification.requestPermission(); updateNotificationButton();
      toast(permission==='granted'?'已启用所有 Agent 的完成通知':'未获得通知权限，请在浏览器的网站权限中开启');
    } catch (error) {
      console.error('Unable to request notification permission',error);
      toast(`无法请求通知权限：${error?.message||'请检查浏览器的网站权限'}`);
    }
  }
  function notifyComplete(agent, timestamp) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const occurredAt=Number(timestamp)||Math.floor(Date.now()/1000);
    try { new Notification('Agent 完成', {body:`${agentLabel(agent)} 已转为空闲\n本地时间：${new Date(occurredAt*1000).toLocaleString()}\nUnix 时间戳：${occurredAt}`, timestamp:occurredAt*1000, tag:`remote-pi-${agent.agentId}-${occurredAt}`}); } catch (error) { console.error('Unable to show notification',error); }
  }
  async function loadPrimaryMailSettings() {
    const requestNumber = ++state.mailRequest;
    const backend = primaryBackend();
    state.mailBackendId = null;
    state.mailNotificationsAvailable = false;
    updateMailControls();
    if (!backend) return;

    if (backend.statusInfo?.mailNotificationsConfigured === false) {
      state.mailBackendId = backend.id;
      updateMailControls();
      return;
    }

    try {
      const result = await requestBackend(backend.id, '/api/v1/mail-notifications');
      if (requestNumber !== state.mailRequest || primaryBackend()?.id !== backend.id) return;
      state.mailBackendId = backend.id;
      state.mailNotificationsAvailable = Boolean(result.available);
      if (result.settings) state.mailSettings = {...state.mailSettings, ...result.settings};
    } catch (error) {
      if (requestNumber !== state.mailRequest) return;
      console.error('Unable to load mail notification settings', error);
    }
    updateMailControls();
  }

  function updateMailControls() {
    const backend = backendOf(state.mailBackendId);
    const ownsForm = backend?.status === 'connected' && primaryBackend()?.id === backend.id;
    const available = ownsForm && state.mailNotificationsAvailable;
    const settings = state.mailSettings;
    $('mailNotificationEnabled').checked = Boolean(settings.enabled);
    $('mailAggregationDelay').value = String(settings.aggregationDelaySeconds ?? 0);
    $('mailIncludeResponse').checked = Boolean(settings.includeResponse);
    $('mailIncludeSessionDetails').checked = Boolean(settings.includeSessionDetails);
    $('mailCollabEscalations').checked = Boolean(settings.collabEscalations);
    for (const id of ['mailNotificationEnabled','mailAggregationDelay','mailIncludeResponse','mailIncludeSessionDetails','mailCollabEscalations','configSave']) {
      $(id).disabled = !available;
    }
    $('mailNotificationAvailability').textContent = !hasConnection()
      ? '连接服务后可以配置邮件通知。'
      : !ownsForm
        ? '正在读取主 Backend 的邮件通知设置…'
        : available
          ? `MailDispatch 已在「${backend.name}」配置。设置对该 Backend 的所有 Agent 和客户端生效。`
          : `Backend「${backend.name}」未配置 MailDispatch endpoint、API key 和通知邮箱。`;
  }

  function updateConfigUi() {
    const connected = connectedBackends().length;
    $('configConnectionStatus').textContent = connected ? `已连接 ${connected} 个 backend` : '当前未配对';
    $('disconnectAll').hidden = !connected;
    updateNotificationButton();
    updateVoiceButton();
    updateMailControls();
    renderBackendList();
  }

  function openConfig() {
    updateConfigUi();
    renderKeyboardBindings();
    if (!$('configDialog').open) $('configDialog').showModal();
  }

  async function saveMailSettings() {
    if (!requireConnection()) return;
    const backend = backendOf(state.mailBackendId);
    if (!backend || primaryBackend()?.id !== backend.id) return toast('主 Backend 已变化，请等待邮件设置重新加载');
    if (!state.mailNotificationsAvailable) return toast('服务端未配置 MailDispatch');
    const delay = Number($('mailAggregationDelay').value);
    if (!Number.isInteger(delay) || delay < 0 || delay > 86400) return toast('聚合时间必须是 0 到 86400 之间的整数秒');
    $('configSave').disabled = true;
    try {
      const result = await postBackend(backend.id, '/api/v1/mail-notifications', {
        enabled: $('mailNotificationEnabled').checked,
        aggregationDelaySeconds: delay,
        includeResponse: $('mailIncludeResponse').checked,
        includeSessionDetails: $('mailIncludeSessionDetails').checked,
        collabEscalations: $('mailCollabEscalations').checked,
      });
      if (primaryBackend()?.id !== backend.id || state.mailBackendId !== backend.id) return;
      state.mailSettings = result.settings;
      updateMailControls();
      toast('邮件通知设置已保存');
    } catch (error) {
      toast(error.message);
    } finally {
      updateMailControls();
    }
  }

  function modal(title, build, okText = '确定') {
    const dialog=$('modal'), body=$('modalBody'); $('modalTitle').textContent=title; $('modalOk').textContent=okText; body.replaceChildren(); const value=build(body);
    return new Promise(resolve => { const done=()=>{dialog.removeEventListener('close',done);resolve(dialog.returnValue==='default'?(typeof value==='function'?value():value):null);};dialog.addEventListener('close',done);dialog.showModal(); });
  }
  const field = (body, label, value='', type='text') => { const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.type=type;input.value=value;l.append(input);body.append(l);return input; };
  let agentContextTarget=null;
  function showItemContextMenu(event,kind,item){event.preventDefault();event.stopPropagation();agentContextTarget={kind,item};const archive=$('menuArchiveAgent'),active=kind==='agent'&&['starting','streaming','waiting_for_user','stopping'].includes(item.status),binding=kind==='agent'&&sessionKeyboard.getBinding(item.agentId);archive.hidden=kind!=='agent';archive.disabled=active;archive.title=active?'Agent 执行期间不能 Archive':'';$('menuBindKeyboard').hidden=kind!=='agent'||!!binding;$('menuBindKeyboard').disabled=!binding&&sessionKeyboard.getBindings().length>=6;$('menuBindKeyboard').title=$('menuBindKeyboard').disabled?'六个按键均已绑定':'';$('menuKeyboardColor').hidden=kind!=='agent'||!binding;$('menuUnbindKeyboard').hidden=kind!=='agent'||!binding;$('menuCloseTerminal').hidden=kind!=='terminal';const menu=$('agentContextMenu');menu.hidden=false;menu.style.left=`${Math.min(event.clientX,innerWidth-210)}px`;menu.style.top=`${Math.min(event.clientY,innerHeight-190)}px`;}
  async function bindKeyboard({agentId, slot} = {}) {
    const free = sessionKeyboard.getFreeSlots();
    const agents = state.agents.filter(agent => !sessionKeyboard.getBinding(agent.agentId));
    if (!free.length) return toast('六个键盘按键均已绑定');
    if (!agents.length) return toast('没有可绑定的 Session');
    const result = await modal('绑定键盘按键', body => {
      const sessionLabel = document.createElement('label'); sessionLabel.textContent = 'Session';
      const sessions = document.createElement('select');
      for (const agent of agents) {
        const option = document.createElement('option'); option.value = agent.agentId;
        option.textContent = connectedBackends().length > 1 ? `${agent.backendName} · ${agentLabel(agent)}` : agentLabel(agent); option.selected = agent.agentId === agentId;
        sessions.append(option);
      }
      sessionLabel.append(sessions); body.append(sessionLabel);
      const slotLabel = document.createElement('label'); slotLabel.textContent = '按键';
      const keys = document.createElement('select');
      for (const key of free) {
        const option = document.createElement('option'); option.value = String(key);
        option.textContent = `按键 ${key+1} / AG0${key}`; option.selected = key === slot;
        keys.append(option);
      }
      slotLabel.append(keys); body.append(slotLabel);
      const color = field(body, '灯光颜色', sessionKeyboard.nextColor(), 'color');
      return () => ({agentId:sessions.value, slot:Number(keys.value), color:color.value});
    }, '绑定');
    if (!result) return;
    sessionKeyboard.bind(result.agentId, result.slot, result.color);
    toast(`已绑定到按键 ${result.slot+1}`);
  }
  async function changeKeyboardColor(agent){
    const binding=sessionKeyboard.getBinding(agent.agentId);if(!binding)return;
    const color=await modal('更换按键颜色',body=>{const input=field(body,`按键 ${binding.slot+1} 的颜色`,binding.color,'color');return()=>input.value;},'应用');
    if(color){sessionKeyboard.setColor(agent.agentId,color);toast(`按键 ${binding.slot+1} 颜色已更新`);}
  }
  async function createAgent() {
    const workspace = state.workspace;
    if (!workspace) return toast('请先选择 Workspace');
    const cwd = $('agentCwd').value.trim() || '.';
    let sessions;
    try {
      sessions = await requestBackend(workspace.backendId, `/api/v1/sessions?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(cwd)}`);
    } catch (error) {
      return toast(error.message);
    }
    const result=await modal('新建 Agent',body=>{const c=field(body,'工作路径',cwd);const l=document.createElement('label');l.textContent='Session';const s=document.createElement('select');s.innerHTML='<option value="">新 Session</option>'+sessions.map(x=>`<option value="${esc(x.path)}">${esc(x.name||x.sessionName||x.id||x.path)} · ${esc(x.modified||'')}</option>`).join('');l.append(s);body.append(l);return()=>({cwd:c.value.trim()||'.',sessionFile:s.value||undefined});},'创建');
    if (!result) return;
    try {
      const created = await postBackend(workspace.backendId, '/api/v1/agents', {workspaceId:workspace.id, relativeCwd:result.cwd, sessionFile:result.sessionFile});
      const agent = stampNewItem(workspace.backendId, created);
      const binding = result.sessionFile ? null : autoBindNewSession(agent);
      await refreshAgents();
      await selectAgent(agent);
      if (binding) toast(`新 Session 已自动绑定到按键 ${binding.slot+1}`);
    } catch (error) {
      toast(error.message);
    }
  }
  async function navigateAgent(entryId, agent = state.agent) {
    if (!agent) return;
    const result = await postAgent(agent.agentId, '/navigate', {entryId});
    await selectAgent(agent);
    if (result.editorText !== undefined) $('input').value = result.editorText;
    toast(result.editorText !== undefined ? '已回退到该用户输入，可编辑后重新发送' : '已回退到所选输出');
  }
  async function showSessionTree() {
    const sourceAgent = state.agent;
    if (!sourceAgent) return toast('请选择 Agent');
    const session = await requestAgent(sourceAgent.agentId, '/session');
    const entries = session.entries || [];
    const choice=await modal('Session Tree',body=>{const actionLabel=document.createElement('label');actionLabel.textContent='操作';const action=document.createElement('select');action.innerHTML='<option value="navigate">Navigate 到条目</option><option value="fork">从用户消息 Fork 新 Agent</option>';actionLabel.append(action);body.append(actionLabel);const list=document.createElement('div');list.className='modal-list';let selected='';for(const e of entries){const b=document.createElement('button');b.type='button';b.className='choice';const text=textContent(e.message?.content||e.content)||e.type;b.innerHTML=`${e.id===session.leafId?'● ':'○ '}${esc(text.slice(0,100))}<small>${esc(e.id)}</small>`;b.onclick=()=>{selected=e.id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>selected?{entryId:selected,action:action.value}:null;},'执行');
    if (!choice) return;
    if (choice.action === 'fork') {
      const result = await postAgent(sourceAgent.agentId, '/fork', {entryId:choice.entryId});
      const forkedAgent = stampNewItem(sourceAgent.backendId, result.agent);
      const binding = autoBindNewSession(forkedAgent);
      await refreshAgents();
      await selectAgent(forkedAgent);
      if (binding) toast(`Fork Session 已自动绑定到按键 ${binding.slot+1}`);
    } else {
      await navigateAgent(choice.entryId, sourceAgent);
    }
  }
  async function revert() {
    if(!state.agent)return toast('请选择 Agent');const session=await requestAgent(state.agent.agentId,'/session');
    const messages=(session.entries||[]).filter(e=>e.type==='message'&&['user','assistant'].includes(e.message?.role));
    if(!messages.length)return toast('当前 Session 没有可回退的消息');
    const selected=await modal('Undo（Session Tree）',body=>{const note=document.createElement('p');note.className='muted';note.textContent='选择用户输入会回到输入前并恢复文字；选择 Agent 输出会保留该输出、移除后续上下文。文件改动不会撤销。';body.append(note);const list=document.createElement('div');list.className='modal-list';let value=null;for(const e of [...messages].reverse()){const role=e.message.role==='user'?'You':'Agent',text=textContent(e.message.content)||'(空消息)';const b=document.createElement('button');b.type='button';b.className='choice';b.innerHTML=`<b>${role}</b> ${esc(text.slice(0,160))}<small>${esc(e.id)}${e.id===session.leafId?' · 当前':''}</small>`;b.onclick=()=>{value=e.id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>value;},'回退');
    if(selected)await navigateAgent(selected);
  }
  async function modelControls() {
    if(!state.agent)return toast('请选择 Agent');const cap=await requestAgent(state.agent.agentId,'/capabilities');
    const result=await modal('模型与 Thinking',body=>{const ml=document.createElement('label');ml.textContent='模型';const m=document.createElement('select');for(const x of cap.models||[]){const o=document.createElement('option');o.value=JSON.stringify([x.provider,x.id]);o.textContent=`${x.provider} / ${x.name||x.id}`;o.selected=x.provider===cap.model?.provider&&x.id===cap.model?.id;m.append(o);}ml.append(m);body.append(ml);const tl=document.createElement('label');tl.textContent='Thinking level';const t=document.createElement('select');for(const x of cap.thinkingLevels||[]){const o=document.createElement('option');o.value=x;o.textContent=x;o.selected=x===cap.thinkingLevel;t.append(o);}tl.append(t);body.append(tl);return()=>({model:m.value?JSON.parse(m.value):null,thinking:t.value});});
    if(result){if(result.model)await postAgent(state.agent.agentId,'/model',{provider:result.model[0],modelId:result.model[1]});if(result.thinking)await postAgent(state.agent.agentId,'/thinking',{level:result.thinking});toast('设置已更新');}
  }

  /** MCP servers Pi reads from mcp.json. Toggling writes the config; a session picks it up when it loads. */
  async function mcpControls() {
    if(!state.agent)return toast('请选择 Agent');
    const agentId=state.agent.agentId;
    const render=(overview,list)=>{
      list.replaceChildren();
      if(!overview.servers.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='没有配置 MCP 服务器。在 mcp.json 中添加后会显示在这里。';list.append(empty);}
      for(const server of overview.servers){
        const row=document.createElement('div');row.className=`mcp-row${server.enabled?'':' mcp-off'}`;
        const info=document.createElement('div');info.className='mcp-info';
        const name=document.createElement('b');name.textContent=server.name;
        const detail=document.createElement('small');detail.className='muted';
        detail.textContent=`${server.transport} · ${server.exposure} · ${server.scope==='project'?'项目':'全局'}${server.override?'（项目覆盖）':''}\n${server.description||server.target}`;
        info.append(name,detail);
        const toggle=document.createElement('button');toggle.type='button';toggle.textContent=server.enabled?'停用':'启用';
        toggle.onclick=async()=>{
          toggle.disabled=true;
          try{render(await postAgent(agentId,'/mcp',{name:server.name,enabled:!server.enabled}),list);toast('已保存，重新加载 Agent 后生效');}
          catch(error){toast(`修改失败：${error.message}`);toggle.disabled=false;}
        };
        row.append(info,toggle);list.append(row);
      }
      for(const error of overview.errors||[]){const line=document.createElement('p');line.className='mcp-error';line.textContent=error;list.append(line);}
      if(!overview.projectTrusted){const note=document.createElement('p');note.className='muted';note.textContent='项目未被信任，因此忽略 .pi/mcp.json，修改会写入全局配置。';list.append(note);}
    };
    const overview=await requestAgent(agentId,'/mcp');
    await modal('MCP 服务器',body=>{const list=document.createElement('div');list.className='mcp-list';render(overview,list);body.append(list);return null;},'关闭');
  }

  $('pairCancel').onclick=()=>$('pairDialog').close();
  $('modalCancel').onclick=()=>$('modal').close('cancel');
  $('pairForm').onsubmit = async event => {
    event.preventDefault();
    $('pairSubmit').disabled = true;
    // A record this submission created and that no Backend owns yet: if the connection never comes
    // up, it has to go, or the target's pairing code stays on the relay with nothing pointing at it.
    // The Backend being edited, what it was reached with, and the entry this submission builds are
    // kept for the same reason: connectBackend commits the new route onto the live Backend before the
    // whole connection is known to work, so a failure has to be able to put it back.
    let createdHost = null, existing = null, previous = null, snapshot = null, entry = null;
    try {
      const base = $('pairBase').value.trim().replace(/\/$/, '');
      const token = $('pairToken').value;
      let name = $('pairName').value.trim();
      if (!name) {
        try { name = new URL(base).hostname; } catch {}
      }
      const editingId = $('pairDialog').dataset.backendId, relayVia = $('pairRelayVia').value;
      existing = backendOf(editingId) || backendRegistry.findByBase(base, relayVia);
      // Where this Backend was reached before. Its record holds the target's pairing code, so it may
      // only be dropped once the new route has proved it works.
      previous = existing?.relayHostId ? {via:existing.relayVia, hostId:existing.relayHostId} : null;
      snapshot = existing ? {name:existing.name, base:existing.base, token:existing.token, saved:existing.saved, relayHostId:existing.relayHostId, relayVia:existing.relayVia} : null;
      entry = {id:existing?.id || createBackendId(), name, base, token, saved:existing?.saved || false};
      // A Backend others are relayed through is the address they are reached at: moving it, or putting
      // it behind a relay itself, takes that address away and leaves their records on a server nothing
      // in this browser points at any more.
      const children = existing ? relayChildren(state.backends, existing.id) : [];
      if (children.length && (relayVia || base !== existing.base)) {
        throw Error(`「${existing.name}」正在为 ${children.length} 个 backend 中继，改地址或改成中继连接都会让它们失联；请先把它们删掉或改走别的中继`);
      }
      if (relayVia) {
        // The relay stores the target pairing code; this browser only keeps the host id. The same
        // address returns the record it already has, a different one gets its own: an edit that moves
        // a Backend to another machine never writes that machine's address over the old record.
        const host = await postBackend(relayVia, '/api/v1/hosts', {name, base, token});
        if (host.created) createdHost = {name, base, relayVia, relayHostId:host.id};
        // The relay decides which addresses are the same machine. One record is one Backend here too,
        // so an address spelled differently than the one already registered edits it instead of
        // adding a second entry that would delete the first one's record along with itself.
        const owner = state.backends.find(item => item.relayHostId === host.id && item.id !== entry.id);
        // Moving a Backend onto a target another one already holds would leave two entries on one
        // record, and deleting the route of either would take the other's with it.
        if (owner && existing) throw Error(`这个目标已经是 backend「${owner.name}」，请直接改它，或先把它删掉`);
        entry = {...entry, id:owner?.id || entry.id, token:'', relayHostId:host.id, relayVia};
      } else if (previous) {
        // Back to a direct connection: the code just typed needs the usual consent, which a relayed
        // Backend never had to give.
        existing.saved = false;
        entry = {...entry, saved:false, relayHostId:'', relayVia:''};
      }
      await connectBackend(entry, {confirmSave:true});
      createdHost = null;
      // Only now is the old record unreachable from this browser, and only now may it be deleted.
      if (previous && previous.hostId !== entry.relayHostId) {
        const failed = await deleteRelayRecords([{...existing, relayVia:previous.via, relayHostId:previous.hostId}]);
        if (failed.length) toast(`旧中继记录未能删除：${failed[0].error.message}`);
      }
      $('pairDialog').close();
    } catch (error) {
      let message = error.message;
      // Nothing owns the record this submission created: a half-connected Backend was never saved, so
      // the route it holds dies with the page. Take it back rather than leave a pairing code behind,
      // and say so when that fails, because then nothing in the UI can reach it any more.
      if (createdHost) {
        const failed = await deleteRelayRecords([createdHost]);
        if (failed.length) message += `；中继「${backendOf(createdHost.relayVia)?.name || createdHost.relayVia}」上刚建的记录 ${createdHost.relayHostId} 没能删掉（${failed[0].error.message}），用同一地址重新添加一次会复用它，之后删掉该 backend 就能一并清掉`;
      }
      // An edit goes back to the address and code it was reached with, so the record it still owns
      // stays reachable; it stays in the error state it ended in, one click from reconnecting. An
      // addition that never connected was never saved either, so it leaves no entry behind.
      if (snapshot) Object.assign(existing, snapshot);
      else if (entry && backendOf(entry.id)) backendRegistry.remove(backendOf(entry.id));
      updateHeaderStatus();
      renderBackendList();
      toast(message);
    } finally {
      $('pairSubmit').disabled = false;
    }
  };
  $('openConfig').onclick=openConfig;$('configClose').onclick=()=>$('configDialog').close();$('configSave').onclick=saveMailSettings;$('connect').onclick=()=>openPair();$('keyboardConnect').onclick=async()=>{try{$('keyboardConnect').disabled=true;await sessionKeyboard.connect();}catch(error){toast(`键盘连接失败：${error.message}`);}finally{$('keyboardConnect').disabled=false;}};$('keyboardDisconnect').onclick=()=>sessionKeyboard.disconnect().catch(error=>toast(`键盘断开失败：${error.message}`));$('notifications').onclick=enableNotifications;$('voicePlayback').onclick=toggleVoicePlayback;$('voiceInput').onclick=toggleVoiceInput;$('disconnectAll').onclick=()=>void disconnectAll();$('backendFilter').onchange=()=>{state.backendFilter=$('backendFilter').value;if(state.backendFilter)localStorage.rpBackendFilter=state.backendFilter;else localStorage.removeItem('rpBackendFilter');renderWorkspaces().catch(()=>{});renderAgentList();};
  $('refreshWs').onclick=()=>refreshWs().catch(e=>toast(e.message));$('addWs').onclick=async()=>{if(!requireConnection())return;const result=await modal('添加 Workspace',body=>{const n=field(body,'名称');const p=field(body,'主机绝对路径');return()=>({label:n.value.trim(),rootPath:p.value.trim()});},'添加');if(result?.label&&result.rootPath){const target=state.backendFilter||state.workspace?.backendId||primaryBackend()?.id;if(!target)return toast('没有可用的 Backend');await postBackend(target,'/api/v1/workspaces',result);await refreshWs();}};
  $('workspaces').onchange=()=>void selectWorkspace();$('agentPageSize').value=String(state.agentPageSize);$('agentPageSize').onchange=()=>{state.agentPageSize=Number($('agentPageSize').value)||10;state.agentVisibleCount=state.agentPageSize;localStorage.rpAgentPageSize=String(state.agentPageSize);renderAgentList();};$('loadMoreAgents').onclick=()=>{state.agentVisibleCount+=state.agentPageSize;renderAgentList();};$('treeRoot').onclick=()=>openDirectory('.');$('treeUp').onclick=()=>openDirectory(parentPath(state.treePath));$('mentionCurrent').onclick=()=>insertMention(state.treePath);$('terminalCurrent').onclick=()=>openTerminal(state.treePath);
  $('treePath').oncontextmenu=e=>showContextMenu(e,{relativePath:state.treePath,type:'directory'});enableLongPressMenu($('treePath'),e=>showContextMenu(e,{relativePath:state.treePath,type:'directory'}));$('filePrev').onclick=()=>openFile(state.filePath,Math.max(0,state.fileOffset-state.fileLimit),false);$('fileNext').onclick=()=>openFile(state.filePath,state.fileOffset+state.fileLimit,false);
  $('menuStartAgent').onclick=()=>startAgent(state.contextTarget.relativePath);$('menuOpenTerminal').onclick=()=>openTerminal(state.contextTarget.relativePath);$('menuSetCwd').onclick=()=>{$('agentCwd').value=state.contextTarget.relativePath;$('contextMenu').hidden=true;};$('menuMention').onclick=()=>{insertMention(state.contextTarget.relativePath);$('contextMenu').hidden=true;};$('menuBindKeyboard').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent)void bindKeyboard({agentId:agent.agentId}).catch(error=>toast(error.message));};$('menuKeyboardColor').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent)void changeKeyboardColor(agent).catch(error=>toast(error.message));};$('menuUnbindKeyboard').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent&&sessionKeyboard.unbind(agent.agentId))toast('已取消键盘按键绑定');};$('menuCloseTerminal').onclick=()=>{const terminal=agentContextTarget?.kind==='terminal'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(terminal&&confirm('关闭这个 Terminal？正在运行的进程会被终止。'))void closeTerminal(terminal);};$('menuArchiveAgent').onclick=async()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(!agent||!confirm('Archive 这个 Agent？Pi Session 文件不会被修改。'))return;try{await postAgent(agent.agentId,'/archive');sessionKeyboard.unbind(agent.agentId);if(state.agent?.agentId===agent.agentId){state.agent=null;localStorage.removeItem('rpAgentId');$('agentTitle').textContent='请选择 Agent';$('agentStatus').textContent='';$('agentStateBadge').textContent='未选择';$('agentStateBadge').className='state-badge state-none';$('contextUsage').hidden=true;$('messages').innerHTML='<div class="empty">选择或创建 Agent 开始对话</div>'}await refreshAgents();toast('Agent 已 Archive')}catch(e){toast(e.message)}};document.addEventListener('click',e=>{if(!$('contextMenu').contains(e.target))$('contextMenu').hidden=true;if(!$('agentContextMenu').contains(e.target))$('agentContextMenu').hidden=true;});
  $('newAgent').onclick=createAgent;$('newTerminal').onclick=()=>openTerminal($('agentCwd').value.trim()||'.');$('abort').onclick=()=>{if(!state.agent)return;const id=state.agent.agentId;Promise.all([postAgent(id,'/abort'),postAgent(id,'/bash-abort')]).catch(e=>toast(e.message));};$('stop').onclick=async()=>{if(state.agent&&confirm('停止这个 Agent？之后再次使用时会按需启动。')){await requestAgent(state.agent.agentId,'',{method:'DELETE'});setAgentStatus(state.agent.agentId,'unloaded');}};
  $('sessionName').onclick=async()=>{if(!state.agent)return;const result=await modal('Session 名称',body=>{const n=field(body,'名称',state.agent.sessionName||'');return()=>n.value.trim();});if(result){const s=await postAgent(state.agent.agentId,'/session-name',{name:result});state.agent.sessionName=s.sessionName||result;updateAgentHeader();await refreshAgents();}};
  $('mcp').onclick=()=>mcpControls().catch(e=>toast(e.message));
  $('sessionTree').onclick=()=>showSessionTree().catch(e=>toast(e.message));$('undo').onclick=()=>revert().catch(e=>toast(e.message));$('controls').onclick=()=>modelControls().catch(e=>toast(e.message));$('compact').onclick=async()=>{if(!state.agent)return;const instructions=await modal('Compact',body=>{const n=field(body,'可选指令');return()=>n.value;},'开始');if(instructions!==null){await postAgent(state.agent.agentId,'/compact',{instructions:instructions||undefined});toast('Compact 完成');}};
  $('prompt').onsubmit=async event=>{event.preventDefault();if(!state.agent)return toast('请先创建或选择 Agent');const text=$('input').value.trim();if(!text)return;closeCommandPicker();const mode=$('sendMode').value,agentId=state.agent.agentId,sequenceBefore=localStorage[`rpSeq:${agentId}`];$('messages').querySelector('.empty')?.remove();
    // `!cmd` runs inside the Agent session (output is recorded in the Session); `!!cmd` keeps the output out of the model context.
    if(text.startsWith('!')){const excludeFromContext=text.startsWith('!!'),command=text.slice(excludeFromContext?2:1).trim();if(!command)return toast('请输入要执行的命令');addCard(null,text,'user');$('input').value='';
      try{await postAgent(agentId,'/bash',{command,excludeFromContext});if(state.agent?.agentId===agentId&&localStorage[`rpSeq:${agentId}`]===sequenceBefore){await loadMessagePage(agentId,undefined,true);}}catch(e){toast(`命令失败：${e.message}`);}return;}
    addCard(null,text,'user');$('input').value='';try{const sent=await postAgent(agentId,`/${mode}`,{message:text});if(mode!=='prompt'&&sent?.disposition)toast(sent.disposition==='queued'?'已排队，等待当前回合':'已送达当前回合');if(mode==='prompt'&&state.agent?.agentId===agentId&&localStorage[`rpSeq:${agentId}`]===sequenceBefore){await loadMessagePage(agentId,undefined,true);state.streams.clear();}}catch(e){addCard('发送失败',e.message,'error',true);}};
  $('input').onkeydown=event=>{if(!$('commandPicker').hidden){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setCommandSelection(state.commandIndex+(event.key==='ArrowDown'?1:-1));return;}if(event.key==='Tab'||(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)){event.preventDefault();chooseCommand(state.commandFiltered[state.commandIndex]);return;}if(event.key==='Escape'){event.preventDefault();closeCommandPicker();return;}}if(!$('mentionPicker').hidden){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setMentionSelection(state.mentionIndex+(event.key==='ArrowDown'?1:-1));return;}if(event.key==='Tab'||event.key==='Enter'){event.preventDefault();chooseMention(state.mentionFiltered[state.mentionIndex],event.key==='Enter');return;}if(event.key==='Escape'){event.preventDefault();closeMention();return;}}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){$('prompt').requestSubmit();}};$('input').oninput=()=>{const command=commandContext();if(command){if(!$('mentionPicker').hidden)closeMention();void openCommandPicker(command.query);return;}if(!$('commandPicker').hidden)closeCommandPicker();const context=mentionContext();if(!context){if(!$('mentionPicker').hidden)closeMention();return;}const fresh=$('mentionPicker').hidden||state.mentionStart!==context.start;state.mentionStart=context.start;state.mentionEnd=context.replacementEnd;if(fresh){state.mentionPrefix='';void openMention(state.treePath,context.query);return;}const filter=state.mentionPrefix&&context.query.startsWith(state.mentionPrefix)?context.query.slice(state.mentionPrefix.length):context.query;renderMentionItems(filter);};
  // Clearing hands the queued messages back, so nothing typed is lost when a run is redirected.
  $('queueClear').onclick=async()=>{
    if(!state.agent)return;const agentId=state.agent.agentId;
    try{
      // The server's queue_update event clears the banner; applying an empty queue here would hide a
      // message queued in the meantime.
      const cleared=await requestAgent(agentId,'/queue',{method:'DELETE'});
      const restored=[...(cleared.steering||[]),...(cleared.followUp||[])].join('\n');
      // The composer is shared, so restoring into another Agent's input would send the text there.
      if(restored&&state.agent?.agentId!==agentId)return toast('队列已清空，但已切换 Agent，内容未放回输入框');
      if(restored){const input=$('input');input.value=input.value.trim()?`${restored}\n${input.value}`:restored;input.focus();}
      toast(restored?'队列已清空，内容已放回输入框':'队列已清空');
    }catch(error){toast(`清空队列失败：${error.message}`);}
  };
  $('commandClose').onclick=closeCommandPicker;
  $('mentionUp').onclick=()=>browseMention(parentPath(state.mentionPath));$('mentionClose').onclick=closeMention;
  $('workspaceBack').onclick=()=>mobileBack('home');$('fileBack').onclick=()=>mobileBack('workspace');$('agentBack').onclick=()=>mobileBack('home');$('terminalBack').onclick=()=>mobileBack('home');$('terminalClear').onclick=()=>state.terminalEmulator?.clear();$('terminalClose').onclick=()=>{if(state.terminal&&confirm('关闭这个 Terminal？正在运行的进程会被终止。'))void closeTerminal();};
  $('mobileAgentActions').onclick=()=>$('mobileAgentActions').closest('.toolbar').classList.toggle('actions-open');
  document.querySelectorAll('.agent-action').forEach(button=>button.addEventListener('click',()=>button.closest('.toolbar').classList.remove('actions-open')));
  window.addEventListener('popstate',event=>setMobileView(event.state?.rpView||'home'));
  mobileMedia.addEventListener?.('change',event=>{if(event.matches)setMobileView('home',{replace:true});});
  window.addEventListener('beforeunload',()=>{for(const backend of state.backends)closeBackendSocket(backend);state.terminalWs?.close();cancelVoiceRecording();stopVoiceAudio();});
  window.addEventListener('focus',updateNotificationButton);
  setMobileView('home', {replace:true}); updateConfigUi(); updateKeyboardUi(); renderBackendFilter(); updateHeaderStatus(); void sessionKeyboard.restoreAuthorized();
  // Backends whose pairing code was explicitly saved reconnect on their own, and so do codeless
  // backends because a --no-auth server needs none; the pairing dialog is only for first-time
  // or failed connections.
  void (async () => {
    const candidates = state.backends.filter(backend => backend.base && (backend.saved || !backend.token));
    if (!candidates.length) { openPair(state.backends[0] || null); return; }
    // Relayed Backends need their relay connected first, so they go in a second round.
    const connect = backend => connectBackend(backend, {confirmSave:false, pair:false});
    const results = await Promise.allSettled(candidates.filter(backend => !backend.relayHostId).map(connect));
    results.push(...await Promise.allSettled(candidates.filter(backend => backend.relayHostId).map(connect)));
    if (!hasConnection()) {
      const error = results.find(result => result.status === 'rejected')?.reason;
      if (error) toast(`自动连接失败：${error.message}`);
      openPair(state.backends[0] || null);
    }
  })();
})();
