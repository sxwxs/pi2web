(() => {
  const $ = id => document.getElementById(id);
  const state = {
    base: localStorage.rpBase || location.origin,
    token: localStorage.rpToken || '', workspace: null, treePath: '.', agent: null,
    ws: null, streamEl: null, contextTarget: null,
  };
  $('api').value = state.base;

  const say = (text, kind = 'system') => {
    const el = document.createElement('div'); el.className = `msg ${kind}`; el.textContent = text;
    $('messages').append(el); $('messages').scrollTop = $('messages').scrollHeight; return el;
  };
  const clean = value => value.split('\\').join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const absolutePath = relative => clean(`${state.workspace.rootPath}/${relative === '.' ? '' : relative}`);
  const isInside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
  const relativeTo = (file, dir) => file === dir ? '.' : file.slice(dir.length + 1);

  async function api(url, options = {}) {
    const headers = {'Authorization': `Bearer ${state.token}`, ...(options.body ? {'Content-Type': 'application/json'} : {})};
    const response = await fetch(state.base.replace(/\/$/, '') + url, {...options, headers});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error?.message || `${response.status}`);
    return body.data;
  }
  async function connect() {
    state.base = $('api').value.replace(/\/$/, '');
    state.token = prompt('Access token', state.token) || state.token;
    localStorage.rpBase = state.base; localStorage.rpToken = state.token;
    try {
      await api('/api/v1/workspaces'); $('status').textContent = '已连接';
      await refreshWs(); await refreshAgents(true);
    } catch (error) { $('status').textContent = '连接失败'; alert(error.message); }
  }
  async function refreshWs() {
    const list = await api('/api/v1/workspaces');
    $('workspaces').replaceChildren(...list.map(workspace => {
      const option = document.createElement('option'); option.value = workspace.id;
      option.textContent = `${workspace.label} (${workspace.rootPath})`; return option;
    }));
    if (list[0]) { $('workspaces').value = state.workspace?.id || list[0].id; await selectWs(); }
  }
  const joinPath = (base, name) => base === '.' ? name : `${base}/${name}`;
  async function selectWs() {
    const id = $('workspaces').value;
    state.workspace = (await api('/api/v1/workspaces')).find(workspace => workspace.id === id);
    if (!state.workspace) return;
    state.treePath = '.'; $('agentCwd').value = '.'; $('file').textContent = ''; await loadTree();
  }
  async function loadTree() {
    if (!state.workspace) return;
    $('treePath').textContent = absolutePath(state.treePath);
    try {
      const items = await api(`/api/v1/workspaces/${state.workspace.id}/tree?path=${encodeURIComponent(state.treePath)}`);
      $('tree').replaceChildren(...items.map(item => {
        const el = document.createElement('div'); el.className = `entry ${item.type === 'directory' ? 'dir' : 'file'}`;
        el.textContent = (item.type === 'directory' ? '📁 ' : '📄 ') + item.name;
        const relativePath = joinPath(state.treePath, item.name);
        el.onclick = () => item.type === 'directory' ? openDirectory(relativePath) : openFile(relativePath);
        el.oncontextmenu = event => showContextMenu(event, {relativePath, type: item.type});
        return el;
      }));
    } catch (error) { $('tree').textContent = error.message; }
  }
  async function openDirectory(relativePath) { state.treePath = relativePath; $('file').textContent = ''; await loadTree(); }
  async function openFile(relativePath) {
    try {
      const file = await api(`/api/v1/workspaces/${state.workspace.id}/file?path=${encodeURIComponent(relativePath)}`);
      $('file').textContent = file.binary ? `[二进制文件，${file.size} bytes]` : file.content;
    } catch (error) { $('file').textContent = error.message; }
  }
  function showContextMenu(event, target) {
    event.preventDefault(); state.contextTarget = target;
    $('menuSetCwd').hidden = target.type !== 'directory';
    const menu = $('contextMenu'); menu.hidden = false;
    menu.style.left = `${Math.min(event.clientX, innerWidth - 210)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 90)}px`;
  }
  function mentionTarget() {
    if (!state.contextTarget || !state.workspace) return;
    const target = absolutePath(state.contextTarget.relativePath);
    const selectedCwd = absolutePath($('agentCwd').value.trim() || '.');
    const cwd = clean(state.agent?.cwd || selectedCwd);
    const mention = isInside(target, cwd) ? relativeTo(target, cwd) : target;
    const input = $('input'), prefix = input.value && !/\s$/.test(input.value) ? ' ' : '';
    input.value += `${prefix}@${mention.includes(' ') ? `"${mention}"` : mention} `;
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  async function refreshAgents(selectPrevious = false) {
    const list = await api('/api/v1/agents'); const previousId = state.agent?.agentId || localStorage.rpAgentId;
    $('agents').replaceChildren(...list.map(agent => {
      const el = document.createElement('div'); el.className = 'agent' + (previousId === agent.agentId ? ' selected' : '');
      el.innerHTML = `<b>${agent.agentId.slice(0, 16)}</b><small>${agent.status} · ${agent.cwd}</small>`;
      el.onclick = () => selectAgent(agent); return el;
    }));
    if (selectPrevious) { const previous = list.find(agent => agent.agentId === previousId); if (previous) await selectAgent(previous); }
  }
  function messageText(message) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return '';
  }
  async function selectAgent(agent) {
    state.agent = agent; localStorage.rpAgentId = agent.agentId;
    $('agentTitle').textContent = `${agent.agentId} · ${agent.status}`;
    if (state.workspace && isInside(clean(agent.cwd), clean(state.workspace.rootPath))) $('agentCwd').value = relativeTo(clean(agent.cwd), clean(state.workspace.rootPath));
    $('messages').replaceChildren();
    try { (await api(`/api/v1/agents/${agent.agentId}/messages`)).forEach(message => { const text = messageText(message); if (text) say(`${message.role}: ${text}`, message.role === 'user' ? 'user' : 'event'); }); } catch {}
    if (state.ws) state.ws.close();
    state.ws = new WebSocket(state.base.replace(/^http/, 'ws') + '/api/v1/ws', ['access-token.' + state.token]);
    state.ws.onopen = () => { state.ws.send(JSON.stringify({type: 'subscribe', agentId: agent.agentId})); say('WebSocket 已连接', 'system'); };
    state.ws.onmessage = handleAgentEvent;
    state.ws.onerror = () => say('WebSocket 连接失败，请检查 API 地址和 Token', 'system');
    await refreshAgents();
  }
  function handleAgentEvent(event) {
    const message = JSON.parse(event.data); if (message.type !== 'agent_event') return; const ev = message.event;
    if (ev.type === 'agent_start') { state.streamEl = null; $('agentTitle').textContent = `${state.agent.agentId} · streaming`; }
    else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
      if (!state.streamEl) state.streamEl = say('', 'event'); state.streamEl.textContent += ev.assistantMessageEvent.delta;
    } else if (ev.type === 'tool_execution_start') say(`🔧 ${ev.toolName}\n${JSON.stringify(ev.args || {}, null, 2)}`, 'event');
    else if (ev.type === 'tool_execution_end') say(`✓ ${ev.toolName}${ev.isError ? '（失败）' : ''}`, 'system');
    else if (ev.type === 'agent_end') { state.streamEl = null; $('agentTitle').textContent = `${state.agent.agentId} · idle`; refreshAgents(); }
    else if (ev.type === 'auto_retry_start') say(`正在重试：${ev.errorMessage || ''}`, 'system');
  }

  $('connect').onclick = connect; $('refreshWs').onclick = refreshWs; $('workspaces').onchange = selectWs;
  $('treeRoot').onclick = () => openDirectory('.');
  $('treeUp').onclick = () => { if (state.treePath === '.') return; const parts = state.treePath.split('/'); parts.pop(); openDirectory(parts.join('/') || '.'); };
  $('treePath').oncontextmenu = event => showContextMenu(event, {relativePath: state.treePath, type: 'directory'});
  $('menuSetCwd').onclick = () => { $('agentCwd').value = state.contextTarget.relativePath; $('contextMenu').hidden = true; };
  $('menuMention').onclick = () => { mentionTarget(); $('contextMenu').hidden = true; };
  document.addEventListener('click', event => { if (!$('contextMenu').contains(event.target)) $('contextMenu').hidden = true; });
  $('clear').onclick = () => $('messages').replaceChildren();
  $('abort').onclick = () => state.agent && api(`/api/v1/agents/${state.agent.agentId}/abort`, {method: 'POST', body: '{}'});
  $('newAgent').onclick = async () => {
    if (!state.workspace) return alert('请先选择 workspace');
    try {
      const agent = await api('/api/v1/agents', {method: 'POST', body: JSON.stringify({workspaceId: state.workspace.id, relativeCwd: $('agentCwd').value.trim() || '.'})});
      await refreshAgents(); await selectAgent(agent);
    } catch (error) { alert(`创建 Agent 失败：${error.message}`); }
  };
  $('addWs').onclick = async () => { const label = prompt('名称'), rootPath = prompt('主机绝对路径'); if (label && rootPath) { await api('/api/v1/workspaces', {method: 'POST', body: JSON.stringify({label, rootPath})}); await refreshWs(); } };
  $('prompt').onsubmit = async event => { event.preventDefault(); if (!state.agent) return alert('请先创建或选择 Agent'); const text = $('input').value.trim(); if (!text) return; say(text, 'user'); $('input').value = ''; try { await api(`/api/v1/agents/${state.agent.agentId}/prompt`, {method: 'POST', body: JSON.stringify({message: text})}); } catch (error) { say(error.message, 'system'); } };
  $('input').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('prompt').requestSubmit(); };
})();
