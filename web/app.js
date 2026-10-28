(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {
    BackendRegistry,
    createBackendId,
    resourceKey,
    splitResourceKey,
    normalizePath,
    isInsidePath,
    matchWorkspace
  } = window.RemotePiBackendState;
  const backendRegistry = new BackendRegistry(localStorage, location.origin);
  // The registry owns backend connections and their resource caches. This object
  // only keeps cross-backend UI selections and transient view state.
  const state = {
    backends: backendRegistry.items,
    backendFilter: localStorage.rpBackendFilter || '',
    workspace: null,
    treePath: '.',
    filePath: null,
    fileOffset: 0,
    fileSize: 0,
    fileLimit: 64 * 1024,
    agent: null,
    agents: [],
    terminals: [],
    terminal: null,
    selectedKind: 'agent',
    terminalWs: null,
    terminalEmulator: null,
    terminalAssetsPromise: null,
    terminalConnectAttempt: 0,
    fitAddon: null,
    resizeObserver: null,
    streams: new Map(),
    contextTarget: null,
    mentionPath: '.',
    mentionStart: null,
    mentionEnd: null,
    mentionPrefix: '',
    mentionOptions: [],
    mentionFiltered: [],
    mentionIndex: 0,
    mentionRequest: 0,
    extensionStatus: new Map(),
    widgets: new Map(),
    contexts: new Map(),
    mobileView: 'home',
    queues: new Map(),
    // Server-maintained activity of each busy Agent; idle ones are absent.
    activities: new Map(),
    // Timeline of the viewed Agent; see loadTimeline.
    timeline: null,
    timelineCache: new Map(),
    itemBodies: new Map(),
    // Cards of the message being streamed, and of running `!` commands, until they are recorded.
    liveCards: [],
    bashCards: new Map(),
    // Prompts shown before the server records them.
    optimistic: [],
    commands: [],
    commandsAgentId: null,
    commandFiltered: [],
    commandIndex: 0,
    commandRequest: 0,
    agentPageSize: Number(localStorage.rpAgentPageSize || 10),
    agentVisibleCount: Number(localStorage.rpAgentPageSize || 10),
    voiceEnabled: false,
    voiceSttEnabled: false,
    voicePlaybackEnabled: localStorage.rpVoicePlayback === 'true',
    voiceAudio: {
      context: null,
      nextTime: 0,
      playbackId: null,
      backendId: null,
      sources: new Set(),
      decodeChain: Promise.resolve(),
      generation: 0
    },
    mediaRecorder: null,
    voiceStream: null,
    mediaChunks: [],
    mediaStream: null,
    mediaTimer: null,
    mediaAgentId: null,
    mailBackendId: null,
    mailRequest: 0,
    sottoBackendId: null,
    sottoSettingsRequest: 0,
    mailNotificationsAvailable: false,
    mailSettings: {
      enabled: false,
      aggregationDelaySeconds: 0,
      includeResponse: true,
      includeSessionDetails: true,
      collabEscalations: true
    }
  };
  $('pairBase').value = state.backends[0]?.base || location.origin;
  $('pairName').value = state.backends[0]?.name || '';

  const clean = normalizePath;
  const joinPath = (base, name) => (base === '.' ? name : `${base}/${name}`);
  const parentPath = value => {
    const p = value.split('/');
    p.pop();
    return p.join('/') || '.';
  };
  const absolutePath = relative => clean(`${state.workspace.rootPath}/${relative === '.' ? '' : relative}`);
  const isInside = isInsidePath;
  /** A cwd only belongs to a Workspace of the same Backend: the same path on two machines is two directories. */
  const ownsPath = (workspace, item) =>
    !!workspace &&
    workspace.backendId === item.backendId &&
    isInside(clean(item.cwd), clean(workspace.rootPath));
  const relativeTo = (file, dir) => (file === dir ? '.' : file.slice(dir.length + 1));
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
    );
  const toast = text => {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => ($('toast').hidden = true), 3000);
  };
  const backendOf = id => backendRegistry.find(id);
  // Must equal the server's PROTOCOL_VERSION (src/ws/agent-socket.ts); test/web-protocol-version.test.ts checks it.
  const PROTOCOL_VERSION = 2;
  const connectedBackends = () => backendRegistry.connected();
  const primaryBackend = () => backendRegistry.primary();
  const hasConnection = () => connectedBackends().length > 0;
  const requireConnection = () => {
    if (!hasConnection()) {
      openPair(state.backends[0] || null);
      return false;
    }
    return true;
  };
  const mobileMedia = matchMedia('(max-width: 700px)');
  const isMobile = () => mobileMedia.matches;
  function setMobileView(view, {push = false, replace = false} = {}) {
    if (!['home', 'workspace', 'file', 'agent'].includes(view)) view = 'home';
    const changed = state.mobileView !== view;
    state.mobileView = view;
    document.body.dataset.mobileView = view;
    $('workspaceHeading').textContent = view === 'home' ? 'Workspace' : state.workspace?.label || 'Workspace';
    $('mobileAgentActions').closest('.toolbar')?.classList.remove('actions-open');
    if (!isMobile()) return;
    const historyState = {...(history.state || {}), rpView: view};
    if (replace) history.replaceState(historyState, '');
    else if (push && (changed || history.state?.rpView !== view)) history.pushState(historyState, '');
  }
  const navigateMobile = view => {
    if (isMobile()) setMobileView(view, {push: true});
  };
  const mobileBack = fallback => {
    if (isMobile() && history.state?.rpView === state.mobileView && state.mobileView !== 'home')
      history.back();
    else setMobileView(fallback, {replace: true});
  };

  async function request(base, token, url, options = {}, onUnauthorized) {
    const headers = {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...options.headers
    };
    const response = await fetch(base + url, {...options, headers});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      throw Error(body.error?.message || `HTTP ${response.status}`);
    }
    return body.data;
  }
  async function backendRequiresAuth(base) {
    try {
      return (await request(base, '', '/health')).authRequired !== false;
    } catch {
      return true;
    }
  }
  async function requestBackend(backendId, url, options = {}) {
    const backend = backendOf(backendId);
    if (!backend) throw Error('Backend 不存在');
    if (backend.status !== 'connected') throw Error(`Backend「${backend.name || backendId}」未连接`);
    return request(backend.base, backend.token, url, options, () => {
      if (backend.status === 'connected')
        void deactivateBackend(backend, {status: 'error', error: '配对码无效或已失效'});
    });
  }
  const postBackend = (backendId, url, body = {}) =>
    requestBackend(backendId, url, {method: 'POST', body: JSON.stringify(body)});
  const requestAgent = (agentId, suffix = '', options = {}) => {
    const {backendId, remoteId} = splitResourceKey(agentId);
    return requestBackend(backendId, `/api/v1/agents/${encodeURIComponent(remoteId)}${suffix}`, options);
  };
  const postAgent = (agentId, suffix = '', body = {}) =>
    requestAgent(agentId, suffix, {method: 'POST', body: JSON.stringify(body)});

  function openPair(backend = null) {
    if ($('pairDialog').open) return;
    if ($('configDialog').open) $('configDialog').close();
    $('pairDialog').dataset.backendId = backend?.id || '';
    $('pairName').value = backend?.name || '';
    $('pairBase').value = backend?.base || location.origin;
    $('pairToken').value = backend?.token || '';
    if (!$('pairDialog').open) $('pairDialog').showModal();
  }
  function persistConnections() {
    backendRegistry.persist();
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
    $('status').textContent =
      state.backends.length > 1 ? `已连接 ${connected.length}/${state.backends.length}` : '已配对';
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
    if (
      state.voiceStream &&
      (!backendId || splitResourceKey(state.voiceStream.agentId).backendId === backendId)
    )
      finishSottoStream(state.voiceStream, true);
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
    $('voiceInput').disabled = false;
    $('voiceInput').classList.remove('recording');
  }

  function clearAgentSelection(backendId) {
    cancelVoiceRecording(backendId);
    if (backendId && state.agent?.backendId !== backendId) return;
    state.agent = null;
    updateVoiceAvailability();
    state.timeline = null;
    sendFocus();
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

  function applyVoiceStatus(backend, statusInfo) {
    const voice = state.voiceStream;
    if (
      voice &&
      splitResourceKey(voice.agentId).backendId === backend.id &&
      (!statusInfo.sottoStt?.enabled ||
        statusInfo.sottoStt.endpoint !== backend.statusInfo?.sottoStt?.endpoint)
    )
      finishSottoStream(voice, true);
    backend.statusInfo = statusInfo;
    backend.voiceEnabled = Boolean(statusInfo.voiceCapabilities?.tts ?? statusInfo.voiceEnabled);
    backend.voiceSttEnabled = Boolean(statusInfo.voiceCapabilities?.stt ?? statusInfo.voiceEnabled);
  }
  function updateVoiceAvailability() {
    const backends = connectedBackends();
    state.voiceEnabled = backends.some(backend => backend.voiceEnabled);
    const agentBackend = state.agent && backendOf(state.agent.backendId);
    state.voiceSttEnabled = Boolean(agentBackend?.status === 'connected' && agentBackend.voiceSttEnabled);
    $('voicePlayback').hidden = !state.voiceEnabled;
    $('voiceInput').hidden = !state.voiceSttEnabled && !state.voiceStream;
    $('voiceInput').title = '开始语音输入（输入框内 Alt+Shift+V）';
    if (!state.voiceEnabled) stopVoiceAudio();
    updateVoiceButton();
  }
  async function connectBackend(entry, {confirmSave = true, pair = true} = {}) {
    const base =
      String(entry.base || '')
        .trim()
        .replace(/\/$/, '') || location.origin;
    let token = String(entry.token || '').trim();
    if (!token && (await backendRequiresAuth(base))) {
      if (pair) openPair(entry);
      throw Error('请先输入配对码');
    }

    const statusInfo = await request(base, token, '/api/v1/system/status');
    if (statusInfo.protocolVersion !== PROTOCOL_VERSION) {
      throw Error(`不支持的协议版本 ${statusInfo.protocolVersion}（需要 ${PROTOCOL_VERSION}）`);
    }
    const authRequired = statusInfo.authRequired !== false;
    if (!authRequired) token = '';

    let backend = backendOf(entry.id);
    if (!backend) {
      backend = backendRegistry.add({
        id: entry.id || createBackendId(),
        name: '',
        base: '',
        token: '',
        saved: false
      });
    }

    closeBackendSocket(backend);
    Object.assign(backend, {
      name: String(entry.name || '').trim() || base,
      base,
      token,
      status: 'connected',
      error: '',
      statusInfo,
      authRequired,
      serverInfo: `v${statusInfo.version} · Pi ${statusInfo.piVersion}`,
      reconnectAttempt: 0
    });
    applyVoiceStatus(backend, statusInfo);

    try {
      await refreshBackendData(backend);
    } catch (error) {
      if (backend.status !== 'error')
        await deactivateBackend(backend, {status: 'error', error: error.message});
      throw error;
    }

    if (entry.saved) backend.saved = true;
    if (
      confirmSave &&
      authRequired &&
      !backend.saved &&
      confirm(`是否将「${backend.name}」的配对码保存到浏览器本地存储？\n\n请仅在可信设备上保存。`)
    ) {
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
      requestBackend(backend.id, '/api/v1/terminals')
    ]);
    if (backend.status !== 'connected') return;
    backend.workspaces = workspaces.map(workspace => ({
      ...workspace,
      backendId: backend.id,
      backendName: backend.name
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
      backendName: backend.name
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
  const workspaceLabel = workspace =>
    connectedBackends().length > 1 ? `${workspace.backendName} · ${workspace.label}` : workspace.label;
  async function renderWorkspaces() {
    const workspaces = visibleWorkspaces();
    $('workspaces').replaceChildren(
      ...workspaces.map(workspace => {
        const option = document.createElement('option');
        option.value = workspaceKey(workspace);
        option.textContent = `${workspaceLabel(workspace)} (${workspace.rootPath})`;
        return option;
      })
    );
    renderMobileWorkspaces();
    if (workspaces.length) {
      const wanted = state.workspace ? workspaceKey(state.workspace) : localStorage.rpWorkspaceId;
      const values = workspaces.map(workspaceKey);
      if (values.includes(wanted)) {
        $('workspaces').value = wanted;
        if (!state.workspace) await selectWorkspace();
      } else {
        $('workspaces').value = values[0];
        await selectWorkspace();
      }
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
    select.replaceChildren(
      ...state.backends.map(backend => {
        const option = document.createElement('option');
        option.value = backend.id;
        option.textContent = backend.name || backend.base;
        return option;
      })
    );
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部 Backend';
    select.prepend(all);
    select.value = state.backendFilter;
    select.hidden = state.backends.length < 2;
  }
  function renderBackendList() {
    const list = $('backendList');
    if (!list) return;
    list.replaceChildren(
      ...state.backends.map(backend => {
        const row = document.createElement('div');
        row.className = 'backend-row';
        const info = document.createElement('div');
        info.className = 'backend-row-info';
        const name = document.createElement('b');
        name.textContent = backend.name || backend.base;
        const detail = document.createElement('small');
        const statusText =
          backend.status === 'connected'
            ? backend.reconnecting
              ? '已连接 · 重连中'
              : `已连接 · ${backend.authRequired === false ? '无需认证 · ' : ''}${backend.serverInfo}`
            : backend.status === 'error'
              ? `连接失败 · ${backend.error || ''}`
              : '未连接';
        detail.textContent = `${backend.base} · ${statusText}`;
        info.append(name, detail);
        const actions = document.createElement('div');
        actions.className = 'backend-row-actions';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = backend.status === 'connected' ? '断开' : '连接';
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
            if (backend.status !== 'error')
              await deactivateBackend(backend, {status: 'error', error: error.message});
            toast(error.message);
          } finally {
            toggle.disabled = false;
          }
        };
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = '修改';
        edit.onclick = () => openPair(backend);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger-action';
        remove.textContent = '删除';
        remove.onclick = async () => {
          if (!confirm(`删除 backend「${backend.name}」？只影响这个页面，不会停止该机器上的服务。`)) return;
          const agentIds = backend.agents.map(agent => agent.agentId);
          deactivateBackendState(backend, 'off');
          backendRegistry.remove(backend);
          persistConnections();
          for (const agentId of agentIds) sessionKeyboard.unbind(agentId);
          if (state.backendFilter === backend.id) {
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
        actions.append(toggle, edit, remove);
        row.append(info, actions);
        return row;
      })
    );
  }

  async function refreshWs() {
    if (!requireConnection()) return;
    await Promise.allSettled(connectedBackends().map(refreshBackendWorkspaces));
    await renderWorkspaces();
  }
  function renderMobileWorkspaces() {
    $('mobileWorkspaces').replaceChildren(
      ...visibleWorkspaces().map(workspace => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-card';
        const name = document.createElement('b'),
          path = document.createElement('small');
        name.textContent = workspaceLabel(workspace);
        path.textContent = workspace.rootPath;
        button.append(name, path);
        button.onclick = async () => {
          try {
            $('workspaces').value = workspaceKey(workspace);
            await selectWorkspace();
            navigateMobile('workspace');
          } catch (error) {
            toast(error.message);
          }
        };
        return button;
      })
    );
  }
  async function selectWorkspace(selectedKey = $('workspaces').value) {
    const {backendId, remoteId} = splitResourceKey(selectedKey);
    state.workspace = backendOf(backendId)?.workspaces.find(workspace => workspace.id === remoteId) || null;
    if (!state.workspace) return;
    // A Backend filter can hide the owning Workspace from the picker; the selection still has to follow it.
    if ([...$('workspaces').options].some(option => option.value === selectedKey))
      $('workspaces').value = selectedKey;
    localStorage.rpWorkspaceId = selectedKey;
    state.treePath = '.';
    $('agentCwd').value = '.';
    $('filePanel').hidden = true;
    $('workspaceHeading').textContent =
      isMobile() && state.mobileView !== 'home' ? workspaceLabel(state.workspace) : 'Workspace';
    await loadTree();
  }
  async function loadTree() {
    const workspace = state.workspace;
    const treePath = state.treePath;
    if (!workspace) return;
    $('treePath').textContent = absolutePath(treePath);
    try {
      const items = await requestBackend(
        workspace.backendId,
        `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/tree?path=${encodeURIComponent(treePath)}`
      );
      if (
        !state.workspace ||
        workspaceKey(state.workspace) !== workspaceKey(workspace) ||
        state.treePath !== treePath
      )
        return;
      $('tree').replaceChildren(
        ...items.map(item => {
          const el = document.createElement('div');
          el.className = `entry ${item.type === 'directory' ? 'dir' : 'file-entry'}`;
          el.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`;
          const relativePath = joinPath(treePath, item.name);
          el.onclick = () =>
            item.type === 'directory' ? openDirectory(relativePath) : openFile(relativePath, 0);
          const contextTarget = {relativePath, type: item.type};
          el.oncontextmenu = event => showContextMenu(event, contextTarget);
          enableLongPressMenu(el, event => showContextMenu(event, contextTarget));
          return el;
        })
      );
    } catch (error) {
      $('tree').textContent = error.message;
    }
  }
  async function openDirectory(relativePath) {
    state.treePath = relativePath;
    $('filePanel').hidden = true;
    await loadTree();
  }
  async function openFile(relativePath, offset, showView = true) {
    const workspace = state.workspace;
    if (!workspace) return;
    try {
      const file = await requestBackend(
        workspace.backendId,
        `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(relativePath)}&offset=${offset}&limit=${state.fileLimit}`
      );
      if (!state.workspace || workspaceKey(state.workspace) !== workspaceKey(workspace)) return;
      state.filePath = relativePath;
      state.fileOffset = file.offset;
      state.fileSize = file.size;
      $('filePanel').hidden = false;
      $('fileName').textContent = relativePath;
      $('file').textContent = file.binary ? `[二进制文件，${file.size} bytes，无法预览]` : file.content;
      $('filePage').textContent =
        `${file.offset.toLocaleString()}–${Math.min(file.offset + file.limit, file.size).toLocaleString()} / ${file.size.toLocaleString()} bytes`;
      $('filePrev').disabled = file.offset <= 0;
      $('fileNext').disabled = file.binary || file.offset + file.limit >= file.size;
      if (showView) navigateMobile('file');
    } catch (error) {
      toast(error.message);
    }
  }
  function showContextMenu(event, target) {
    event.preventDefault();
    state.contextTarget = target;
    const isDirectory = target.type === 'directory';
    $('menuStartAgent').hidden = !isDirectory;
    $('menuSetCwd').hidden = !isDirectory;
    $('menuOpenTerminal').hidden = !isDirectory;
    const menu = $('contextMenu');
    menu.hidden = false;
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, innerWidth - menu.offsetWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, innerHeight - menu.offsetHeight - margin))}px`;
  }
  function enableLongPressMenu(element, openMenu) {
    let timer = null,
      pointerId = null,
      startX = 0,
      startY = 0,
      suppressClickUntil = 0;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pointerId = null;
      element.classList.remove('long-press-pending');
    };
    element.classList.add('long-press-menu');
    element.addEventListener('pointerdown', event => {
      if (!isMobile() || event.pointerType === 'mouse' || event.button !== 0 || !event.isPrimary) return;
      cancel();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      element.classList.add('long-press-pending');
      timer = setTimeout(() => {
        timer = null;
        suppressClickUntil = Date.now() + 700;
        element.classList.remove('long-press-pending');
        navigator.vibrate?.(15);
        openMenu({preventDefault() {}, clientX: startX, clientY: startY});
      }, 550);
    });
    element.addEventListener('pointermove', event => {
      if (event.pointerId === pointerId && Math.hypot(event.clientX - startX, event.clientY - startY) > 10)
        cancel();
    });
    element.addEventListener('pointerup', event => {
      if (event.pointerId === pointerId) cancel();
    });
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('pointerleave', event => {
      if (event.pointerId === pointerId) cancel();
    });
    element.addEventListener(
      'click',
      event => {
        if (Date.now() < suppressClickUntil) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
  }
  function mentionContext() {
    const input = $('input'),
      end = input.selectionStart,
      before = input.value.slice(0, end),
      match = before.match(/(^|\s)@(?:"([^"]*)"?|([^\s]*))$/);
    if (!match) return null;
    const token = match[0].slice(match[1]?.length || 0),
      start = end - token.length,
      replacementEnd = end + (token.startsWith('@"') && input.value[end] === '"' ? 1 : 0);
    return {start, end, replacementEnd, query: match[2] ?? match[3] ?? ''};
  }
  function mentionValue(relativePath, directory = false) {
    const target = absolutePath(relativePath),
      cwd = clean(state.agent?.cwd || absolutePath($('agentCwd').value.trim() || '.'));
    let value = isInside(target, cwd) ? relativeTo(target, cwd) : target;
    if (directory && value !== '.') value += '/';
    return value;
  }
  function writeMention(relativePath, {directory = false, close = true} = {}) {
    if (!state.workspace) return;
    const input = $('input'),
      context = mentionContext(),
      from = state.mentionStart ?? context?.start ?? input.selectionStart,
      to = state.mentionEnd ?? context?.replacementEnd ?? input.selectionStart;
    const value = mentionValue(relativePath, directory),
      quoted = value.includes(' '),
      mention = `@${quoted ? `"${value}"` : value}`;
    input.setRangeText(`${mention}${close ? ' ' : ''}`, from, to, 'end');
    state.mentionStart = from;
    state.mentionEnd = from + mention.length;
    if (directory && !close && quoted) input.setSelectionRange(state.mentionEnd - 1, state.mentionEnd - 1);
    input.focus();
    if (close) closeMention();
  }
  function insertMention(relativePath) {
    state.mentionStart = null;
    state.mentionEnd = null;
    writeMention(relativePath);
  }
  function setMentionSelection(index) {
    const count = state.mentionFiltered.length;
    if (!count) {
      state.mentionIndex = 0;
      return;
    }
    state.mentionIndex = (index + count) % count;
    $('mentionItems')
      .querySelectorAll('.picker-item')
      .forEach((element, i) => element.classList.toggle('selected', i === state.mentionIndex));
    $('mentionItems').querySelector('.picker-item.selected')?.scrollIntoView({block: 'nearest'});
  }
  function browseMention(path) {
    writeMention(path, {directory: true, close: false});
    state.mentionPrefix = mentionValue(path, true);
    void openMention(path, '');
  }
  function chooseMention(option, close) {
    if (!option) return;
    if (option.type === 'directory' && !close && !option.current) {
      browseMention(option.path);
      return;
    }
    writeMention(option.path, {close});
    if (!close) state.mentionPrefix = '';
  }
  function renderMentionItems(filter = '') {
    const query = filter.toLocaleLowerCase(),
      options = state.mentionOptions.filter(
        option =>
          !query ||
          (!option.current &&
            (option.name.toLocaleLowerCase().includes(query) ||
              option.path.toLocaleLowerCase().includes(query)))
      );
    state.mentionFiltered = options;
    state.mentionIndex = 0;
    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty muted';
      empty.textContent = '没有匹配的文件或目录';
      $('mentionItems').replaceChildren(empty);
      return;
    }
    $('mentionItems').replaceChildren(
      ...options.map((option, index) => {
        const el = document.createElement('div');
        el.className = `picker-item ${option.type === 'directory' ? 'dir' : 'file-entry'}${index === 0 ? ' selected' : ''}`;
        el.textContent = option.label;
        el.onmouseenter = () => setMentionSelection(index);
        el.onclick = () => chooseMention(option, option.type !== 'directory' || option.current);
        return el;
      })
    );
  }
  async function openMention(path = state.treePath, filter = '') {
    if (!state.workspace) return;
    const request = ++state.mentionRequest;
    state.mentionPath = path;
    $('mentionPicker').hidden = false;
    $('mentionPath').textContent = absolutePath(path);
    try {
      const items = await requestBackend(
        state.workspace.backendId,
        `/api/v1/workspaces/${encodeURIComponent(state.workspace.id)}/tree?path=${encodeURIComponent(path)}`
      );
      if (request !== state.mentionRequest) return;
      state.mentionOptions = [
        {name: '引用当前目录', path, type: 'directory', current: true, label: '📁 引用当前目录'},
        ...items.map(item => ({
          name: item.name,
          path: joinPath(path, item.name),
          type: item.type,
          current: false,
          label: `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`
        }))
      ];
      renderMentionItems(filter);
    } catch (error) {
      if (request === state.mentionRequest) $('mentionItems').textContent = error.message;
    }
  }
  function closeMention() {
    state.mentionRequest++;
    state.mentionStart = null;
    state.mentionEnd = null;
    state.mentionPrefix = '';
    $('mentionPicker').hidden = true;
  }

  // Slash commands: prompt templates and skills are expanded by the Pi session itself
  // (AgentSession.prompt() expands them by default), so the composer only has to help discover them.
  function commandContext() {
    const input = $('input'),
      end = input.selectionStart,
      before = input.value.slice(0, end);
    const match = before.match(/^\/([^\s]*)$/);
    return match ? {end, query: match[1]} : null;
  }
  async function loadCommands(agentId) {
    if (state.commandsAgentId === agentId) return state.commands;
    const commands = await requestAgent(agentId, '/commands');
    return Array.isArray(commands) ? commands : [];
  }
  function setCommandSelection(index) {
    const count = state.commandFiltered.length;
    if (!count) {
      state.commandIndex = 0;
      return;
    }
    state.commandIndex = (index + count) % count;
    $('commandItems')
      .querySelectorAll('.picker-item')
      .forEach((element, i) => element.classList.toggle('selected', i === state.commandIndex));
    $('commandItems').querySelector('.picker-item.selected')?.scrollIntoView({block: 'nearest'});
  }
  function chooseCommand(option) {
    if (!option) return;
    const input = $('input'),
      context = commandContext();
    input.setRangeText(`/${option.name} `, 0, context ? context.end : input.value.length, 'end');
    closeCommandPicker();
    input.focus();
  }
  function renderCommandItems(query = '') {
    const filter = query.toLocaleLowerCase(),
      options = state.commands.filter(
        command => !filter || command.name.toLocaleLowerCase().includes(filter)
      );
    state.commandFiltered = options;
    state.commandIndex = 0;
    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty muted';
      empty.textContent = state.commands.length ? '没有匹配的命令' : '当前目录没有 prompt template 或 skill';
      $('commandItems').replaceChildren(empty);
      return;
    }
    $('commandItems').replaceChildren(
      ...options.map((option, index) => {
        const el = document.createElement('div');
        el.className = `picker-item${index === 0 ? ' selected' : ''}`;
        const name = document.createElement('b');
        name.textContent = `/${option.name}${option.argumentHint ? ` ${option.argumentHint}` : ''}`;
        const description = document.createElement('small');
        description.className = 'muted';
        description.textContent = `${option.source === 'skill' ? 'skill' : 'prompt'}${option.description ? ` · ${option.description}` : ''}`;
        el.append(name, description);
        el.onmouseenter = () => setCommandSelection(index);
        el.onclick = () => chooseCommand(option);
        return el;
      })
    );
  }
  async function openCommandPicker(query = '') {
    if (!state.agent) return;
    const agentId = state.agent.agentId,
      request = ++state.commandRequest;
    $('commandPicker').hidden = false;
    if (state.commandsAgentId !== agentId) {
      state.commands = [];
      $('commandItems').textContent = '正在加载命令…';
    }
    try {
      const commands = await loadCommands(agentId);
      if (request !== state.commandRequest || state.agent?.agentId !== agentId || $('commandPicker').hidden)
        return;
      state.commands = commands;
      state.commandsAgentId = agentId;
      renderCommandItems(query);
    } catch (error) {
      if (request === state.commandRequest && state.agent?.agentId === agentId) {
        state.commands = [];
        $('commandItems').textContent = '无法加载命令';
        console.error('Unable to load slash commands', error);
      }
    }
  }
  function closeCommandPicker() {
    state.commandRequest++;
    $('commandPicker').hidden = true;
    state.commandFiltered = [];
    state.commandIndex = 0;
  }

  function agentName(agent) {
    return agent.sessionName || agent.name;
  }
  function agentLabel(agent) {
    return agentName(agent) || agent.cwd || agent.agentId;
  }
  function agentSubtitle(agent) {
    return agentName(agent) ? agent.cwd : agent.agentId;
  }
  function updateKeyboardUi(connection) {
    const connected = connection?.connected ?? sessionKeyboard.connected,
      name = connection?.name || sessionKeyboard.device?.productName || 'Codex Micro';
    $('keyboardConnect').hidden = connected;
    $('keyboardDisconnect').hidden = !connected;
    const unavailable = !window.isSecureContext
      ? '需要 HTTPS 或 localhost'
      : !navigator.hid
        ? '当前浏览器不支持 WebHID'
        : '';
    $('keyboardConnect').disabled = Boolean(unavailable);
    $('keyboardConnect').title = unavailable;
    $('keyboardStatus').textContent = connected
      ? `已连接 ${name} · LLM 慢速呼吸，Tool 中速呼吸，Retry 快速呼吸，等待输入浅呼吸，空闲常亮`
      : unavailable || '未连接 · 绑定保存在当前浏览器';
    renderKeyboardBindings();
  }
  function renderKeyboardBindings() {
    const slots = $('keyboardSlots');
    if (!slots) return;
    const focusedId = slots.contains(document.activeElement) ? document.activeElement.id : '';
    const agents = new Map(state.agents.map(agent => [agent.agentId, agent]));
    const canBind = hasConnection() && state.agents.some(agent => !sessionKeyboard.getBinding(agent.agentId));
    slots.replaceChildren(
      ...Array.from({length: 6}, (_, slot) => {
        const binding = sessionKeyboard.getSlot(slot),
          agent = binding && agents.get(binding.agentId);
        const el = document.createElement('div');
        el.className = 'keyboard-slot';
        el.style.setProperty('--key-color', binding?.color || '#586174');
        const title = document.createElement('b');
        title.textContent = `键 ${slot + 1}${binding ? ' · ' + binding.color : ''}`;
        const detail = document.createElement('small');
        detail.textContent = binding ? (agent ? agentLabel(agent) : 'Session 当前不可用') : '未绑定';
        const actions = document.createElement('div');
        actions.className = 'keyboard-slot-actions';
        if (binding) {
          const color = document.createElement('button');
          color.type = 'button';
          color.textContent = '颜色…';
          color.id = `keyboardSlot${slot}Color`;
          color.setAttribute('aria-label', `更换按键 ${slot + 1} 的颜色`);
          color.onclick = () => changeKeyboardColor(binding).catch(error => toast(error.message));
          actions.append(color);
        }
        const action = document.createElement('button');
        action.type = 'button';
        action.id = `keyboardSlot${slot}Binding`;
        action.textContent = binding ? '取消绑定' : '绑定 Session…';
        action.setAttribute('aria-label', `${binding ? '取消' : '设置'}按键 ${slot + 1} 的绑定`);
        action.disabled = !binding && !canBind;
        action.onclick = async () => {
          try {
            if (binding) {
              sessionKeyboard.unbind(binding.agentId);
              toast('已取消键盘按键绑定');
            } else await bindKeyboard({slot});
          } catch (error) {
            toast(error.message);
          }
        };
        actions.append(action);
        el.append(title, detail, actions);
        return el;
      })
    );
    if (focusedId) $(focusedId)?.focus();
  }
  const sessionKeyboard = new window.SessionKeyboardController({
    onKey: binding => {
      const agent = state.agents.find(item => item.agentId === binding.agentId);
      if (!agent) return toast(`按键 ${binding.slot + 1} 绑定的 Session 当前不可用`);
      if (state.selectedKind === 'agent' && state.agent?.agentId === agent.agentId)
        return navigateMobile('agent');
      selectAgent(agent).catch(error => toast(error.message));
    },
    onStateChange: updateKeyboardUi,
    onBindingsChange: () => {
      renderAgentList();
      renderKeyboardBindings();
    },
    onError: error => {
      console.error('Session keyboard error', error);
      toast(`键盘：${error.message}`);
    }
  });
  const formatTokens = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(Math.round(n));
  };
  const usageLevel = usage =>
    Number(usage?.percent) > 90 ? 'usage-danger' : Number(usage?.percent) > 70 ? 'usage-warning' : '';
  const usageText = usage => {
    if (!usage || !Number(usage.contextWindow)) return 'Context ?';
    const percent = usage.percent == null ? '?' : `${Number(usage.percent).toFixed(1)}%`;
    return `${percent} · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`;
  };
  const costText = usage => {
    const cost = Number(usage?.cost);
    if (!Number.isFinite(cost)) return 'Session cost ?';
    return `Session cost ~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
  };
  const sessionUsage = session => ({...(session.contextUsage || {}), cost: session.stats?.cost});
  // Server time for a backend, corrected by the skew measured when its socket subscribed.
  const activityView = window.ActivityView.createActivityView(
    backendId => Date.now() + (backendOf(backendId)?.clockOffset || 0)
  );
  setInterval(activityView.tick, 1000);
  function renderAgentList() {
    const recent = (value, fallback) => {
      const time = Date.parse(value || fallback || '');
      return Number.isFinite(time) ? time : 0;
    };
    let allItems = [
      ...state.agents.map(item => ({kind: 'agent', item})),
      ...state.terminals.map(item => ({kind: 'terminal', item}))
    ].sort(
      (a, b) => recent(b.item.lastActiveAt, b.item.createdAt) - recent(a.item.lastActiveAt, a.item.createdAt)
    );
    if (state.backendFilter)
      allItems = allItems.filter(entry => entry.item.backendId === state.backendFilter);
    const items = allItems.slice(0, state.agentVisibleCount);
    $('agents').replaceChildren(
      ...items.map(({kind, item}) => {
        const isAgent = kind === 'agent',
          id = isAgent ? item.agentId : item.terminalId,
          selected =
            state.selectedKind === kind &&
            (isAgent ? state.agent?.agentId : state.terminal?.terminalId) === id;
        const el = document.createElement('div');
        el.dataset.itemId = id;
        el.className = `agent ${item.status}${selected ? ' selected' : ''}`;
        if (isAgent) {
          const usage = state.contexts.get(item.agentId),
            binding = sessionKeyboard.getBinding(item.agentId);
          el.innerHTML = `<div class="agent-top"><b>${esc(agentLabel(item))}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(agentSubtitle(item))}</small><div class="agent-context ${usageLevel(usage)}"><span>Context</span><div class="mini-track"><i style="width:${Math.min(100, Math.max(0, Number(usage?.percent) || 0))}%"></i></div><span>${esc(usageText(usage))} · ${esc(costText(usage))}</span></div>`;
          if (binding) {
            const badge = document.createElement('span');
            badge.className = 'key-binding';
            badge.style.setProperty('--key-color', binding.color);
            badge.textContent = `K${binding.slot + 1}`;
            badge.title = `键盘按键 ${binding.slot + 1} · ${binding.color}`;
            el.querySelector('.agent-top').append(badge);
          }
          if (item.template) {
            const tag = document.createElement('span');
            tag.className = 'template-tag';
            tag.textContent = item.template.name || item.template.id;
            tag.title = `System Prompt 模板：${item.template.name || item.template.id}（${templateModeText(item.template.mode)}，创建时固定）`;
            el.querySelector('.agent-top').append(tag);
          }
          const activityLine = activityView.line(state.activities.get(item.agentId), item.backendId);
          if (activityLine) el.querySelector('small').after(activityLine);
        } else
          el.innerHTML = `<div class="agent-top"><span class="terminal-kind">&gt;_</span><b>${esc(item.title || 'Terminal')}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(item.cwd)}</small>`;
        if (connectedBackends().length > 1) {
          const tag = document.createElement('span');
          tag.className = 'backend-tag';
          tag.textContent = item.backendName;
          tag.title = `来自 backend ${item.backendName}`;
          el.querySelector('.agent-top').append(tag);
        }
        el.onclick = () => (isAgent ? selectAgent(item) : selectTerminal(item));
        el.oncontextmenu = event => showItemContextMenu(event, kind, item);
        return el;
      })
    );
    $('agentListCount').textContent = `已显示 ${items.length} / ${allItems.length}`;
    $('loadMoreAgents').hidden = items.length >= allItems.length;
    $('loadMoreAgents').disabled = items.length >= allItems.length;
  }
  async function loadAgentContexts(agents = state.agents) {
    await Promise.allSettled(
      agents.map(async agent => {
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
      })
    );
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
      requestBackend(backend.id, '/api/v1/terminals')
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
  function renderActivityBar() {
    const bar = $('activityBar'),
      agent = state.selectedKind === 'agent' ? state.agent : null,
      nodes = agent ? activityView.bar(state.activities.get(agent.agentId), agent.backendId) : [];
    bar.replaceChildren(...nodes);
    bar.hidden = !nodes.length;
  }
  function setAgentActivity(agentId, activity) {
    if (window.ActivityView.isBusy(activity)) state.activities.set(agentId, activity);
    else state.activities.delete(agentId);
    sessionKeyboard.setActivity(agentId, activity);
    refreshToolCards(agentId);
    renderAgentList();
    if (state.agent?.agentId === agentId) renderActivityBar();
  }
  function setAgentStatus(agentId, status) {
    const agent = state.agents.find(x => x.agentId === agentId);
    if (!agent) {
      void refreshAgents();
      return null;
    }
    // Every event reports the status, so an unchanged one must not rebuild the list for each delta.
    if (agent.status === status) return agent;
    agent.status = status;
    if (state.agent?.agentId === agentId) state.agent.status = status;
    sessionKeyboard.updateAgent(agent);
    renderAgentList();
    updateAgentHeader();
    if (state.agent?.agentId === agentId) {
      const picker = $('sendMode');
      if (status === 'streaming' || status === 'waiting_for_user') {
        if (picker.value === 'prompt') picker.value = 'follow-up';
      } else picker.value = 'prompt';
    }
    return agent;
  }
  function updateAgentHeader(agent = state.agent) {
    if (!agent) return;
    $('agentTitle').textContent = agentLabel(agent);
    $('agentStatus').textContent = agentSubtitle(agent);
    const badge = $('agentStateBadge');
    badge.textContent = agent.status;
    badge.className = `state-badge state-${agent.status}`;
    const usage = state.contexts.get(agent.agentId),
      panel = $('contextUsage');
    panel.hidden = false;
    $('contextText').textContent = `Context ${usageText(usage)} · ${costText(usage)}`;
    const percent = Math.min(100, Math.max(0, Number(usage?.percent) || 0));
    $('contextBar').style.width = `${percent}%`;
    panel.className = `context-usage ${usageLevel(usage)}`;
    renderActivityBar();
  }
  function showAgentView() {
    $('agentToolbar').hidden = false;
    $('terminalToolbar').hidden = true;
    $('terminalView').hidden = true;
    $('widgets').hidden = false;
    $('messages').hidden = false;
    $('prompt').hidden = false;
  }
  const loadTerminalStyle = () =>
    new Promise((resolve, reject) => {
      const id = 'xterm-styles',
        loaded = document.getElementById(id);
      if (loaded?.dataset.loaded === 'true') return resolve();
      const link = loaded || document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = '/vendor/xterm.css';
      link.onload = () => {
        link.dataset.loaded = 'true';
        resolve();
      };
      link.onerror = () => {
        link.remove();
        reject(Error('无法加载 /vendor/xterm.css'));
      };
      if (!loaded) document.head.append(link);
    });
  const loadTerminalScript = (id, src) =>
    new Promise((resolve, reject) => {
      const loaded = document.getElementById(id);
      if (loaded?.dataset.loaded === 'true') return resolve();
      const script = loaded || document.createElement('script');
      script.id = id;
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(Error(`无法加载 ${src}`));
      };
      if (!loaded) document.head.append(script);
    });
  function loadTerminalAssets() {
    if (window.Terminal && window.FitAddon?.FitAddon) return Promise.resolve();
    if (!state.terminalAssetsPromise)
      state.terminalAssetsPromise = (async () => {
        await Promise.all([loadTerminalStyle(), loadTerminalScript('xterm-script', '/vendor/xterm.js')]);
        await loadTerminalScript('xterm-fit-script', '/vendor/addon-fit.js');
        if (typeof window.Terminal !== 'function' || typeof window.FitAddon?.FitAddon !== 'function')
          throw Error('xterm.js 初始化失败');
      })().catch(error => {
        state.terminalAssetsPromise = null;
        throw error;
      });
    return state.terminalAssetsPromise;
  }
  async function ensureTerminalEmulator() {
    if (state.terminalEmulator) return state.terminalEmulator;
    await loadTerminalAssets();
    if (state.terminalEmulator) return state.terminalEmulator;
    const term = new window.Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 14,
        scrollback: 5000,
        theme: {background: '#111111', foreground: '#d8dee9', cursor: '#88c0d0'}
      }),
      fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('terminal'));
    term.onData(data => {
      if (state.terminalWs?.readyState === WebSocket.OPEN)
        state.terminalWs.send(JSON.stringify({type: 'input', data}));
    });
    term.onResize(size => {
      if (state.terminalWs?.readyState === WebSocket.OPEN)
        state.terminalWs.send(JSON.stringify({type: 'resize', cols: size.cols, rows: size.rows}));
    });
    state.resizeObserver = new ResizeObserver(() => {
      if (!$('terminalView').hidden)
        try {
          fit.fit();
        } catch {}
    });
    state.resizeObserver.observe($('terminalView'));
    state.terminalEmulator = term;
    state.fitAddon = fit;
    return term;
  }
  async function connectTerminalSocket(terminal) {
    state.terminalWs?.close();
    state.terminalWs = null;
    const terminalId = terminal.terminalId,
      attempt = ++state.terminalConnectAttempt;
    $('terminalStatus').textContent = `${terminal.cwd} · 正在加载 Terminal…`;
    try {
      const term = await ensureTerminalEmulator();
      if (
        attempt !== state.terminalConnectAttempt ||
        state.selectedKind !== 'terminal' ||
        state.terminal?.terminalId !== terminalId
      )
        return;
      term.reset();
      term.clear();
      $('terminalStatus').textContent = `${terminal.cwd} · 正在连接…`;
      const terminalBackend = backendOf(terminal.backendId);
      if (!terminalBackend || terminalBackend.status !== 'connected')
        throw Error(`Backend「${terminal.backendName || terminal.backendId}」未连接`);
      const ws = new WebSocket(
        terminalBackend.base.replace(/^http/, 'ws') +
          `/api/v1/terminals/${encodeURIComponent(terminal.remoteId)}/ws`,
        ['access-token.' + terminalBackend.token]
      );
      state.terminalWs = ws;
      ws.onopen = () => {
        if (ws !== state.terminalWs) return;
        requestAnimationFrame(() => {
          try {
            state.fitAddon.fit();
            ws.send(JSON.stringify({type: 'resize', cols: term.cols, rows: term.rows}));
            term.focus();
          } catch {}
        });
      };
      ws.onmessage = event => {
        if (ws !== state.terminalWs) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'snapshot') {
            term.reset();
            if (message.data) term.write(message.data);
            terminal.status = message.record.status;
            updateTerminalHeader();
            renderAgentList();
          } else if (message.type === 'output') term.write(message.data);
          else if (message.type === 'exit') {
            terminal.status = 'exited';
            terminal.exitCode = message.exitCode;
            updateTerminalHeader();
            renderAgentList();
            void refreshAgents();
          } else if (message.type === 'error') toast(message.message);
        } catch (error) {
          console.error(error);
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (ws === state.terminalWs && terminal.status === 'running')
          $('terminalStatus').textContent = `${terminal.cwd} · 连接已断开`;
      };
    } catch (error) {
      if (
        attempt === state.terminalConnectAttempt &&
        state.selectedKind === 'terminal' &&
        state.terminal?.terminalId === terminalId
      ) {
        $('terminalStatus').textContent = `${terminal.cwd} · Terminal 加载失败`;
        toast(`Terminal 加载失败：${error.message}`);
      }
    }
  }
  function updateTerminalHeader() {
    const terminal = state.terminal;
    if (!terminal) return;
    $('terminalTitle').textContent = terminal.title || 'Terminal';
    $('terminalStatus').textContent =
      `${terminal.cwd}${terminal.exitCode === undefined ? '' : ` · exit ${terminal.exitCode}`}`;
    const badge = $('terminalStateBadge');
    badge.textContent = terminal.status;
    badge.className = `state-badge state-${terminal.status}`;
  }
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
    const match =
      matchWorkspace(backend.workspaces, item.cwd) ||
      (state.workspace?.backendId === item.backendId ? state.workspace : backend.workspaces[0]);
    if (!match) {
      clearWorkspaceSelection();
      return;
    }
    if (state.workspace && workspaceKey(state.workspace) === workspaceKey(match)) return;
    await selectWorkspace(workspaceKey(match));
  }
  async function selectTerminal(terminal, openView = true) {
    state.selectedKind = 'terminal';
    state.terminal = terminal;
    localStorage.rpTerminalId = terminal.terminalId;
    localStorage.rpSelectedKind = 'terminal';
    $('agentToolbar').hidden = true;
    $('terminalToolbar').hidden = false;
    $('terminalView').hidden = false;
    $('widgets').hidden = true;
    $('messages').hidden = true;
    $('prompt').hidden = true;
    updateTerminalHeader();
    renderAgentList();
    sendFocus();
    if (openView) navigateMobile('agent');
    void syncWorkspaceForSelection(terminal);
    void connectTerminalSocket(terminal);
  }
  const autoBindNewSession = agent => sessionKeyboard.autoBind(agent.agentId);
  async function startAgent(relativePath) {
    $('contextMenu').hidden = true;
    $('agentCwd').value = relativePath;
    await createAgent();
  }
  async function openTerminal(relativePath) {
    if (!state.workspace) return toast('请先选择 Workspace');
    try {
      const backend = backendOf(state.workspace.backendId);
      const created = await postBackend(backend.id, '/api/v1/terminals', {
        workspaceId: state.workspace.id,
        relativeCwd: relativePath
      });
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
      await requestBackend(terminal.backendId, `/api/v1/terminals/${encodeURIComponent(terminal.remoteId)}`, {
        method: 'DELETE'
      });
      const backend = backendOf(terminal.backendId);
      if (backend)
        backend.terminals = backend.terminals.filter(item => item.terminalId !== terminal.terminalId);
      if (state.terminal?.terminalId === terminal.terminalId) clearTerminalSelection(terminal.backendId);
      syncSessionLists();
      toast('Terminal 已关闭');
    } catch (error) {
      toast(error.message);
    }
  }
  async function selectAgent(agent, openView = true) {
    if (state.agent?.agentId !== agent.agentId) cancelVoiceRecording();
    state.selectedKind = 'agent';
    state.terminalWs?.close();
    state.terminalWs = null;
    state.agent = agent;
    updateVoiceAvailability();
    localStorage.rpAgentId = agent.agentId;
    localStorage.rpSelectedKind = 'agent';
    showAgentView();
    updateAgentHeader();
    $('sendMode').value =
      agent.status === 'streaming' || agent.status === 'waiting_for_user' ? 'follow-up' : 'prompt';
    if (openView) navigateMobile('agent');
    void syncWorkspaceForSelection(agent);
    if (ownsPath(state.workspace, agent))
      $('agentCwd').value = relativeTo(clean(agent.cwd), clean(state.workspace.rootPath));
    $('messages').replaceChildren();
    closeCommandPicker();
    state.commands = [];
    state.commandsAgentId = null;
    renderQueueBar();
    try {
      loadTimeline(agent);
      await loadSessionIdentity();
    } catch (error) {
      addCard('加载消息失败', error.message, 'error', true);
    }
    renderAgentList();
    const backend = backendOf(agent.backendId);
    if (backend?.ws?.readyState === WebSocket.OPEN)
      backend.ws.send(JSON.stringify({type: 'subscribe_drafts'}));
  }
  async function loadSessionIdentity() {
    if (!state.agent) return;
    const session = await requestAgent(state.agent.agentId, '/session?summary=true');
    state.agent.sessionName = session.sessionName || undefined;
    state.contexts.set(state.agent.agentId, sessionUsage(session));
    renderAgentList();
    updateAgentHeader();
  }

  function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map(part =>
        part?.type === 'text'
          ? part.text
          : part?.type === 'thinking'
            ? part.thinking || part.text
            : part?.type === 'toolCall'
              ? `${part.name || 'Tool'}\n${JSON.stringify(part.arguments || {}, null, 2)}`
              : ''
      )
      .filter(Boolean)
      .join('\n');
  }
  // Pi persists failed provider responses as empty assistant messages with
  // stopReason="error" and errorMessage. They have no content to render, so
  // handle the error metadata explicitly instead of silently dropping them.
  function renderCardBody(body, content, markdown = false) {
    const value = String(content ?? '');
    body.classList.toggle('markdown', markdown);
    if (markdown && window.marked && window.DOMPurify) {
      body.innerHTML = DOMPurify.sanitize(marked.parse(value, {gfm: true, breaks: true}));
      for (const link of body.querySelectorAll('a')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    } else body.textContent = value;
  }
  // The transcript only shows what a human reads linearly: prompts, answers, thinking, dialogs and errors.
  // Everything else (tool calls, bash output, retries, extension chatter) is folded into one collapsed
  // activity group per stretch of activity, whose summary tracks the most recent item while it streams.
  const TRANSCRIPT_KINDS = new Set(['user', 'assistant', 'thinking', 'dialog', 'voice', 'error']);
  function activityGroup(target) {
    const last = target.lastElementChild;
    if (last?.classList?.contains('activity-group')) return last;
    const group = document.createElement('details');
    group.className = 'msg activity-group';
    const summary = document.createElement('summary'),
      text = document.createElement('span'),
      count = document.createElement('span'),
      time = document.createElement('span');
    text.className = 'summary-text';
    text.textContent = '活动';
    count.className = 'activity-count';
    time.className = 'event-time';
    summary.append(text, count, time);
    const items = document.createElement('div');
    items.className = 'activity-items';
    group.append(summary, items);
    target.append(group);
    return group;
  }
  const eventTime = timestamp => {
    const value = Number(timestamp);
    return Number.isFinite(value) && value > 0
      ? new Date(value > 1e12 ? value : value * 1000).toLocaleTimeString()
      : '';
  };
  function updateActivityGroup(group, title, timestamp) {
    const count = group.querySelector('.activity-items').childElementCount;
    group.querySelector('.summary-text').textContent = title || '活动';
    group.querySelector('.activity-count').textContent = `${count} 项`;
    const time = eventTime(timestamp);
    if (time) group.querySelector('.event-time').textContent = time;
  }
  /** A transcript card that is not yet in the page; see addCard and placeCard. */
  function createCard(title, content, kind = 'system', open = false, timestamp) {
    const derivedTitle = !title,
      details = document.createElement('details');
    details.className = `msg ${kind}${derivedTitle ? ' derived-title' : ''}`;
    details.open = open;
    const summary = document.createElement('summary'),
      summaryText = document.createElement('span'),
      summaryLabel = document.createElement('span');
    summaryText.className = 'summary-text';
    summaryText.textContent = title || String(content).trim() || kind;
    summaryLabel.className = 'summary-label';
    summaryLabel.textContent = kind === 'user' ? 'You' : kind === 'assistant' ? 'Assistant' : kind;
    summary.append(summaryText, summaryLabel);
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = eventTime(timestamp);
    summary.append(time);
    const body = document.createElement('div');
    body.className = 'msg-content';
    renderCardBody(body, content, kind === 'assistant');
    details.append(summary, body);
    return {details, summary, summaryText, summaryTime: time, body, kind, content: String(content ?? '')};
  }
  /** Append a card to the transcript, folding non-transcript kinds into the trailing activity group. */
  function placeCard(card, target = $('messages'), timestamp) {
    const group = TRANSCRIPT_KINDS.has(card.kind) ? null : activityGroup(target);
    (group ? group.querySelector('.activity-items') : target).append(card.details);
    card.group = group;
    if (group) updateActivityGroup(group, card.summaryText.textContent, timestamp);
    return card;
  }
  function addCard(title, content, kind = 'system', open = false, timestamp, target = $('messages')) {
    const card = placeCard(createCard(title, content, kind, open, timestamp), target, timestamp);
    if (target === $('messages')) $('messages').scrollTop = $('messages').scrollHeight;
    return card;
  }
  /** Pi 0.99+ reports the recorded execution time of a finished tool call. */
  function setToolDuration(card, durationMs) {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) return;
    const label =
      card.durationLabel ||
      (card.durationLabel = Object.assign(document.createElement('span'), {className: 'tool-duration'}));
    label.textContent =
      value < 1000
        ? `${Math.round(value)} ms`
        : value < 60000
          ? `${(value / 1000).toFixed(1)} s`
          : `${Math.floor(value / 60000)} 分 ${Math.round((value % 60000) / 1000)} 秒`;
    card.summaryTime.before(label);
  }
  /** Live output of a `!` command; once recorded it reappears as a timeline item. */
  function updateBashCard(ev, timestamp) {
    const key = ev.id || 'default';
    let card = state.bashCards.get(key);
    if (!card) {
      card = addCard(ev.command ? `$ ${ev.command}` : '$ bash', '', 'tool', false, timestamp);
      card.content = '';
      state.bashCards.set(key, card);
    }
    if (ev.type === 'bash_execution_update') card.content += String(ev.delta || '');
    else if (ev.type === 'bash_execution_end') {
      state.bashCards.delete(key);
      if (!ev.isError) {
        removeCard(card);
        return;
      }
      // A run that failed to start was never recorded; keep it visible.
      card.details.classList.add('tool-error');
      card.summaryText.textContent = `✗ $ ${ev.command || 'bash'} · ${ev.errorMessage || '失败'}`;
    }
    renderCardBody(card.body, card.content);
    card.summaryTime.textContent = eventTime(timestamp);
    if (card.group) updateActivityGroup(card.group, card.summaryText.textContent, timestamp);
  }
  function removeCard(card) {
    card.details.remove();
    const group = card.group;
    if (!group) return;
    if (group.querySelector('.activity-items').childElementCount) refreshActivityGroup(group);
    else group.remove();
  }
  /** A group's summary shows its newest card, which may just have been replaced or removed. */
  function refreshActivityGroup(group) {
    const last = group.querySelector('.activity-items').lastElementChild;
    updateActivityGroup(group, last?.querySelector('.summary-text')?.textContent);
  }

  // ---- Timeline of the viewed Agent. Items never change. Focusing the Agent makes the server send
  // a snapshot (focus_state), then append items in order on the same socket; anything that is not an
  // append makes it send timeline_reset, and the view takes a new snapshot. A tool's call and result
  // are two items shown as one card, and whether a call is running comes from the Agent's activity.
  // Large bodies load when a card is expanded; they never change, so they are cached for good.
  const TIMELINE_PAGE = 50;
  const CARD_KIND = {
    user: 'user',
    assistant: 'assistant',
    thinking: 'thinking',
    error: 'error',
    bash: 'tool'
  };
  const formatSize = chars => (chars < 1024 ? `${chars} 字符` : `${(chars / 1024).toFixed(1)}K 字符`);
  const RESULT_MARK = {ok: '✓', error: '✗', cancelled: '⊘'};
  function itemTitle(item) {
    const detail = item.summary ? ` · ${item.summary}` : '';
    switch (item.kind) {
      case 'user':
      case 'assistant':
        return null;
      case 'bash':
        return `${RESULT_MARK[item.status] || ''} $ ${item.title}${detail}`;
      case 'tool_result': // Its call is not on this page.
        return `${RESULT_MARK[item.status] || ''} ${item.title}`;
      case 'thinking':
        return item.body === undefined ? `Thinking${detail}` : 'Thinking';
      case 'error':
        return 'LLM Error';
      default:
        return `${item.title || item.kind}${detail}`;
    }
  }
  function itemCard(item) {
    const lazy = item.body === undefined,
      card = createCard(
        itemTitle(item),
        lazy ? `展开以加载（${formatSize(item.size)}）` : item.body,
        CARD_KIND[item.kind] || (item.kind === 'tool_result' ? 'tool' : 'system'),
        item.kind === 'error',
        item.timestamp
      );
    card.item = item;
    card.details.dataset.itemId = item.id;
    card.details.classList.toggle('tool-error', item.status === 'error');
    if (item.durationMs !== undefined) setToolDuration(card, item.durationMs);
    if (lazy) card.details.addEventListener('toggle', () => void expandItem(card));
    return card;
  }
  async function expandItem(card) {
    if (!card.details.open || card.loaded) return;
    card.loaded = true;
    try {
      renderCardBody(card.body, await loadItemBody(card.item), card.item.kind === 'assistant');
    } catch (error) {
      card.loaded = false;
      renderCardBody(card.body, `加载失败：${error.message}`);
    }
  }
  async function loadItemBody(item) {
    const timeline = state.timeline,
      key = `${timeline.backendId}|${timeline.sessionId}|${item.id}`;
    if (state.itemBodies.has(key)) return state.itemBodies.get(key);
    const data = await requestAgent(
      timeline.agentId,
      `/sessions/${encodeURIComponent(timeline.sessionId)}/items/${encodeURIComponent(item.id)}`
    );
    state.itemBodies.set(key, data.body);
    // The browser's HTTP cache keeps everything; this only makes recent expansions instant.
    if (state.itemBodies.size > 200) state.itemBodies.delete(state.itemBodies.keys().next().value);
    return data.body;
  }

  // A tool card: its call, its result once recorded, and while it runs and is expanded, its output.
  const TOOL_MARK = {ok: '✓', error: '✗', running: '⏳', waiting: '⋯', unfinished: '⊘'};
  const TOOL_NOTE = {running: ' · 执行中', waiting: ' · 等待执行', unfinished: ' · 未完成'};
  const entryOf = itemId => itemId.slice(0, itemId.lastIndexOf('.'));
  /** ok/error once recorded; otherwise running, waiting (in the newest calls of a run going on) or unfinished. */
  function toolState(card) {
    if (card.result) return card.result.status;
    const timeline = state.timeline,
      activity = state.activities.get(timeline.agentId),
      phase = activity?.phase;
    if (phase?.kind === 'running_tools' && phase.tools.some(tool => tool.toolCallId === card.call.toolCallId))
      return 'running';
    return activity?.run && entryOf(card.call.id) === timeline.lastCallEntry ? 'waiting' : 'unfinished';
  }
  function toolCard(call) {
    const card = createCard(call.title, '', 'tool', false, call.timestamp);
    card.call = card.item = call;
    card.details.dataset.itemId = call.id;
    card.details.addEventListener('toggle', () => void expandTool(card));
    return card;
  }
  function updateToolCard(card) {
    const status = toolState(card),
      {call, result} = card;
    card.summaryText.textContent = `${TOOL_MARK[status]} ${call.title}${call.summary ? ` · ${call.summary}` : ''}${TOOL_NOTE[status] || ''}`;
    card.details.classList.toggle('tool-error', status === 'error');
    if (result?.durationMs !== undefined) setToolDuration(card, result.durationMs);
    if (card.group) refreshActivityGroup(card.group);
    if (card.details.open) void expandTool(card);
  }
  /** Refresh the calls still without a result, whose state follows the Agent's activity. */
  function refreshToolCards(agentId) {
    if (state.timeline?.agentId !== agentId) return;
    for (const card of state.timeline.toolCards.values()) if (!card.result) updateToolCard(card);
  }
  function renderToolBody(card) {
    const head = card.args ?? '加载中…',
      tail = card.result
        ? `— 结果 —\n${card.resultText ?? '加载中…'}`
        : card.output !== undefined
          ? `— 输出 —\n${card.output}`
          : '';
    renderCardBody(card.body, [head, tail].filter(Boolean).join('\n\n'));
  }
  /** Expanding loads the call's and result's bodies; expanding a running call also watches its output. */
  async function expandTool(card) {
    const watch = card.details.open && toolState(card) === 'running';
    if (watch !== !!card.watching) {
      card.watching = watch;
      sendFocused({type: watch ? 'watch' : 'unwatch', toolCallId: card.call.toolCallId});
    }
    if (!card.details.open) return;
    renderToolBody(card);
    try {
      if (card.args === undefined) card.args = card.call.body ?? (await loadItemBody(card.call));
      if (card.result && card.resultText === undefined)
        card.resultText = card.result.body ?? (await loadItemBody(card.result));
    } catch (error) {
      renderCardBody(card.body, `加载失败：${error.message}`);
      return;
    }
    renderToolBody(card);
  }
  function applyToolOutput(message) {
    const card = state.timeline.toolCards.get(message.toolCallId);
    if (!card || card.result) return;
    card.output = message.output;
    if (card.details.open) renderToolBody(card);
  }

  /** Add items in order: a result joins its call's card, everything else gets a card of its own. */
  function placeItems(items, target) {
    const timeline = state.timeline;
    for (const item of items) {
      const call = item.kind === 'tool_result' ? timeline.toolCards.get(item.toolCallId) : undefined;
      if (call) {
        call.result = item;
        timeline.cards.set(item.id, call);
        updateToolCard(call);
        continue;
      }
      const card = item.kind === 'tool_call' ? toolCard(item) : itemCard(item);
      timeline.cards.set(item.id, card);
      placeCard(card, target, item.timestamp);
      if (item.kind === 'tool_call') {
        timeline.toolCards.set(item.toolCallId, card);
        updateToolCard(card);
      }
    }
  }
  function renderTimelinePage(page, prepend) {
    const timeline = state.timeline,
      box = $('messages'),
      fragment = document.createDocumentFragment();
    if (!prepend) {
      timeline.cards.clear();
      timeline.toolCards.clear();
      const calls = page.items.filter(item => item.kind === 'tool_call');
      timeline.lastCallEntry = calls.length ? entryOf(calls[calls.length - 1].id) : null;
    }
    placeItems(page.items, fragment);
    if (prepend) {
      box.querySelector('#messageHistoryControls')?.remove();
      box.prepend(fragment);
      timeline.items = [...page.items, ...timeline.items];
    } else {
      clearLiveCards();
      state.optimistic = [];
      box.replaceChildren(fragment);
      timeline.items = [...page.items];
      if (!page.items.length) box.innerHTML = '<div class="empty">尚无消息</div>';
    }
    timeline.start = page.start;
    updateMessageHistoryControl();
  }
  function saveTimelineCache() {
    const timeline = state.timeline;
    state.timelineCache.delete(timeline.agentId);
    state.timelineCache.set(timeline.agentId, {
      sessionId: timeline.sessionId,
      items: timeline.items,
      start: timeline.start
    });
    if (state.timelineCache.size > 20) state.timelineCache.delete(state.timelineCache.keys().next().value);
  }
  /**
   * Show an Agent: its cached timeline at once, then the snapshot the server answers `focus` with.
   * Until that arrives, detail messages are older than it and are ignored.
   */
  function loadTimeline(agent) {
    const timeline = {
      agentId: agent.agentId,
      backendId: agent.backendId,
      sessionId: null,
      cards: new Map(),
      toolCards: new Map(),
      lastCallEntry: null,
      items: [],
      start: 0,
      ready: false
    };
    state.timeline = timeline;
    discardStreams();
    const box = $('messages'),
      cached = state.timelineCache.get(agent.agentId);
    if (cached) {
      timeline.sessionId = cached.sessionId;
      renderTimelinePage(cached, false);
      box.scrollTop = box.scrollHeight;
    } else box.innerHTML = '<div class="empty">正在加载…</div>';
    if (!sendFocus(true) && !cached) box.innerHTML = '<div class="empty">等待连接 backend…</div>';
  }
  /** Ask for a new snapshot, e.g. when the branch changed. */
  function refocus() {
    if (!state.timeline) return;
    state.timeline.ready = false;
    sendFocus(true);
  }
  function showSnapshot(message) {
    const timeline = state.timeline,
      box = $('messages');
    timeline.sessionId = message.sessionId;
    timeline.snapshots = (timeline.snapshots || 0) + 1;
    renderTimelinePage(message.page, false);
    timeline.ready = true;
    applyLive(message.live);
    restoreExtensionRequests(message.agentId, {dialogRequests: message.dialogRequests || []});
    saveTimelineCache();
    box.scrollTop = box.scrollHeight;
  }
  async function loadOlderItems(limit = TIMELINE_PAGE) {
    const timeline = state.timeline;
    if (!timeline?.ready || !timeline.items.length) return;
    const box = $('messages'),
      snapshot = timeline.snapshots;
    const page = await requestAgent(
      timeline.agentId,
      `/timeline?limit=${limit}&before=${encodeURIComponent(timeline.items[0].id)}`
    );
    // An older page belongs to the snapshot it was asked for.
    if (state.timeline !== timeline || timeline.snapshots !== snapshot) return;
    const oldHeight = box.scrollHeight,
      oldTop = box.scrollTop;
    if (page.sessionId !== timeline.sessionId) return refocus();
    renderTimelinePage(page, true);
    box.scrollTop = oldTop + (box.scrollHeight - oldHeight);
    saveTimelineCache();
  }
  function updateMessageHistoryControl() {
    $('messageHistoryControls')?.remove();
    const timeline = state.timeline;
    if (!timeline || timeline.start <= 0) return;
    const controls = document.createElement('div');
    controls.id = 'messageHistoryControls';
    controls.className = 'message-history-controls';
    const older = document.createElement('button');
    older.id = 'loadOlderMessages';
    older.type = 'button';
    older.textContent = `加载更早的对话（还有 ${timeline.start} 项）`;
    older.onclick = () => loadOlderItems().catch(error => toast(error.message));
    const all = document.createElement('button');
    all.id = 'loadAllMessages';
    all.type = 'button';
    all.textContent = '加载全部对话';
    all.onclick = async () => {
      all.disabled = older.disabled = true;
      all.textContent = '正在加载全部对话…';
      try {
        while (state.timeline === timeline && timeline.start > 0) await loadOlderItems(500);
      } catch (error) {
        toast(error.message);
      } finally {
        all.disabled = older.disabled = false;
        all.textContent = '加载全部对话';
      }
    };
    controls.append(older, all);
    $('messages').prepend(controls);
  }
  function applyItems(message) {
    const timeline = state.timeline,
      box = $('messages');
    if (message.clearLive) clearLiveCards();
    if (!message.items.length) return;
    box.querySelector('.empty')?.remove();
    for (const card of state.optimistic.splice(0)) removeCard(card);
    const calls = message.items.filter(item => item.kind === 'tool_call');
    if (calls.length) timeline.lastCallEntry = entryOf(calls[calls.length - 1].id);
    placeItems(message.items, box);
    timeline.items.push(...message.items);
    // Older calls without a result are no longer the newest: they did not finish.
    if (calls.length) refreshToolCards(timeline.agentId);
    saveTimelineCache();
    box.scrollTop = box.scrollHeight;
  }
  /** Messages of the focused Agent's detail stream, and its events that add to the transcript. */
  function handleDetail(message) {
    const timeline = state.timeline;
    if (!timeline || timeline.agentId !== message.agentId || state.selectedKind !== 'agent') return;
    if (message.type === 'focus_state') return showSnapshot(message);
    if (message.type === 'focus_error') {
      addCard('加载消息失败', message.error?.message || '', 'error', true);
      return;
    }
    if (!timeline.ready) return; // Older than the snapshot on its way, which includes it.
    if (message.type === 'agent_event') renderTranscriptEvent(message);
    else if (message.type === 'delta') appendDelta(message.kind, message.delta);
    else if (message.type === 'items') applyItems(message);
    else if (message.type === 'timeline_reset') refocus();
    else if (message.type === 'tool_output') applyToolOutput(message);
  }

  // ---- Streamed text of the message being generated. Its cards stay until the server
  // reports the message recorded (`items` with clearLive) and its timeline items replace them.
  function applyLive(live) {
    clearLiveCards();
    if (live?.thinking) appendDelta('thinking', live.thinking);
    if (live?.text) appendDelta('text', live.text);
  }
  function appendDelta(kind, delta) {
    const stream =
      kind === 'text'
        ? ensureStream('assistant', null, 'assistant')
        : ensureStream('thinking', 'Thinking', 'thinking');
    stream.content += delta || '';
    scheduleStreamPaint(stream);
  }
  function ensureStream(key, title, kind) {
    if (!state.streams.has(key)) {
      $('messages').querySelector('.empty')?.remove();
      const card = addCard(title, '', kind, true);
      card.renderFrame = null;
      state.streams.set(key, card);
      state.liveCards.push(card);
    }
    return state.streams.get(key);
  }
  // Parsing and sanitizing the complete accumulated Markdown for every tiny
  // provider delta is O(n²) and can leave the browser minutes behind the agent.
  // Paint plain text at most once per animation frame and parse Markdown once
  // when the message finishes.
  function paintStream(card) {
    card.renderFrame = null;
    card.body.textContent = card.content;
    card.summaryText.textContent = (card.content.trim().split('\n')[0] || card.kind || 'Assistant').slice(
      0,
      160
    );
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  function scheduleStreamPaint(card) {
    if (card.renderFrame === null) card.renderFrame = requestAnimationFrame(() => paintStream(card));
  }
  /** The run ended: render the streamed Markdown once while waiting for the recorded items. */
  function finalizeAgentStreams() {
    for (const [key, card] of state.streams) {
      if (card.renderFrame !== null) cancelAnimationFrame(card.renderFrame);
      card.renderFrame = null;
      renderCardBody(card.body, card.content, key === 'assistant');
      card.summaryText.textContent = (card.content.trim().split('\n')[0] || key).slice(0, 160);
    }
    state.streams.clear();
  }
  function stopStreams() {
    for (const card of state.streams.values())
      if (card.renderFrame !== null && card.renderFrame !== undefined) cancelAnimationFrame(card.renderFrame);
    state.streams.clear();
  }
  function clearLiveCards() {
    stopStreams();
    for (const card of state.liveCards.splice(0)) card.details.remove();
  }
  /** Forget all live state; the caller replaces the transcript. */
  function discardStreams() {
    stopStreams();
    state.liveCards = [];
    state.bashCards.clear();
  }
  function extensionRequest(agentId, ev, timestamp) {
    if ($(`extension-request-${ev.requestId}`)) return;
    $('messages').querySelector('.empty')?.remove();
    const card = addCard(
      ev.title || `Extension ${ev.kind}`,
      ev.message || ev.placeholder || ev.prefill || '',
      'dialog',
      true,
      timestamp
    );
    const controls = document.createElement('div');
    controls.className = 'dialog-actions';
    controls.id = `extension-request-${ev.requestId}`;
    const send = async value => {
      try {
        await postAgent(agentId, '/extension-response', {requestId: ev.requestId, value});
        controls.replaceChildren(document.createTextNode('已响应'));
      } catch (e) {
        toast(e.message);
      }
    };
    if (ev.kind === 'select')
      for (const option of ev.options || []) {
        const b = document.createElement('button');
        b.textContent = option;
        b.onclick = () => send(option);
        controls.append(b);
      }
    else if (ev.kind === 'confirm') {
      for (const [label, value] of [
        ['否', false],
        ['是', true]
      ]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => send(value);
        controls.append(b);
      }
    } else {
      const input =
        ev.kind === 'editor' ? document.createElement('textarea') : document.createElement('input');
      input.value = ev.prefill || '';
      input.placeholder = ev.placeholder || '';
      const b = document.createElement('button');
      b.textContent = '提交';
      b.onclick = () => send(input.value);
      controls.append(input, b);
    }
    card.body.append(controls);
  }
  /** Steering and follow-up messages Pi has queued for the running turn. */
  function setAgentQueue(agentId, queue) {
    const value = {steering: queue?.steering || [], followUp: queue?.followUp || []};
    if (value.steering.length || value.followUp.length) state.queues.set(agentId, value);
    else state.queues.delete(agentId);
    if (state.selectedKind === 'agent' && state.agent?.agentId === agentId) renderQueueBar();
  }
  function renderQueueBar() {
    const queue = state.agent ? state.queues.get(state.agent.agentId) : null,
      bar = $('queueBar');
    if (!queue) {
      bar.hidden = true;
      $('queueItems').replaceChildren();
      return;
    }
    const parts = [];
    if (queue.steering.length) parts.push(`Steer ${queue.steering.length}`);
    if (queue.followUp.length) parts.push(`Follow-up ${queue.followUp.length}`);
    const preview = [...queue.steering, ...queue.followUp][0] || '';
    $('queueText').textContent =
      `排队中：${parts.join(' · ')}${preview ? ` — ${preview.replace(/\s+/g, ' ').slice(0, 60)}` : ''}`;
    const items = $('queueItems');
    items.replaceChildren();
    for (const [from, label, target] of [
      ['steering', 'Steer', 'Follow-up'],
      ['followUp', 'Follow-up', 'Steer']
    ]) {
      queue[from].forEach((text, index) => {
        const row = document.createElement('div');
        row.className = 'queue-item';
        const preview = document.createElement('span');
        preview.textContent = `${label}: ${text}`;
        preview.title = text;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `改为 ${target}`;
        button.onclick = async () => {
          const agentId = state.agent.agentId;
          button.disabled = true;
          try {
            await postAgent(agentId, '/queue/move', {from, index, expected: text});
          } catch (error) {
            toast(`切换失败：${error.message}`);
            try {
              setAgentQueue(agentId, await requestAgent(agentId, '/queue'));
            } catch {}
          } finally {
            button.disabled = false;
          }
        };
        row.append(preview, button);
        items.append(row);
      });
    }
    bar.hidden = false;
  }
  function restoreExtensionRequests(agentId, activity) {
    if (state.selectedKind !== 'agent' || state.agent?.agentId !== agentId || !activity?.dialogRequests)
      return;
    const requests = activity.dialogRequests,
      ids = new Set(requests.map(request => `extension-request-${request.requestId}`));
    for (const controls of $('messages').querySelectorAll('.dialog-actions')) {
      if (!ids.has(controls.id)) controls.replaceChildren(document.createTextNode('已结束'));
    }
    for (const request of requests) extensionRequest(agentId, request);
  }
  function stopVoiceAudio() {
    state.voiceAudio.generation++;
    for (const source of state.voiceAudio.sources) {
      try {
        source.stop();
      } catch {}
    }
    state.voiceAudio.sources.clear();
    state.voiceAudio.nextTime = 0;
    state.voiceAudio.playbackId = null;
    state.voiceAudio.backendId = null;
  }
  async function ensureAudioContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw Error('当前浏览器不支持音频播放');
    state.voiceAudio.context ??= new AudioContext();
    if (state.voiceAudio.context.state === 'suspended') await state.voiceAudio.context.resume();
    return state.voiceAudio.context;
  }
  function playVoiceChunk(event, backendId) {
    if (!state.voicePlaybackEnabled || !event.audio) return;
    const generation = state.voiceAudio.generation;
    state.voiceAudio.decodeChain = state.voiceAudio.decodeChain
      .then(async () => {
        const context = await ensureAudioContext();
        if (generation !== state.voiceAudio.generation) return;
        state.voiceAudio.playbackId = event.playbackId;
        state.voiceAudio.backendId = backendId;
        const raw = atob(event.audio),
          bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
        let buffer;
        if (event.encoding === 'mp3') buffer = await context.decodeAudioData(bytes.buffer.slice(0));
        else {
          const samples = new Float32Array(Math.floor(bytes.length / 2));
          for (let i = 0; i < samples.length; i++) {
            let value = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
            if (value & 0x8000) value -= 0x10000;
            samples[i] = value / 32768;
          }
          const rate = Number(event.sampleRate || 24000);
          buffer = context.createBuffer(1, samples.length, rate);
          buffer.copyToChannel(samples, 0);
        }
        if (generation !== state.voiceAudio.generation || state.voiceAudio.playbackId !== event.playbackId)
          return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const start = Math.max(context.currentTime + 0.03, state.voiceAudio.nextTime || 0);
        source.start(start);
        state.voiceAudio.nextTime = start + buffer.duration;
        state.voiceAudio.sources.add(source);
        source.onended = () => state.voiceAudio.sources.delete(source);
      })
      .catch(error => toast(`语音播放失败：${error.message}`));
  }
  function handleVoiceEvent(message) {
    const ev = message.event || {},
      selected = state.selectedKind === 'agent' && state.agent?.agentId === message.agentId,
      key = `voice-${resourceKey(message.backendId, ev.playbackId || message.agentId)}`;
    if (ev.type === 'voice_start') {
      if (state.voicePlaybackEnabled) void ensureAudioContext().catch(() => {});
      if (selected) {
        const c = ensureStream(key, '语音摘要', 'voice');
        c.content = '';
        renderCardBody(c.body, '正在生成语音摘要…', false);
      }
    } else if (ev.type === 'voice_summary_delta') {
      if (selected) {
        const c = ensureStream(key, '语音摘要', 'voice');
        c.content += ev.text || '';
        renderCardBody(c.body, c.content, false);
        c.summaryText.textContent = '语音摘要';
      }
    } else if (ev.type === 'voice_audio_chunk')
      playVoiceChunk({...ev, playbackId: resourceKey(message.backendId, ev.playbackId)}, message.backendId);
    else if (ev.type === 'voice_cancelled') {
      stopVoiceAudio();
    } else if (ev.type === 'voice_error') {
      if (selected) addCard('语音服务', ev.message || '语音生成失败', 'error', true);
    } else if (ev.type === 'voice_end') {
      if (selected) state.streams.delete(key);
    }
  }
  function updateVoiceButton() {
    const button = $('voicePlayback');
    button.textContent = state.voicePlaybackEnabled ? '语音已启用' : '启用语音';
    button.title = state.voicePlaybackEnabled ? '点击关闭 Agent 语音摘要' : '点击启用 Agent 语音摘要播放';
  }
  async function toggleVoicePlayback() {
    state.voicePlaybackEnabled = !state.voicePlaybackEnabled;
    localStorage.rpVoicePlayback = String(state.voicePlaybackEnabled);
    updateVoiceButton();
    if (state.voicePlaybackEnabled) {
      try {
        await ensureAudioContext();
        toast('Agent 完成后将播放语音摘要');
      } catch (error) {
        state.voicePlaybackEnabled = false;
        localStorage.rpVoicePlayback = 'false';
        updateVoiceButton();
        toast(error.message);
      }
    } else stopVoiceAudio();
  }
  function updateSottoDraft(voice) {
    if (state.voiceStream !== voice || state.agent?.agentId !== voice.agentId) return;
    const input = voice.input,
      text = [...voice.finals.values(), voice.partial].filter(Boolean).join(' ');
    if (text === voice.inserted) return;
    if (input.value.slice(voice.at, voice.at + voice.inserted.length) !== voice.inserted) {
      finishSottoStream(voice, true);
      toast('输入框内容已被修改，语音输入已停止；现有文字不会覆盖');
      return;
    }
    input.setRangeText(text, voice.at, voice.at + voice.inserted.length, 'end');
    voice.inserted = text;
  }
  function finishSottoStream(voice, abort = false, reason = '') {
    if (state.voiceStream !== voice) return;
    state.voiceStream = null;
    clearTimeout(voice.timer);
    voice.stream?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    voice.node?.disconnect();
    voice.source?.disconnect();
    voice.sink?.disconnect();
    if (voice.node?.port) voice.node.port.onmessage = null;
    if (voice.node) voice.node.onaudioprocess = null;
    if (voice.context) void voice.context.close().catch(() => {});
    if (voice.socket?.readyState === WebSocket.OPEN || voice.socket?.readyState === WebSocket.CONNECTING)
      voice.socket.close();
    $('voiceInput').disabled = false;
    $('voiceInput').classList.remove('recording');
    $('voiceInput').textContent = '🎙';
    $('voiceInput').title = '开始语音输入（输入框内 Alt+Shift+V）';
    if (
      abort &&
      voice.partial &&
      voice.input.value.slice(voice.at, voice.at + voice.inserted.length) === voice.inserted
    ) {
      const text = [...voice.finals.values()].filter(Boolean).join(' ');
      voice.input.setRangeText(text, voice.at, voice.at + voice.inserted.length, 'end');
    }
    if (reason) toast(reason);
  }
  function finishSottoAudio(voice) {
    if (state.voiceStream !== voice || voice.phase !== 'draining') return;
    if (voice.socket.readyState !== WebSocket.OPEN)
      return finishSottoStream(voice, true, '语音连接已断开，无法完成识别');
    voice.phase = 'finishing';
    voice.node?.disconnect();
    voice.socket.send(JSON.stringify({type: 'stop'}));
    clearTimeout(voice.timer);
    voice.timer = setTimeout(() => finishSottoStream(voice, true, '等待语音识别结果超时'), 12000);
  }
  function stopSottoStream(voice) {
    if (state.voiceStream !== voice) return;
    if (voice.phase === 'starting') return finishSottoStream(voice, true);
    if (voice.phase !== 'recording') return;
    voice.phase = 'draining';
    voice.source?.disconnect();
    voice.stream.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    $('voiceInput').classList.remove('recording');
    $('voiceInput').textContent = '…';
    $('voiceInput').disabled = true;
    // Keep accepting queued PCM until the worklet confirms that its final buffer was sent.
    if (voice.node?.port) {
      voice.timer = setTimeout(() => finishSottoStream(voice, true, '麦克风尾部音频处理超时'), 3000);
      voice.node.port.postMessage({type: 'flush'});
    } else finishSottoAudio(voice);
  }
  function sendSottoPcm(voice, pcm) {
    if (state.voiceStream !== voice || !['recording', 'draining'].includes(voice.phase)) return;
    if (voice.socket.readyState !== WebSocket.OPEN || voice.socket.bufferedAmount >= 500000)
      return finishSottoStream(voice, true, '实时语音连接中断或处理不过来，录音已停止');
    voice.socket.send(pcm);
  }
  async function startSottoStream() {
    if (state.voiceStream) return;
    if (!navigator.mediaDevices?.getUserMedia) return toast('当前浏览器不支持麦克风录音');
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return toast('当前浏览器不支持实时音频采集');
    const agentId = state.agent.agentId,
      input = $('input');
    // One owner from permission acquisition through final result. Cancelling invalidates pending awaits.
    const voice = {
      agentId,
      input,
      at: input.selectionStart,
      inserted: '',
      finals: new Map(),
      partial: '',
      phase: 'starting',
      stream: null,
      context: null,
      socket: null,
      timer: null,
      node: null,
      source: null,
      sink: null
    };
    state.voiceStream = voice;
    $('voiceInput').textContent = '…';
    $('voiceInput').title = '正在启动语音输入，点击取消';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      if (state.voiceStream !== voice) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      voice.stream = stream;
      stream.getTracks().forEach(track => {
        track.onended = () => finishSottoStream(voice, true, '麦克风已断开或录音权限被撤销');
      });
      const context = (voice.context = new Audio());
      voice.timer = setTimeout(() => finishSottoStream(voice, true, '启动实时语音服务超时'), 30000);
      if (context.audioWorklet && window.AudioWorkletNode)
        await context.audioWorklet.addModule('/voice-pcm.js');
      if (state.voiceStream !== voice) return;
      if (state.agent?.agentId !== agentId) throw Error('会话已切换');
      const backend = backendOf(state.agent.backendId);
      const {remoteId} = splitResourceKey(agentId);
      const url =
        backend.base.replace(/^http/, 'ws') + `/api/v1/agents/${encodeURIComponent(remoteId)}/transcribe/ws`;
      const socket = (voice.socket = new WebSocket(url, ['access-token.' + backend.token]));
      socket.onmessage = event => {
        if (state.voiceStream !== voice) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          if (voice.phase !== 'starting') return;
          try {
            socket.send(JSON.stringify({type: 'start', sample_rate: context.sampleRate, format: 'float32'}));
            voice.source = context.createMediaStreamSource(stream);
            voice.sink = context.createGain();
            voice.sink.gain.value = 0;
            if (context.audioWorklet && window.AudioWorkletNode) {
              voice.node = new AudioWorkletNode(context, 'voice-pcm');
              voice.node.port.onmessage = e =>
                e.data?.type === 'flushed' ? finishSottoAudio(voice) : sendSottoPcm(voice, e.data);
            } else {
              voice.node = context.createScriptProcessor(4096, 1, 1);
              voice.node.onaudioprocess = e =>
                sendSottoPcm(voice, new Float32Array(e.inputBuffer.getChannelData(0)).buffer);
            }
            voice.phase = 'recording';
            voice.source.connect(voice.node);
            voice.node.connect(voice.sink);
            voice.sink.connect(context.destination);
            void context
              .resume()
              .catch(error => finishSottoStream(voice, true, `无法启动麦克风：${error.message}`));
            clearTimeout(voice.timer);
            $('voiceInput').textContent = '■';
            $('voiceInput').title = '正在录音，点击停止（停顿不会结束录音）';
            $('voiceInput').classList.add('recording');
          } catch (error) {
            finishSottoStream(voice, true, `无法采集音频：${error.message}`);
          }
        } else if (msg.type === 'partial' && voice.phase === 'recording') {
          voice.partial = String(msg.text || '');
          updateSottoDraft(voice);
        } else if (msg.type === 'final') {
          // A final ends one sentence, not the recording. Only the user's stop ends capture.
          voice.finals.set(msg.segment, String(msg.text || ''));
          voice.partial = '';
          updateSottoDraft(voice);
        } else if (msg.type === 'error') {
          finishSottoStream(voice, true, `Sotto 语音识别：${msg.message || '未知错误'}`);
        }
      };
      socket.onerror = () => finishSottoStream(voice, true, '无法连接 Sotto 实时语音服务');
      socket.onclose = event => {
        const expected = voice.phase === 'finishing' && event.code === 1000;
        finishSottoStream(voice, !expected, expected ? '' : `实时语音连接意外断开（${event.code}）`);
      };
    } catch (error) {
      finishSottoStream(voice, true, `无法开始语音输入：${error.message}`);
    }
  }
  async function toggleVoiceInput() {
    if (state.voiceStream) return stopSottoStream(state.voiceStream);
    if ($('voiceInput').disabled) return;
    if (!state.voiceSttEnabled) return toast('服务端未启用语音识别');
    if (!state.agent) return toast('请先选择 Agent');
    if (backendOf(state.agent.backendId)?.statusInfo?.sottoStt?.enabled) return startSottoStream();
    if (state.mediaRecorder) {
      if (state.mediaRecorder.state === 'recording') {
        $('voiceInput').disabled = true;
        state.mediaRecorder.stop();
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      return toast('当前浏览器不支持麦克风录音');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true}),
        preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type =>
          MediaRecorder.isTypeSupported(type)
        );
      state.mediaStream = stream;
      state.mediaChunks = [];
      state.mediaRecorder = new MediaRecorder(stream, preferred ? {mimeType: preferred} : undefined);
      state.mediaRecorder.ondataavailable = event => {
        if (event.data.size) state.mediaChunks.push(event.data);
      };
      state.mediaAgentId = state.agent.agentId;
      state.mediaRecorder.onstop = () => void transcribeVoice();
      state.mediaRecorder.start(250);
      $('voiceInput').textContent = '■';
      $('voiceInput').title = '停止并识别';
      $('voiceInput').classList.add('recording');
      state.mediaTimer = setTimeout(() => {
        if (state.mediaRecorder?.state === 'recording') {
          $('voiceInput').disabled = true;
          state.mediaRecorder.stop();
        }
      }, 60000);
    } catch (error) {
      state.mediaStream?.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
      state.mediaRecorder = null;
      state.mediaChunks = [];
      state.mediaAgentId = null;
      $('voiceInput').disabled = false;
      toast(`无法录音：${error.message}`);
    }
  }
  async function transcribeVoice() {
    clearTimeout(state.mediaTimer);
    const recorder = state.mediaRecorder,
      mime = recorder?.mimeType || 'audio/webm',
      blob = new Blob(state.mediaChunks, {type: mime}),
      agentId = state.mediaAgentId;
    state.mediaStream?.getTracks().forEach(track => track.stop());
    state.mediaRecorder = null;
    state.mediaStream = null;
    state.mediaChunks = [];
    state.mediaAgentId = null;
    $('voiceInput').textContent = '…';
    $('voiceInput').disabled = true;
    $('voiceInput').classList.remove('recording');
    if (!agentId) {
      $('voiceInput').textContent = '🎙';
      $('voiceInput').disabled = false;
      return;
    }
    const {backendId, remoteId} = splitResourceKey(agentId),
      transcribeBackend = backendOf(backendId);
    if (!transcribeBackend) {
      $('voiceInput').textContent = '🎙';
      $('voiceInput').disabled = false;
      return toast('该 Session 的 backend 已断开');
    }
    try {
      const response = await fetch(
        transcribeBackend.base + `/api/v1/agents/${encodeURIComponent(remoteId)}/transcribe`,
        {
          method: 'POST',
          headers: {
            ...(transcribeBackend.token ? {Authorization: `Bearer ${transcribeBackend.token}`} : {}),
            'Content-Type': mime,
            'X-Audio-Filename': mime.includes('mp4') ? 'recording.m4a' : 'recording.webm'
          },
          body: blob
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error?.message || `HTTP ${response.status}`);
      const text = body.data?.text?.trim();
      if (text) {
        const input = $('input'),
          prefix = input.value && !/\s$/.test(input.value) ? ' ' : '';
        input.value += prefix + text;
        input.focus();
        toast('语音已转换为文字');
      } else toast('没有识别到语音');
    } catch (error) {
      toast(`语音识别失败：${error.message}`);
    } finally {
      $('voiceInput').textContent = '🎙';
      $('voiceInput').disabled = false;
      $('voiceInput').title = '开始语音输入（输入框内 Alt+Shift+V）';
    }
  }
  const handledDrafts = new Set();
  function handleDraftEvent(message) {
    const draft = message.draft,
      backend = backendOf(message.backendId);
    if (!draft || typeof draft.text !== 'string' || !backend) return;
    const ack = () => {
      handledDrafts.add(draft.id);
      if (handledDrafts.size > 200) handledDrafts.delete(handledDrafts.values().next().value);
      if (backend.ws?.readyState === WebSocket.OPEN)
        backend.ws.send(JSON.stringify({type: 'draft_ack', id: draft.id}));
    };
    if (handledDrafts.has(draft.id)) {
      ack();
      return;
    }
    try {
      // The voice client cannot select a session: only the input currently shown on this backend is changed.
      if (state.selectedKind !== 'agent' || !state.agent || state.agent.backendId !== backend.id) return;
      const input = $('input');
      if (draft.mode === 'replace') input.value = draft.text;
      else input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + draft.text;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollTop = input.scrollHeight;
      toast('语音输入已写入输入框');
      ack();
    } catch (error) {
      toast(`语音输入失败：${error.message}`);
    }
  }
  function handleAgentEvent(message) {
    if (message.type === 'draft_event') {
      handleDraftEvent(message);
      return;
    }
    if (message.type === 'subscribed_drafts') return;
    if (message.type === 'voice_event') {
      handleVoiceEvent(message);
      return;
    }
    if (message.type === 'subscribed_all') {
      const backend = backendOf(message.backendId);
      if (backend && Number.isFinite(message.serverTime))
        backend.clockOffset = message.serverTime - Date.now();
      return;
    }
    if (message.type === 'agent_state') {
      sessionKeyboard.updateAgent({...message.state, agentId: message.agentId});
      setAgentStatus(message.agentId, message.state.status);
      setAgentQueue(message.agentId, message.state.activity?.queue);
      setAgentActivity(message.agentId, message.state.activity);
      restoreExtensionRequests(message.agentId, message.state.activity);
      return;
    }
    // The focused Agent's detail stream; see handleDetail.
    if (
      ['focus_state', 'focus_error', 'delta', 'items', 'timeline_reset', 'tool_output'].includes(message.type)
    ) {
      handleDetail(message);
      return;
    }
    if (message.type !== 'agent_event') return;
    const ev = message.event || {},
      selected = state.selectedKind === 'agent' && state.agent?.agentId === message.agentId;
    let eventAgent = state.agents.find(x => x.agentId === message.agentId);
    // Viewing an Agent loads its backend; that is not activity and must not reorder the list.
    if (
      eventAgent &&
      Number(message.timestamp) > 0 &&
      ev.type !== 'agent_loaded' &&
      ev.type !== 'agent_unloaded'
    )
      eventAgent.lastActiveAt = new Date(Number(message.timestamp)).toISOString();
    // Every event carries the authoritative status, including dialog waits.
    if (message.status) eventAgent = setAgentStatus(message.agentId, message.status) || eventAgent;
    if (ev.type === 'queue_update') {
      setAgentQueue(message.agentId, ev);
      return;
    }
    if (ev.type === 'activity_changed') {
      setAgentActivity(message.agentId, ev.activity);
      return;
    }
    if (ev.type === 'agent_unloaded') {
      setAgentStatus(message.agentId, 'unloaded');
      setAgentQueue(message.agentId, null);
      setAgentActivity(message.agentId, null);
      restoreExtensionRequests(message.agentId, {dialogRequests: []});
      return;
    }
    if (ev.type === 'agent_end') {
      if (!ev.willRetry) {
        if (selected) finalizeAgentStreams();
        notifyComplete(
          eventAgent || {agentId: message.agentId},
          Math.floor(Number(message.timestamp) / 1000)
        );
        if (eventAgent) void loadAgentContexts([eventAgent]);
      }
    } else if (ev.type === 'agent_settled') {
      if (eventAgent) void loadAgentContexts([eventAgent]);
    } else if (ev.type === 'session_info_changed') {
      if (eventAgent) eventAgent.sessionName = ev.name || undefined;
      if (selected) state.agent.sessionName = ev.name || undefined;
      renderAgentList();
      if (selected) updateAgentHeader();
    }
    if (selected) handleDetail(message);
  }
  /** The part of an Agent event shown in the transcript of the Agent being viewed. */
  function renderTranscriptEvent(message) {
    const ev = message.event || {};
    if (ev.type === 'agent_start') $('messages').querySelector('.empty')?.remove();
    else if (
      ev.type === 'bash_execution_start' ||
      ev.type === 'bash_execution_update' ||
      ev.type === 'bash_execution_end'
    )
      updateBashCard(ev, message.timestamp);
    else if (ev.type === 'auto_retry_start' || ev.type === 'auto_retry_end')
      addCard(
        'Retry',
        ev.errorMessage || ev.finalError || `${ev.type}${ev.attempt ? ` · attempt ${ev.attempt}` : ''}`,
        'system',
        false,
        message.timestamp
      );
    else if (String(ev.type).startsWith('summarization_retry'))
      addCard(
        'Summarization Retry',
        ev.errorMessage || `${ev.type}${ev.attempt ? ` · ${ev.attempt}/${ev.maxAttempts}` : ''}`,
        'system',
        false,
        message.timestamp
      );
    else if (ev.type === 'extension_ui_request') extensionRequest(message.agentId, ev, message.timestamp);
    else if (ev.type === 'extension_ui_response')
      $(`extension-request-${ev.requestId}`)?.replaceChildren(document.createTextNode('已结束'));
    else if (ev.type === 'extension_ui_notify')
      addCard(ev.notificationType || '通知', ev.message, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_status') {
      ev.text ? state.extensionStatus.set(ev.key, ev.text) : state.extensionStatus.delete(ev.key);
      renderExtensionStatus();
    } else if (ev.type === 'extension_ui_widget') {
      ev.content ? state.widgets.set(ev.key, ev.content) : state.widgets.delete(ev.key);
      renderWidgets();
    } else if (ev.type === 'extension_ui_title') {
      state.agent.sessionName = ev.title;
      updateAgentHeader();
    } else if (ev.type === 'extension_ui_working_message') {
      ev.message ? state.extensionStatus.set('working', ev.message) : state.extensionStatus.delete('working');
      renderExtensionStatus();
    }
  }
  function renderExtensionStatus() {
    let row = $('extensionStatus');
    if (!state.extensionStatus.size) {
      row?.remove();
      return;
    }
    if (!row) {
      row = document.createElement('div');
      row.id = 'extensionStatus';
      row.className = 'status-row';
      $('widgets').after(row);
    }
    row.textContent = [...state.extensionStatus.values()].join(' · ');
  }
  function renderWidgets() {
    $('widgets').replaceChildren(
      ...[...state.widgets.entries()].map(([key, value]) => {
        const el = document.createElement('div');
        el.className = 'widget';
        el.dataset.key = key;
        el.textContent = Array.isArray(value)
          ? value.map(x => (typeof x === 'string' ? x : x.text || '')).join('\n')
          : String(value);
        return el;
      })
    );
  }

  /**
   * Tell each backend which of its Agents this page views, so only that one streams details.
   * `force` resends it for the viewed Agent, which answers with a fresh focus_state. Returns whether
   * the viewed Agent's backend was told.
   */
  function sendFocus(force = false) {
    const agent = state.selectedKind === 'agent' ? state.agent : null;
    let sent = false;
    for (const backend of connectedBackends()) {
      const target = agent?.backendId === backend.id ? agent.remoteId : null;
      if (backend.ws?.readyState !== WebSocket.OPEN) continue;
      if (backend.focused !== target || (force && target)) {
        backend.ws.send(JSON.stringify({type: 'focus', agentId: target}));
        backend.focused = target;
      }
      if (target) sent = true;
    }
    return sent;
  }
  function sendFocused(message) {
    const backend = backendOf(state.agent?.backendId);
    if (backend?.ws?.readyState === WebSocket.OPEN) backend.ws.send(JSON.stringify(message));
  }
  function connectSocket(backend) {
    if (!backend || backend.status !== 'connected') return;
    clearTimeout(backend.reconnectTimer);
    backend.manuallyClosed = true;
    const previous = backend.ws;
    backend.ws = null;
    previous?.close();
    backend.manuallyClosed = false;
    const ws = new WebSocket(backend.base.replace(/^http/, 'ws') + '/api/v1/ws', [
      'access-token.' + backend.token
    ]);
    backend.ws = ws;
    ws.onopen = () => {
      if (ws !== backend.ws) return;
      backend.reconnectAttempt = 0;
      backend.reconnecting = false;
      updateHeaderStatus();
      ws.send(JSON.stringify({type: 'subscribe_all'}));
      ws.send(JSON.stringify({type: 'subscribe_drafts'}));
      // Nothing is replayed: refocus and reload what may have changed while disconnected.
      backend.focused = undefined;
      if (state.selectedKind === 'agent' && state.agent?.backendId === backend.id) loadTimeline(state.agent);
      else sendFocus();
    };
    ws.onmessage = event => {
      if (ws !== backend.ws) return;
      try {
        const message = JSON.parse(event.data);
        if (typeof message.agentId === 'string') message.agentId = resourceKey(backend.id, message.agentId);
        message.backendId = backend.id;
        handleAgentEvent(message);
      } catch (error) {
        console.error(error);
      }
    };
    ws.onclose = () => {
      if (backend.ws !== ws || backend.manuallyClosed) return;
      backend.reconnecting = true;
      updateHeaderStatus();
      const delays = [1000, 2000, 4000, 8000, 15000, 30000],
        delay = delays[Math.min(backend.reconnectAttempt++, delays.length - 1)];
      backend.reconnectTimer = setTimeout(() => connectSocket(backend), delay);
    };
    ws.onerror = () => {};
  }
  function notificationUnavailableReason() {
    if (!window.isSecureContext) return '浏览器通知需要 HTTPS；仅 localhost 可使用 HTTP';
    if (!('Notification' in window) || typeof Notification.requestPermission !== 'function')
      return '当前浏览器不支持系统通知';
    return '';
  }
  function updateNotificationButton() {
    const button = $('notifications'),
      status = $('browserNotificationStatus'),
      unavailable = notificationUnavailableReason();
    // Keep the button clickable so unsupported/denied states can explain how to
    // fix the problem instead of silently ignoring the user's click.
    button.disabled = false;
    if (unavailable) {
      button.textContent = '通知不可用';
      button.title = unavailable;
      status.textContent = unavailable;
      return;
    }
    button.textContent =
      Notification.permission === 'granted'
        ? '通知已启用'
        : Notification.permission === 'denied'
          ? '通知已禁用'
          : '启用通知';
    button.title =
      Notification.permission === 'denied'
        ? '通知权限已被浏览器阻止，点击查看处理方式'
        : '启用所有 Agent 的完成通知';
    status.textContent =
      Notification.permission === 'granted'
        ? 'Agent 完成后会显示浏览器系统通知。'
        : Notification.permission === 'denied'
          ? '通知权限已被浏览器阻止。'
          : '尚未授予浏览器通知权限。';
  }
  async function enableNotifications() {
    const unavailable = notificationUnavailableReason();
    if (unavailable) return toast(unavailable);
    if (Notification.permission === 'denied')
      return toast('通知权限已被阻止，请在地址栏的网站权限中允许通知后刷新页面');
    try {
      const permission = await Notification.requestPermission();
      updateNotificationButton();
      toast(
        permission === 'granted'
          ? '已启用所有 Agent 的完成通知'
          : '未获得通知权限，请在浏览器的网站权限中开启'
      );
    } catch (error) {
      console.error('Unable to request notification permission', error);
      toast(`无法请求通知权限：${error?.message || '请检查浏览器的网站权限'}`);
    }
  }
  function notifyComplete(agent, timestamp) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const occurredAt = Number(timestamp) || Math.floor(Date.now() / 1000);
    try {
      new Notification('Agent 完成', {
        body: `${agentLabel(agent)} 已转为空闲\n本地时间：${new Date(occurredAt * 1000).toLocaleString()}\nUnix 时间戳：${occurredAt}`,
        timestamp: occurredAt * 1000,
        tag: `remote-pi-${agent.agentId}-${occurredAt}`
      });
    } catch (error) {
      console.error('Unable to show notification', error);
    }
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
    for (const id of [
      'mailNotificationEnabled',
      'mailAggregationDelay',
      'mailIncludeResponse',
      'mailIncludeSessionDetails',
      'mailCollabEscalations',
      'configSave'
    ]) {
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

  function sottoConfigBackend() {
    const workspaceBackend = backendOf(state.workspace?.backendId);
    return workspaceBackend?.status === 'connected' ? workspaceBackend : primaryBackend();
  }
  async function loadSottoSettings() {
    const backend = sottoConfigBackend();
    const requestId = ++state.sottoSettingsRequest;
    state.sottoBackendId = null;
    $('saveSotto').disabled = true;
    if (!backend) {
      $('sottoSettingsStatus').textContent = '请先连接 Backend';
      return;
    }
    $('sottoSettingsStatus').textContent = `正在读取「${backend.name}」的语音输入设置…`;
    try {
      const settings = await requestBackend(backend.id, '/api/v1/sotto-stt');
      if (requestId !== state.sottoSettingsRequest || !$('configDialog').open) return;
      state.sottoBackendId = backend.id;
      $('sottoEnabled').checked = settings.enabled;
      $('sottoEndpoint').value = settings.endpoint;
      $('saveSotto').disabled = false;
      $('sottoSettingsStatus').textContent =
        `设置属于 Backend「${backend.name}」。本机指它所在机器的 127.0.0.1，不是浏览器的 localhost。`;
    } catch (error) {
      if (requestId === state.sottoSettingsRequest)
        $('sottoSettingsStatus').textContent = `读取失败：${error.message}`;
    }
  }
  async function saveSottoSettings() {
    const backendId = state.sottoBackendId;
    if (!backendId) return toast('请先连接 Backend 并读取设置');
    $('saveSotto').disabled = true;
    try {
      const settings = await requestBackend(backendId, '/api/v1/sotto-stt', {
        method: 'PUT',
        body: JSON.stringify({enabled: $('sottoEnabled').checked, endpoint: $('sottoEndpoint').value.trim()})
      });
      const owner = backendOf(backendId);
      if (owner) applyVoiceStatus(owner, {...owner.statusInfo, sottoStt: settings});
      const statusInfo = await requestBackend(backendId, '/api/v1/system/status');
      const backend = backendOf(backendId);
      if (backend) applyVoiceStatus(backend, statusInfo);
      updateVoiceAvailability();
      $('sottoSettingsStatus').textContent = settings.enabled
        ? 'Sotto 已连通；输入框旁的麦克风可用，转写使用 Sotto 的同一个 ASR 实例。'
        : 'Sotto 语音输入已关闭。';
      toast('语音输入设置已保存');
    } catch (error) {
      toast(`Sotto 设置失败：${error.message}`);
    } finally {
      $('saveSotto').disabled = !backendOf(backendId);
    }
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
    void loadSottoSettings();
  }

  async function saveMailSettings() {
    if (!requireConnection()) return;
    const backend = backendOf(state.mailBackendId);
    if (!backend || primaryBackend()?.id !== backend.id)
      return toast('主 Backend 已变化，请等待邮件设置重新加载');
    if (!state.mailNotificationsAvailable) return toast('服务端未配置 MailDispatch');
    const delay = Number($('mailAggregationDelay').value);
    if (!Number.isInteger(delay) || delay < 0 || delay > 86400)
      return toast('聚合时间必须是 0 到 86400 之间的整数秒');
    $('configSave').disabled = true;
    try {
      const result = await postBackend(backend.id, '/api/v1/mail-notifications', {
        enabled: $('mailNotificationEnabled').checked,
        aggregationDelaySeconds: delay,
        includeResponse: $('mailIncludeResponse').checked,
        includeSessionDetails: $('mailIncludeSessionDetails').checked,
        collabEscalations: $('mailCollabEscalations').checked
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
    const dialog = $('modal'),
      body = $('modalBody');
    $('modalTitle').textContent = title;
    $('modalOk').textContent = okText;
    body.replaceChildren();
    const value = build(body);
    return new Promise(resolve => {
      const done = () => {
        dialog.removeEventListener('close', done);
        resolve(dialog.returnValue === 'default' ? (typeof value === 'function' ? value() : value) : null);
      };
      dialog.addEventListener('close', done);
      dialog.showModal();
    });
  }
  const field = (body, label, value = '', type = 'text') => {
    const l = document.createElement('label');
    l.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    l.append(input);
    body.append(l);
    return input;
  };
  let agentContextTarget = null;
  function showItemContextMenu(event, kind, item) {
    event.preventDefault();
    event.stopPropagation();
    agentContextTarget = {kind, item};
    const archive = $('menuArchiveAgent'),
      active =
        kind === 'agent' && ['starting', 'streaming', 'waiting_for_user', 'stopping'].includes(item.status),
      binding = kind === 'agent' && sessionKeyboard.getBinding(item.agentId);
    archive.hidden = kind !== 'agent';
    archive.disabled = active;
    archive.title = active ? 'Agent 执行期间不能 Archive' : '';
    $('menuBindKeyboard').hidden = kind !== 'agent' || !!binding;
    $('menuBindKeyboard').disabled = !binding && sessionKeyboard.getBindings().length >= 6;
    $('menuBindKeyboard').title = $('menuBindKeyboard').disabled ? '六个按键均已绑定' : '';
    $('menuKeyboardColor').hidden = kind !== 'agent' || !binding;
    $('menuUnbindKeyboard').hidden = kind !== 'agent' || !binding;
    $('menuCloseTerminal').hidden = kind !== 'terminal';
    const menu = $('agentContextMenu');
    menu.hidden = false;
    menu.style.left = `${Math.min(event.clientX, innerWidth - 210)}px`;
    menu.style.top = `${Math.min(event.clientY, innerHeight - 190)}px`;
  }
  async function bindKeyboard({agentId, slot} = {}) {
    const free = sessionKeyboard.getFreeSlots();
    const agents = state.agents.filter(agent => !sessionKeyboard.getBinding(agent.agentId));
    if (!free.length) return toast('六个键盘按键均已绑定');
    if (!agents.length) return toast('没有可绑定的 Session');
    const result = await modal(
      '绑定键盘按键',
      body => {
        const sessionLabel = document.createElement('label');
        sessionLabel.textContent = 'Session';
        const sessions = document.createElement('select');
        for (const agent of agents) {
          const option = document.createElement('option');
          option.value = agent.agentId;
          option.textContent =
            connectedBackends().length > 1
              ? `${agent.backendName} · ${agentLabel(agent)}`
              : agentLabel(agent);
          option.selected = agent.agentId === agentId;
          sessions.append(option);
        }
        sessionLabel.append(sessions);
        body.append(sessionLabel);
        const slotLabel = document.createElement('label');
        slotLabel.textContent = '按键';
        const keys = document.createElement('select');
        for (const key of free) {
          const option = document.createElement('option');
          option.value = String(key);
          option.textContent = `按键 ${key + 1} / AG0${key}`;
          option.selected = key === slot;
          keys.append(option);
        }
        slotLabel.append(keys);
        body.append(slotLabel);
        const color = field(body, '灯光颜色', sessionKeyboard.nextColor(), 'color');
        return () => ({agentId: sessions.value, slot: Number(keys.value), color: color.value});
      },
      '绑定'
    );
    if (!result) return;
    sessionKeyboard.bind(result.agentId, result.slot, result.color);
    toast(`已绑定到按键 ${result.slot + 1}`);
  }
  async function changeKeyboardColor(agent) {
    const binding = sessionKeyboard.getBinding(agent.agentId);
    if (!binding) return;
    const color = await modal(
      '更换按键颜色',
      body => {
        const input = field(body, `按键 ${binding.slot + 1} 的颜色`, binding.color, 'color');
        return () => input.value;
      },
      '应用'
    );
    if (color) {
      sessionKeyboard.setColor(agent.agentId, color);
      toast(`按键 ${binding.slot + 1} 颜色已更新`);
    }
  }
  async function createAgent() {
    const workspace = state.workspace;
    if (!workspace) return toast('请先选择 Workspace');
    const cwd = $('agentCwd').value.trim() || '.';
    const preferenceKey = `rpLastTemplate:${workspace.backendId}`;
    let sessions,
      templates = [];
    try {
      [sessions, templates] = await Promise.all([
        requestBackend(
          workspace.backendId,
          `/api/v1/sessions?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(cwd)}`
        ),
        // Older backends have no templates endpoint; they simply offer Pi's default prompt.
        requestBackend(workspace.backendId, '/api/v1/agent-templates')
          .then(data => data.templates || [])
          .catch(() => [])
      ]);
    } catch (error) {
      return toast(error.message);
    }
    const result = await modal(
      '新建 Agent',
      body => {
        const c = field(body, '工作路径', cwd);
        const l = document.createElement('label');
        l.textContent = 'Session';
        const s = document.createElement('select');
        s.innerHTML =
          '<option value="">新 Session</option>' +
          sessions
            .map(
              x =>
                `<option value="${esc(x.path)}">${esc(x.name || x.sessionName || x.id || x.path)} · ${esc(x.modified || '')}</option>`
            )
            .join('');
        l.append(s);
        body.append(l);
        const t = templateSelect(body, templates);
        const preferred = globalThis.localStorage?.getItem(preferenceKey);
        if (preferred && [...t.options].some(option => option.value === preferred)) t.value = preferred;
        else if (preferred) {
          globalThis.localStorage?.removeItem(preferenceKey);
          toast('上次使用的 System Prompt 模板已删除，改用 Pi 默认');
        }
        const preview = promptPreviewBox(body, () => ({
          backendId: workspace.backendId,
          workspaceId: workspace.id,
          relativeCwd: c.value.trim() || '.',
          templateId: t.value
        }));
        c.addEventListener('input', () => preview.reset());
        t.onchange = () => preview.reset();
        return () => ({
          cwd: c.value.trim() || '.',
          sessionFile: s.value || undefined,
          templateId: t.value || undefined
        });
      },
      '创建'
    );
    if (!result) return;
    try {
      const created = await postBackend(workspace.backendId, '/api/v1/agents', {
        workspaceId: workspace.id,
        relativeCwd: result.cwd,
        sessionFile: result.sessionFile,
        templateId: result.templateId
      });
      localStorage.setItem(preferenceKey, result.templateId || '');
      const agent = stampNewItem(workspace.backendId, created);
      const binding = result.sessionFile ? null : autoBindNewSession(agent);
      await refreshAgents();
      await selectAgent(agent);
      if (binding) toast(`新 Session 已自动绑定到按键 ${binding.slot + 1}`);
    } catch (error) {
      toast(error.message);
    }
  }
  const templateModeText = mode => (mode === 'replace' ? '替换 Pi 基础 Prompt' : '追加到 Pi Prompt 之后');
  /** Template picker for the create-Agent dialog. The choice is copied onto the Agent and cannot change later. */
  function templateSelect(body, templates) {
    const label = document.createElement('label');
    label.textContent = 'System Prompt 模板';
    const select = document.createElement('select');
    select.innerHTML =
      '<option value="">Pi 默认（SYSTEM.md / APPEND_SYSTEM.md 或 Pi 内置）</option>' +
      templates
        .map(
          x =>
            `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(templateModeText(x.mode))}${x.description ? ` — ${esc(x.description)}` : ''}</option>`
        )
        .join('');
    const hint = document.createElement('small');
    hint.className = 'muted';
    hint.textContent =
      '创建后不可更改；Fork 出的 Agent 沿用同一模板。模板内容在创建时复制，之后修改模板文件不影响已有 Agent。';
    label.append(select, hint);
    body.append(label);
    return select;
  }
  function promptSourcesText(info) {
    const parts = [];
    if (info.template)
      parts.push(
        `模板：${info.template.name || info.template.id}（${templateModeText(info.template.mode)}）`
      );
    if (info.template?.mode !== 'replace')
      parts.push(info.systemFile ? `基础 Prompt：${info.systemFile}` : '基础 Prompt：Pi 内置');
    if (info.appendFiles?.length) parts.push(`追加：${info.appendFiles.join(', ')}`);
    if (info.contextFiles?.length) parts.push(`上下文文件：${info.contextFiles.join(', ')}`);
    if (info.cwd) parts.push(`cwd：${info.cwd}`);
    if (typeof info.systemPrompt === 'string') parts.push(`${info.systemPrompt.length} 字符`);
    return parts.join(' · ');
  }
  /** Collapsible, on-demand preview of the system prompt an Agent would start with. */
  function promptPreviewBox(body, target, title = '预览 System Prompt') {
    const box = document.createElement('details');
    box.className = 'prompt-preview';
    const summary = document.createElement('summary');
    summary.textContent = title;
    const meta = document.createElement('small');
    meta.className = 'muted';
    const pre = document.createElement('pre');
    pre.className = 'prompt-text';
    box.append(summary, meta, pre);
    body.append(box);
    let loaded = false,
      request = 0;
    const load = async () => {
      const {backendId, workspaceId, relativeCwd, templateId, source} = target(),
        current = ++request;
      pre.textContent = '';
      if (!workspaceId) {
        meta.textContent = '需要先选择该 Backend 上的 Workspace 才能预览（Prompt 与工作目录有关）。';
        return;
      }
      meta.textContent = '正在生成…';
      try {
        const query = new URLSearchParams({workspaceId, relativeCwd: relativeCwd || '.'});
        if (templateId) query.set('templateId', templateId);
        if (source) query.set('source', source);
        const data = await requestBackend(backendId, `/api/v1/system-prompt/preview?${query}`);
        if (current !== request) return;
        meta.textContent = promptSourcesText(data);
        pre.textContent = data.systemPrompt;
        loaded = true;
      } catch (error) {
        if (current === request) meta.textContent = `预览失败：${error.message}`;
      }
    };
    box.addEventListener('toggle', () => {
      if (box.open && !loaded) void load();
    });
    return {
      reset() {
        ++request;
        loaded = false;
        if (box.open) void load();
      }
    };
  }
  async function showAgentSystemPrompt() {
    if (!state.agent) return toast('请选择 Agent');
    const info = await requestAgent(state.agent.agentId, '/system-prompt');
    await modal(
      'Agent System Prompt',
      body => {
        const head = document.createElement('p');
        head.textContent = info.template
          ? `模板：${info.template.name || info.template.id}（${templateModeText(info.template.mode)}）。模板在创建 Agent 时选定并固定，不能更改。`
          : '未使用模板：Pi 默认 System Prompt（含 ~/.pi/agent 与受信任项目 .pi 下的 SYSTEM.md / APPEND_SYSTEM.md）。模板只能在创建 Agent 时选择。';
        const meta = document.createElement('small');
        meta.className = 'muted';
        meta.textContent = promptSourcesText(info);
        const pre = document.createElement('pre');
        pre.className = 'prompt-text';
        pre.textContent = info.systemPrompt;
        body.append(head, meta, pre);
        if (info.template) {
          const details = document.createElement('details');
          details.className = 'prompt-preview';
          const summary = document.createElement('summary');
          summary.textContent = '模板原文（创建时快照）';
          const raw = document.createElement('pre');
          raw.className = 'prompt-text';
          raw.textContent = info.template.systemPrompt;
          details.append(summary, raw);
          body.append(details);
        }
        return null;
      },
      '关闭'
    );
  }
  async function switchAgentPrompt() {
    const agent = state.agent;
    if (!agent) return toast('请先选择 Agent');
    const [session, catalog] = await Promise.all([
      requestAgent(agent.agentId, '/session'),
      requestBackend(agent.backendId, '/api/v1/agent-templates')
    ]);
    if (agent.profile !== 'default' || session.entries?.some(entry => entry.type === 'message'))
      return toast('会话开始后不能切换 System Prompt，请新建会话');
    const choice = await modal(
      '切换 System Prompt（仅首次对话前）',
      body => {
        const picker = templateSelect(body, catalog.templates || []);
        picker.value = agent.template?.id || '';
        return () => picker.value;
      },
      '切换'
    );
    if (choice === null) return;
    await postAgent(agent.agentId, '/system-prompt', {templateId: choice});
    localStorage.setItem(`rpLastTemplate:${agent.backendId}`, choice);
    agent.template = (catalog.templates || []).find(item => item.id === choice) || undefined;
    await refreshAgents(true);
    toast('System Prompt 已切换');
  }
  /** Manage Pi's global prompt files and the shareable Agent templates of one backend. */
  async function systemPromptManager() {
    if (!requireConnection()) return;
    const workspaceBackend =
      state.workspace && backendOf(state.workspace.backendId)?.status === 'connected'
        ? state.workspace.backendId
        : null;
    const backendId = workspaceBackend || primaryBackend()?.id;
    if (!backendId) return toast('没有已连接的 Backend');
    const backend = backendOf(backendId),
      workspace = state.workspace?.backendId === backendId ? state.workspace : null,
      relativeCwd = () => $('agentCwd').value.trim() || '.';
    const send = (url, method = 'GET', body) =>
      requestBackend(backendId, url, {method, ...(body ? {body: JSON.stringify(body)} : {})});
    let files, catalog;
    try {
      [files, catalog] = await Promise.all([send('/api/v1/system-prompt'), send('/api/v1/agent-templates')]);
    } catch (error) {
      return toast(`读取失败：${error.message}（Backend 可能版本过旧）`);
    }
    if ($('configDialog').open) $('configDialog').close();
    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const section = (title, note) =>
      el(
        'section',
        {className: 'config-section'},
        el('h3', {textContent: title}),
        el('p', {className: 'muted', textContent: note})
      );
    await modal(
      `System Prompt · ${backend.name || backendId}`,
      body => {
        // Effective prompt preview ---------------------------------------------------------------
        const previewSection = section(
          '查看当前 System Prompt',
          workspace
            ? `基于 Workspace「${workspace.label}」的工作路径「${relativeCwd()}」生成，包含项目上下文、skills 与 cwd。`
            : '先在左侧选择该 Backend 上的 Workspace 才能预览（Prompt 与工作目录有关）。'
        );
        const sourceSelect = el('select');
        sourceSelect.innerHTML =
          '<option value="">当前生效（含 SYSTEM.md / APPEND_SYSTEM.md）</option><option value="pi-default">Pi 内置（忽略 SYSTEM.md / APPEND_SYSTEM.md）</option>';
        previewSection.append(el('label', {textContent: '来源'}, sourceSelect));
        const preview = promptPreviewBox(previewSection, () => ({
          backendId,
          workspaceId: workspace?.id,
          relativeCwd: relativeCwd(),
          source: sourceSelect.value
        }));
        sourceSelect.onchange = () => preview.reset();
        // Pi's global prompt files ----------------------------------------------------------------
        const fileSection = section(
          'Pi 全局 System Prompt',
          `位于 ${files.agentDir}，对所有 Pi 会话（包括 Pi CLI）生效；受信任项目的 .pi/SYSTEM.md、.pi/APPEND_SYSTEM.md 优先。留空保存即删除文件（恢复 Pi 内置）。对之后加载的 Agent 生效。`
        );
        const fileEditor = (kind, title, placeholder) => {
          const area = el('textarea', {className: 'prompt-editor', value: files[kind].content, placeholder});
          const status = el('small', {className: 'muted'});
          const showStatus = () =>
            (status.textContent = files[kind].exists ? files[kind].path : `${files[kind].path}（不存在）`);
          showStatus();
          const save = el('button', {type: 'button', textContent: '保存'});
          save.onclick = async () => {
            if (
              kind === 'system' &&
              area.value.trim() &&
              !confirm('SYSTEM.md 会替换 Pi 的整个基础 Prompt（包括工具说明、规则与文档段落），确定保存？')
            )
              return;
            save.disabled = true;
            try {
              files = await send('/api/v1/system-prompt', 'PUT', {kind, content: area.value});
              area.value = files[kind].content;
              showStatus();
              preview.reset();
              toast(files[kind].exists ? `${title} 已保存` : `${title} 已删除`);
            } catch (error) {
              toast(`保存失败：${error.message}`);
            } finally {
              save.disabled = false;
            }
          };
          fileSection.append(
            el('label', {textContent: title}, area),
            el('div', {className: 'config-actions'}, save, status)
          );
        };
        fileEditor('system', 'SYSTEM.md（替换 Pi 内置基础 Prompt）', '留空 = 使用 Pi 内置 Prompt');
        fileEditor('append', 'APPEND_SYSTEM.md（追加到基础 Prompt 之后）', '留空 = 不追加');
        // Shareable Agent templates ---------------------------------------------------------------
        const templateSection = section(
          'Agent 模板',
          `每个模板是 ${catalog.dir} 下的一个 .md 文件（YAML front matter：name、description、mode），可直接复制分享，手动放入的文件会立即出现。新建 Agent 时选择，之后不可更改。`
        );
        const list = el('div', {className: 'template-list'}),
          errors = el('div'),
          editor = el('div', {className: 'template-editor', hidden: true});
        const idInput = el('input', {placeholder: '例如 reviewer（即文件名；字母、数字、. _ -）'}),
          nameInput = el('input', {placeholder: '显示名称'}),
          descInput = el('input', {placeholder: '一行说明（可选）'}),
          modeSelect = el('select'),
          promptArea = el('textarea', {className: 'prompt-editor', placeholder: 'System Prompt 内容'}),
          saveTemplate = el('button', {type: 'button', textContent: '保存模板'}),
          cancelTemplate = el('button', {type: 'button', textContent: '取消'});
        modeSelect.innerHTML =
          '<option value="append">append：追加到 Pi Prompt 之后（保留 Pi 的工具说明与规则）</option><option value="replace">replace：替换 Pi 基础 Prompt（等同 SYSTEM.md）</option>';
        editor.append(
          el('label', {textContent: 'ID'}, idInput),
          el('label', {textContent: '名称'}, nameInput),
          el('label', {textContent: '说明'}, descInput),
          el('label', {textContent: '模式'}, modeSelect),
          el('label', {textContent: 'System Prompt'}, promptArea),
          el('div', {className: 'config-actions'}, saveTemplate, cancelTemplate)
        );
        const templatePreview = promptPreviewBox(
          editor,
          () => ({
            backendId,
            workspaceId: workspace?.id,
            relativeCwd: relativeCwd(),
            templateId: idInput.value.trim()
          }),
          '预览已保存版本生成的 System Prompt'
        );
        const openEditor = (template = null) => {
          editor.hidden = false;
          idInput.value = template?.id || '';
          idInput.disabled = !!template;
          nameInput.value = template?.name || '';
          descInput.value = template?.description || '';
          modeSelect.value = template?.mode || 'append';
          promptArea.value = template?.systemPrompt || '';
          templatePreview.reset();
          (template ? promptArea : idInput).focus();
        };
        const reload = async () => {
          catalog = await send('/api/v1/agent-templates');
          renderList();
        };
        const renderList = () => {
          list.replaceChildren();
          if (!catalog.templates.length)
            list.append(el('p', {className: 'muted', textContent: '还没有模板。'}));
          for (const template of catalog.templates) {
            const edit = el('button', {type: 'button', textContent: '编辑'});
            edit.onclick = () => openEditor(template);
            const remove = el('button', {type: 'button', textContent: '删除', className: 'danger-action'});
            remove.onclick = async () => {
              if (!confirm(`删除模板「${template.name}」？已用它创建的 Agent 不受影响。`)) return;
              try {
                await send(`/api/v1/agent-templates/${encodeURIComponent(template.id)}`, 'DELETE');
                if (idInput.disabled && idInput.value === template.id) editor.hidden = true;
                await reload();
                toast('模板已删除');
              } catch (error) {
                toast(`删除失败：${error.message}`);
              }
            };
            const info = el(
              'div',
              {className: 'template-info'},
              el('b', {textContent: template.name}),
              el('small', {
                className: 'muted',
                textContent: `${template.id}.md · ${templateModeText(template.mode)}${template.description ? ` · ${template.description}` : ''}`
              })
            );
            list.append(el('div', {className: 'template-row'}, info, edit, remove));
          }
          errors.replaceChildren(
            ...(catalog.errors || []).map(text => el('p', {className: 'mcp-error', textContent: text}))
          );
        };
        cancelTemplate.onclick = () => (editor.hidden = true);
        saveTemplate.onclick = async () => {
          const id = idInput.value.trim();
          if (!id) return toast('请填写模板 ID');
          if (!promptArea.value.trim()) return toast('System Prompt 不能为空');
          if (
            !idInput.disabled &&
            catalog.templates.some(x => x.id === id) &&
            !confirm(`模板 ${id} 已存在，覆盖？`)
          )
            return;
          saveTemplate.disabled = true;
          try {
            const saved = await send(`/api/v1/agent-templates/${encodeURIComponent(id)}`, 'PUT', {
              name: nameInput.value.trim() || id,
              description: descInput.value.trim(),
              mode: modeSelect.value,
              systemPrompt: promptArea.value
            });
            await reload();
            openEditor(saved);
            toast('模板已保存');
          } catch (error) {
            toast(`保存失败：${error.message}`);
          } finally {
            saveTemplate.disabled = false;
          }
        };
        const addTemplate = el('button', {type: 'button', textContent: '新建模板'});
        addTemplate.onclick = () => openEditor();
        templateSection.append(list, errors, el('div', {className: 'config-actions'}, addTemplate), editor);
        renderList();
        body.append(previewSection, fileSection, templateSection);
        return null;
      },
      '关闭'
    );
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
    const choice = await modal(
      'Session Tree',
      body => {
        const actionLabel = document.createElement('label');
        actionLabel.textContent = '操作';
        const action = document.createElement('select');
        action.innerHTML =
          '<option value="navigate">Navigate 到条目</option><option value="fork">从用户消息 Fork 新 Agent</option>';
        actionLabel.append(action);
        body.append(actionLabel);
        const list = document.createElement('div');
        list.className = 'modal-list';
        let selected = '';
        for (const e of entries) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'choice';
          const text = textContent(e.message?.content || e.content) || e.type;
          b.innerHTML = `${e.id === session.leafId ? '● ' : '○ '}${esc(text.slice(0, 100))}<small>${esc(e.id)}</small>`;
          b.onclick = () => {
            selected = e.id;
            list.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
          };
          list.append(b);
        }
        body.append(list);
        return () => (selected ? {entryId: selected, action: action.value} : null);
      },
      '执行'
    );
    if (!choice) return;
    if (choice.action === 'fork') {
      const result = await postAgent(sourceAgent.agentId, '/fork', {entryId: choice.entryId});
      const forkedAgent = stampNewItem(sourceAgent.backendId, result.agent);
      const binding = autoBindNewSession(forkedAgent);
      await refreshAgents();
      await selectAgent(forkedAgent);
      if (binding) toast(`Fork Session 已自动绑定到按键 ${binding.slot + 1}`);
    } else {
      await navigateAgent(choice.entryId, sourceAgent);
    }
  }
  async function revert() {
    if (!state.agent) return toast('请选择 Agent');
    const session = await requestAgent(state.agent.agentId, '/session');
    const messages = (session.entries || []).filter(
      e => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role)
    );
    if (!messages.length) return toast('当前 Session 没有可回退的消息');
    const selected = await modal(
      'Undo（Session Tree）',
      body => {
        const note = document.createElement('p');
        note.className = 'muted';
        note.textContent =
          '选择用户输入会回到输入前并恢复文字；选择 Agent 输出会保留该输出、移除后续上下文。文件改动不会撤销。';
        body.append(note);
        const list = document.createElement('div');
        list.className = 'modal-list';
        let value = null;
        for (const e of [...messages].reverse()) {
          const role = e.message.role === 'user' ? 'You' : 'Agent',
            text = textContent(e.message.content) || '(空消息)';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'choice';
          b.innerHTML = `<b>${role}</b> ${esc(text.slice(0, 160))}<small>${esc(e.id)}${e.id === session.leafId ? ' · 当前' : ''}</small>`;
          b.onclick = () => {
            value = e.id;
            list.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
          };
          list.append(b);
        }
        body.append(list);
        return () => value;
      },
      '回退'
    );
    if (selected) await navigateAgent(selected);
  }
  async function modelControls() {
    if (!state.agent) return toast('请选择 Agent');
    const cap = await requestAgent(state.agent.agentId, '/capabilities');
    const result = await modal('模型与 Thinking', body => {
      const ml = document.createElement('label');
      ml.textContent = '模型';
      const m = document.createElement('select');
      for (const x of cap.models || []) {
        const o = document.createElement('option');
        o.value = JSON.stringify([x.provider, x.id]);
        o.textContent = `${x.provider} / ${x.name || x.id}`;
        o.selected = x.provider === cap.model?.provider && x.id === cap.model?.id;
        m.append(o);
      }
      ml.append(m);
      body.append(ml);
      const tl = document.createElement('label');
      tl.textContent = 'Thinking level';
      const t = document.createElement('select');
      for (const x of cap.thinkingLevels || []) {
        const o = document.createElement('option');
        o.value = x;
        o.textContent = x;
        o.selected = x === cap.thinkingLevel;
        t.append(o);
      }
      tl.append(t);
      body.append(tl);
      return () => ({model: m.value ? JSON.parse(m.value) : null, thinking: t.value});
    });
    if (result) {
      if (result.model)
        await postAgent(state.agent.agentId, '/model', {provider: result.model[0], modelId: result.model[1]});
      if (result.thinking) await postAgent(state.agent.agentId, '/thinking', {level: result.thinking});
      toast('设置已更新');
    }
  }

  /** MCP servers Pi reads from mcp.json. Toggling writes the config; a session picks it up when it loads. */
  async function mcpControls() {
    if (!state.agent) return toast('请选择 Agent');
    const agentId = state.agent.agentId;
    const render = (overview, list) => {
      list.replaceChildren();
      if (!overview.servers.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = '没有配置 MCP 服务器。在 mcp.json 中添加后会显示在这里。';
        list.append(empty);
      }
      for (const server of overview.servers) {
        const row = document.createElement('div');
        row.className = `mcp-row${server.enabled ? '' : ' mcp-off'}`;
        const info = document.createElement('div');
        info.className = 'mcp-info';
        const name = document.createElement('b');
        name.textContent = server.name;
        const detail = document.createElement('small');
        detail.className = 'muted';
        detail.textContent = `${server.transport} · ${server.exposure} · ${server.scope === 'project' ? '项目' : '全局'}${server.override ? '（项目覆盖）' : ''}\n${server.description || server.target}`;
        info.append(name, detail);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = server.enabled ? '停用' : '启用';
        toggle.onclick = async () => {
          toggle.disabled = true;
          try {
            render(await postAgent(agentId, '/mcp', {name: server.name, enabled: !server.enabled}), list);
            toast('已保存，重新加载 Agent 后生效');
          } catch (error) {
            toast(`修改失败：${error.message}`);
            toggle.disabled = false;
          }
        };
        row.append(info, toggle);
        list.append(row);
      }
      for (const error of overview.errors || []) {
        const line = document.createElement('p');
        line.className = 'mcp-error';
        line.textContent = error;
        list.append(line);
      }
      if (!overview.projectTrusted) {
        const note = document.createElement('p');
        note.className = 'muted';
        note.textContent = '项目未被信任，因此忽略 .pi/mcp.json，修改会写入全局配置。';
        list.append(note);
      }
    };
    const overview = await requestAgent(agentId, '/mcp');
    await modal(
      'MCP 服务器',
      body => {
        const list = document.createElement('div');
        list.className = 'mcp-list';
        render(overview, list);
        body.append(list);
        return null;
      },
      '关闭'
    );
  }

  $('pairCancel').onclick = () => $('pairDialog').close();
  $('modalCancel').onclick = () => $('modal').close('cancel');
  $('pairForm').onsubmit = async event => {
    event.preventDefault();
    $('pairSubmit').disabled = true;
    try {
      const base = $('pairBase').value.trim().replace(/\/$/, '');
      const token = $('pairToken').value;
      let name = $('pairName').value.trim();
      if (!name) {
        try {
          name = new URL(base).hostname;
        } catch {}
      }
      const editingId = $('pairDialog').dataset.backendId;
      const existing = backendOf(editingId) || backendRegistry.findByBase(base);
      const entry = {
        id: existing?.id || createBackendId(),
        name,
        base,
        token,
        saved: existing?.saved || false
      };
      await connectBackend(entry, {confirmSave: true});
      $('pairDialog').close();
    } catch (error) {
      updateHeaderStatus();
      toast(error.message);
    } finally {
      $('pairSubmit').disabled = false;
    }
  };
  $('openConfig').onclick = openConfig;
  $('configClose').onclick = () => $('configDialog').close();
  $('configSave').onclick = saveMailSettings;
  $('saveSotto').onclick = saveSottoSettings;
  $('connect').onclick = () => openPair();
  $('keyboardConnect').onclick = async () => {
    try {
      $('keyboardConnect').disabled = true;
      await sessionKeyboard.connect();
    } catch (error) {
      toast(`键盘连接失败：${error.message}`);
    } finally {
      $('keyboardConnect').disabled = false;
    }
  };
  $('keyboardDisconnect').onclick = () =>
    sessionKeyboard.disconnect().catch(error => toast(`键盘断开失败：${error.message}`));
  $('notifications').onclick = enableNotifications;
  $('voicePlayback').onclick = toggleVoicePlayback;
  $('voiceInput').onclick = toggleVoiceInput;
  $('disconnectAll').onclick = () => void disconnectAll();
  $('backendFilter').onchange = () => {
    state.backendFilter = $('backendFilter').value;
    if (state.backendFilter) localStorage.rpBackendFilter = state.backendFilter;
    else localStorage.removeItem('rpBackendFilter');
    renderWorkspaces().catch(() => {});
    renderAgentList();
  };
  $('refreshWs').onclick = () => refreshWs().catch(e => toast(e.message));
  $('addWs').onclick = async () => {
    if (!requireConnection()) return;
    const result = await modal(
      '添加 Workspace',
      body => {
        const n = field(body, '名称');
        const p = field(body, '主机绝对路径');
        return () => ({label: n.value.trim(), rootPath: p.value.trim()});
      },
      '添加'
    );
    if (result?.label && result.rootPath) {
      const target = state.backendFilter || state.workspace?.backendId || primaryBackend()?.id;
      if (!target) return toast('没有可用的 Backend');
      await postBackend(target, '/api/v1/workspaces', result);
      await refreshWs();
    }
  };
  $('workspaces').onchange = () => void selectWorkspace();
  $('agentPageSize').value = String(state.agentPageSize);
  $('agentPageSize').onchange = () => {
    state.agentPageSize = Number($('agentPageSize').value) || 10;
    state.agentVisibleCount = state.agentPageSize;
    localStorage.rpAgentPageSize = String(state.agentPageSize);
    renderAgentList();
  };
  $('loadMoreAgents').onclick = () => {
    state.agentVisibleCount += state.agentPageSize;
    renderAgentList();
  };
  $('treeRoot').onclick = () => openDirectory('.');
  $('treeUp').onclick = () => openDirectory(parentPath(state.treePath));
  $('mentionCurrent').onclick = () => insertMention(state.treePath);
  $('terminalCurrent').onclick = () => openTerminal(state.treePath);
  $('treePath').oncontextmenu = e => showContextMenu(e, {relativePath: state.treePath, type: 'directory'});
  enableLongPressMenu($('treePath'), e =>
    showContextMenu(e, {relativePath: state.treePath, type: 'directory'})
  );
  $('filePrev').onclick = () =>
    openFile(state.filePath, Math.max(0, state.fileOffset - state.fileLimit), false);
  $('fileNext').onclick = () => openFile(state.filePath, state.fileOffset + state.fileLimit, false);
  $('menuStartAgent').onclick = () => startAgent(state.contextTarget.relativePath);
  $('menuOpenTerminal').onclick = () => openTerminal(state.contextTarget.relativePath);
  $('menuSetCwd').onclick = () => {
    $('agentCwd').value = state.contextTarget.relativePath;
    $('contextMenu').hidden = true;
  };
  $('menuMention').onclick = () => {
    insertMention(state.contextTarget.relativePath);
    $('contextMenu').hidden = true;
  };
  $('menuBindKeyboard').onclick = () => {
    const agent = agentContextTarget?.kind === 'agent' ? agentContextTarget.item : null;
    $('agentContextMenu').hidden = true;
    if (agent) void bindKeyboard({agentId: agent.agentId}).catch(error => toast(error.message));
  };
  $('menuKeyboardColor').onclick = () => {
    const agent = agentContextTarget?.kind === 'agent' ? agentContextTarget.item : null;
    $('agentContextMenu').hidden = true;
    if (agent) void changeKeyboardColor(agent).catch(error => toast(error.message));
  };
  $('menuUnbindKeyboard').onclick = () => {
    const agent = agentContextTarget?.kind === 'agent' ? agentContextTarget.item : null;
    $('agentContextMenu').hidden = true;
    if (agent && sessionKeyboard.unbind(agent.agentId)) toast('已取消键盘按键绑定');
  };
  $('menuCloseTerminal').onclick = () => {
    const terminal = agentContextTarget?.kind === 'terminal' ? agentContextTarget.item : null;
    $('agentContextMenu').hidden = true;
    if (terminal && confirm('关闭这个 Terminal？正在运行的进程会被终止。')) void closeTerminal(terminal);
  };
  $('menuArchiveAgent').onclick = async () => {
    const agent = agentContextTarget?.kind === 'agent' ? agentContextTarget.item : null;
    $('agentContextMenu').hidden = true;
    if (!agent || !confirm('Archive 这个 Agent？Pi Session 文件不会被修改。')) return;
    try {
      await postAgent(agent.agentId, '/archive');
      sessionKeyboard.unbind(agent.agentId);
      if (state.agent?.agentId === agent.agentId) clearAgentSelection();
      await refreshAgents();
      toast('Agent 已 Archive');
    } catch (e) {
      toast(e.message);
    }
  };
  document.addEventListener('click', e => {
    if (!$('contextMenu').contains(e.target)) $('contextMenu').hidden = true;
    if (!$('agentContextMenu').contains(e.target)) $('agentContextMenu').hidden = true;
  });
  $('newAgent').onclick = createAgent;
  $('newTerminal').onclick = () => openTerminal($('agentCwd').value.trim() || '.');
  $('abort').onclick = () => {
    if (!state.agent) return;
    const id = state.agent.agentId;
    Promise.all([postAgent(id, '/abort'), postAgent(id, '/bash-abort')]).catch(e => toast(e.message));
  };
  $('stop').onclick = async () => {
    if (state.agent && confirm('停止这个 Agent？之后再次使用时会按需启动。')) {
      await requestAgent(state.agent.agentId, '', {method: 'DELETE'});
      setAgentStatus(state.agent.agentId, 'unloaded');
    }
  };
  $('sessionName').onclick = async () => {
    if (!state.agent) return;
    const result = await modal('Session 名称', body => {
      const n = field(body, '名称', state.agent.sessionName || '');
      return () => n.value.trim();
    });
    if (result) {
      const s = await postAgent(state.agent.agentId, '/session-name', {name: result});
      state.agent.sessionName = s.sessionName || result;
      updateAgentHeader();
      await refreshAgents();
    }
  };
  $('mcp').onclick = () => mcpControls().catch(e => toast(e.message));
  $('systemPrompt').onclick = () => showAgentSystemPrompt().catch(e => toast(e.message));
  $('switchPrompt').onclick = () => switchAgentPrompt().catch(e => toast(e.message));
  $('openSystemPrompts').onclick = () => systemPromptManager().catch(e => toast(e.message));
  $('sessionTree').onclick = () => showSessionTree().catch(e => toast(e.message));
  $('undo').onclick = () => revert().catch(e => toast(e.message));
  $('controls').onclick = () => modelControls().catch(e => toast(e.message));
  $('compact').onclick = async () => {
    if (!state.agent) return;
    const instructions = await modal(
      'Compact',
      body => {
        const n = field(body, '可选指令');
        return () => n.value;
      },
      '开始'
    );
    if (instructions !== null) {
      await postAgent(state.agent.agentId, '/compact', {instructions: instructions || undefined});
      toast('Compact 完成');
    }
  };
  $('prompt').onsubmit = async event => {
    event.preventDefault();
    if (!state.agent) return toast('请先创建或选择 Agent');
    const text = $('input').value.trim();
    if (!text) return;
    closeCommandPicker();
    const selectedMode = $('sendMode').value,
      mode =
        state.agent.status === 'streaming' || state.agent.status === 'waiting_for_user'
          ? selectedMode === 'steer'
            ? 'steer'
            : 'follow-up'
          : 'prompt',
      agentId = state.agent.agentId;
    $('messages').querySelector('.empty')?.remove();
    // `!cmd` runs inside the Agent session (output is recorded in the Session); `!!cmd` keeps the output out of the model context.
    if (text.startsWith('!')) {
      const excludeFromContext = text.startsWith('!!'),
        command = text.slice(excludeFromContext ? 2 : 1).trim();
      if (!command) return toast('请输入要执行的命令');
      state.optimistic.push(addCard(null, text, 'user'));
      $('input').value = '';
      try {
        await postAgent(agentId, '/bash', {command, excludeFromContext});
      } catch (e) {
        toast(`命令失败：${e.message}`);
      }
      return;
    }
    // A prompt shows at once; steering and follow-ups appear in the queue bar until the run takes them.
    if (mode === 'prompt') state.optimistic.push(addCard(null, text, 'user'));
    $('input').value = '';
    try {
      const sent = await postAgent(agentId, `/${mode}`, {message: text});
      if (mode !== 'prompt' && sent?.disposition)
        toast(sent.disposition === 'queued' ? '已排队，等待当前回合' : '已送达当前回合');
    } catch (e) {
      $('input').value = text + ($('input').value ? `\n${$('input').value}` : '');
      addCard('发送失败', e.message, 'error', true);
    }
  };
  $('input').onkeydown = event => {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'v' && !event.isComposing) {
      event.preventDefault();
      if (!event.repeat) void toggleVoiceInput();
      return;
    }
    if (!$('commandPicker').hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCommandSelection(state.commandIndex + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault();
        chooseCommand(state.commandFiltered[state.commandIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandPicker();
        return;
      }
    }
    if (!$('mentionPicker').hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionSelection(state.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        chooseMention(state.mentionFiltered[state.mentionIndex], event.key === 'Enter');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      $('prompt').requestSubmit();
    }
  };
  $('input').oninput = () => {
    const command = commandContext();
    if (command) {
      if (!$('mentionPicker').hidden) closeMention();
      void openCommandPicker(command.query);
      return;
    }
    if (!$('commandPicker').hidden) closeCommandPicker();
    const context = mentionContext();
    if (!context) {
      if (!$('mentionPicker').hidden) closeMention();
      return;
    }
    const fresh = $('mentionPicker').hidden || state.mentionStart !== context.start;
    state.mentionStart = context.start;
    state.mentionEnd = context.replacementEnd;
    if (fresh) {
      state.mentionPrefix = '';
      void openMention(state.treePath, context.query);
      return;
    }
    const filter =
      state.mentionPrefix && context.query.startsWith(state.mentionPrefix)
        ? context.query.slice(state.mentionPrefix.length)
        : context.query;
    renderMentionItems(filter);
  };
  // Clearing hands the queued messages back, so nothing typed is lost when a run is redirected.
  $('queueClear').onclick = async () => {
    if (!state.agent) return;
    const agentId = state.agent.agentId;
    try {
      // The server's queue_update event clears the banner; applying an empty queue here would hide a
      // message queued in the meantime.
      const cleared = await requestAgent(agentId, '/queue', {method: 'DELETE'});
      const restored = [...(cleared.steering || []), ...(cleared.followUp || [])].join('\n');
      // The composer is shared, so restoring into another Agent's input would send the text there.
      if (restored && state.agent?.agentId !== agentId)
        return toast('队列已清空，但已切换 Agent，内容未放回输入框');
      if (restored) {
        const input = $('input');
        input.value = input.value.trim() ? `${restored}\n${input.value}` : restored;
        input.focus();
      }
      toast(restored ? '队列已清空，内容已放回输入框' : '队列已清空');
    } catch (error) {
      toast(`清空队列失败：${error.message}`);
    }
  };
  $('commandClose').onclick = closeCommandPicker;
  $('mentionUp').onclick = () => browseMention(parentPath(state.mentionPath));
  $('mentionClose').onclick = closeMention;
  $('workspaceBack').onclick = () => mobileBack('home');
  $('fileBack').onclick = () => mobileBack('workspace');
  $('agentBack').onclick = () => mobileBack('home');
  $('terminalBack').onclick = () => mobileBack('home');
  $('terminalClear').onclick = () => state.terminalEmulator?.clear();
  $('terminalClose').onclick = () => {
    if (state.terminal && confirm('关闭这个 Terminal？正在运行的进程会被终止。')) void closeTerminal();
  };
  $('mobileAgentActions').onclick = () =>
    $('mobileAgentActions').closest('.toolbar').classList.toggle('actions-open');
  document
    .querySelectorAll('.agent-action')
    .forEach(button =>
      button.addEventListener('click', () => button.closest('.toolbar').classList.remove('actions-open'))
    );
  window.addEventListener('popstate', event => setMobileView(event.state?.rpView || 'home'));
  mobileMedia.addEventListener?.('change', event => {
    if (event.matches) setMobileView('home', {replace: true});
  });
  window.addEventListener('beforeunload', () => {
    for (const backend of state.backends) closeBackendSocket(backend);
    state.terminalWs?.close();
    cancelVoiceRecording();
    stopVoiceAudio();
  });
  window.addEventListener('focus', updateNotificationButton);
  setMobileView('home', {replace: true});
  updateConfigUi();
  updateKeyboardUi();
  renderBackendFilter();
  updateHeaderStatus();
  void sessionKeyboard.restoreAuthorized();
  // Backends whose pairing code was explicitly saved reconnect on their own, and so do codeless
  // backends because a --no-auth server needs none; the pairing dialog is only for first-time
  // or failed connections.
  void (async () => {
    const candidates = state.backends.filter(backend => backend.base && (backend.saved || !backend.token));
    if (!candidates.length) {
      openPair(state.backends[0] || null);
      return;
    }
    const results = await Promise.allSettled(
      candidates.map(backend => connectBackend(backend, {confirmSave: false, pair: false}))
    );
    if (!hasConnection()) {
      const error = results.find(result => result.status === 'rejected')?.reason;
      if (error) toast(`自动连接失败：${error.message}`);
      openPair(state.backends[0] || null);
    }
  })();
})();
