(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {
    base: localStorage.rpBase || location.origin, token: '', workspace: null, workspaces: [], treePath: '.',
    filePath: null, fileOffset: 0, fileSize: 0, fileLimit: 64 * 1024, agent: null, agents: [], ws: null,
    reconnectTimer: null, reconnectAttempt: 0, manuallyClosed: false, streams: new Map(), contextTarget: null,
    mentionPath: '.', extensionStatus: new Map(), widgets: new Map(), contexts: new Map(), connected: false,
  };
  $('api').value = state.base;
  $('pairBase').value = state.base;

  const clean = value => String(value || '').split('\\').join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const joinPath = (base, name) => base === '.' ? name : `${base}/${name}`;
  const parentPath = value => { const p = value.split('/'); p.pop(); return p.join('/') || '.'; };
  const absolutePath = relative => clean(`${state.workspace.rootPath}/${relative === '.' ? '' : relative}`);
  const isInside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
  const relativeTo = (file, dir) => file === dir ? '.' : file.slice(dir.length + 1);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toast = text => { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 3000); };
  const requireConnection = () => { if (!state.connected) { openPair(); return false; } return true; };

  async function api(url, options = {}) {
    if (!state.token) throw Error('请先输入配对码');
    const headers = {Authorization: `Bearer ${state.token}`, ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers};
    const response = await fetch(state.base + url, {...options, headers});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) disconnect('配对码无效或已失效');
      throw Error(body.error?.message || `HTTP ${response.status}`);
    }
    return body.data;
  }
  const post = (url, body = {}) => api(url, {method:'POST', body:JSON.stringify(body)});

  function openPair() {
    $('pairBase').value = state.base;
    $('pairToken').value = localStorage.rpToken || '';
    if (!$('pairDialog').open) $('pairDialog').showModal();
  }
  async function connect(base, token) {
    state.base = base.trim().replace(/\/$/, '') || location.origin;
    state.token = token.trim();
    localStorage.rpBase = state.base;
    $('api').value = state.base;
    const status = await api('/api/v1/system/status');
    if (status.protocolVersion !== 1) throw Error(`不支持的协议版本 ${status.protocolVersion}（需要 1）`);
    state.connected = true;
    $('status').className = 'ok'; $('status').textContent = '已配对';
    $('serverInfo').textContent = `v${status.version} · Pi ${status.piVersion}`;
    await refreshWs(); await refreshAgents(true);
    if (localStorage.rpToken !== state.token) {
      if (confirm('是否将配对码保存到浏览器本地存储？\n\n请仅在可信设备上保存。')) localStorage.rpToken = state.token;
      else localStorage.removeItem('rpToken');
    }
    $('pairDialog').close();
  }
  function disconnect(reason = '未配对') {
    state.connected = false; state.token = ''; state.manuallyClosed = true;
    clearTimeout(state.reconnectTimer); state.ws?.close(); state.ws = null;
    $('status').className = 'bad'; $('status').textContent = reason; $('serverInfo').textContent = '';
  }

  async function refreshWs() {
    if (!requireConnection()) return;
    state.workspaces = await api('/api/v1/workspaces');
    $('workspaces').replaceChildren(...state.workspaces.map(workspace => {
      const option = document.createElement('option'); option.value = workspace.id;
      option.textContent = `${workspace.label} (${workspace.rootPath})`; return option;
    }));
    const wanted = state.workspace?.id || localStorage.rpWorkspaceId;
    if (state.workspaces.length) {
      $('workspaces').value = state.workspaces.some(x => x.id === wanted) ? wanted : state.workspaces[0].id;
      await selectWorkspace();
    } else {
      state.workspace = null; $('tree').innerHTML = '<div class="muted">请添加 Workspace</div>';
    }
  }
  async function selectWorkspace() {
    state.workspace = state.workspaces.find(x => x.id === $('workspaces').value);
    if (!state.workspace) return;
    localStorage.rpWorkspaceId = state.workspace.id; state.treePath = '.'; $('agentCwd').value = '.'; $('filePanel').hidden = true;
    await loadTree();
  }
  async function loadTree() {
    if (!state.workspace) return;
    $('treePath').textContent = absolutePath(state.treePath);
    try {
      const items = await api(`/api/v1/workspaces/${state.workspace.id}/tree?path=${encodeURIComponent(state.treePath)}`);
      $('tree').replaceChildren(...items.map(item => {
        const el = document.createElement('div'); el.className = `entry ${item.type === 'directory' ? 'dir' : 'file-entry'}`;
        el.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`;
        const relativePath = joinPath(state.treePath, item.name);
        el.onclick = () => item.type === 'directory' ? openDirectory(relativePath) : openFile(relativePath, 0);
        el.oncontextmenu = event => showContextMenu(event, {relativePath, type:item.type}); return el;
      }));
    } catch (error) { $('tree').textContent = error.message; }
  }
  async function openDirectory(relativePath) { state.treePath = relativePath; $('filePanel').hidden = true; await loadTree(); }
  async function openFile(relativePath, offset) {
    try {
      const file = await api(`/api/v1/workspaces/${state.workspace.id}/file?path=${encodeURIComponent(relativePath)}&offset=${offset}&limit=${state.fileLimit}`);
      state.filePath = relativePath; state.fileOffset = file.offset; state.fileSize = file.size;
      $('filePanel').hidden = false; $('fileName').textContent = relativePath;
      $('file').textContent = file.binary ? `[二进制文件，${file.size} bytes，无法预览]` : file.content;
      $('filePage').textContent = `${file.offset.toLocaleString()}–${Math.min(file.offset + file.limit, file.size).toLocaleString()} / ${file.size.toLocaleString()} bytes`;
      $('filePrev').disabled = file.offset <= 0; $('fileNext').disabled = file.binary || file.offset + file.limit >= file.size;
    } catch (error) { toast(error.message); }
  }
  function showContextMenu(event, target) {
    event.preventDefault(); state.contextTarget = target; $('menuSetCwd').hidden = target.type !== 'directory';
    const menu = $('contextMenu'); menu.hidden = false; menu.style.left = `${Math.min(event.clientX, innerWidth - 210)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 90)}px`;
  }
  function insertMention(relativePath) {
    if (!state.workspace) return;
    const target = absolutePath(relativePath), cwd = clean(state.agent?.cwd || absolutePath($('agentCwd').value.trim() || '.'));
    const path = isInside(target, cwd) ? relativeTo(target, cwd) : target;
    const mention = `@${path.includes(' ') ? `"${path}"` : path}`; const input = $('input');
    const start = input.selectionStart, before = input.value.slice(0, start), match = before.match(/(^|\s)@[^\s]*$/);
    const from = match ? start - match[0].length + (match[1] ? 1 : 0) : start;
    input.setRangeText(`${mention} `, from, start, 'end'); input.focus(); closeMention();
  }
  async function openMention(path = state.treePath) {
    if (!state.workspace) return;
    state.mentionPath = path; $('mentionPicker').hidden = false; $('mentionPath').textContent = absolutePath(path);
    try {
      const items = await api(`/api/v1/workspaces/${state.workspace.id}/tree?path=${encodeURIComponent(path)}`);
      const current = document.createElement('div'); current.className = 'picker-item dir'; current.textContent = '📁 引用当前目录'; current.onclick = () => insertMention(path);
      $('mentionItems').replaceChildren(current, ...items.map(item => {
        const el = document.createElement('div'); el.className = `picker-item ${item.type === 'directory' ? 'dir' : 'file-entry'}`;
        el.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`; const p = joinPath(path, item.name);
        el.onclick = () => item.type === 'directory' ? openMention(p) : insertMention(p); return el;
      }));
    } catch (error) { $('mentionItems').textContent = error.message; }
  }
  const closeMention = () => $('mentionPicker').hidden = true;

  function agentLabel(agent) { return agent.sessionName || agent.name || agent.agentId; }
  const formatTokens = value => { const n=Number(value); if(!Number.isFinite(n)||n<=0)return '0'; if(n>=1e6)return `${(n/1e6).toFixed(1)}M`;if(n>=1e3)return `${(n/1e3).toFixed(n>=1e4?0:1)}k`;return String(Math.round(n)); };
  const usageLevel = usage => Number(usage?.percent)>90?'usage-danger':Number(usage?.percent)>70?'usage-warning':'';
  const usageText = usage => { if(!usage)return 'Context ?';const percent=usage.percent==null?'?':`${Number(usage.percent).toFixed(1)}%`;return `${percent} · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`; };
  function renderAgentList() {
    const selected=state.agent?.agentId;
    $('agents').replaceChildren(...state.agents.map(agent => {
      const usage=state.contexts.get(agent.agentId),el=document.createElement('div');el.dataset.agentId=agent.agentId;el.className=`agent ${agent.status}${selected===agent.agentId?' selected':''}`;
      el.innerHTML=`<div class="agent-top"><b>${esc(agentLabel(agent))}</b><span class="state-badge state-${esc(agent.status)}">${esc(agent.status)}</span></div><small>${esc(agent.cwd)}</small><div class="agent-context ${usageLevel(usage)}"><span>Context</span><div class="mini-track"><i style="width:${Math.min(100,Math.max(0,Number(usage?.percent)||0))}%"></i></div><span>${esc(usageText(usage))}</span></div>`;
      el.onclick=()=>selectAgent(agent);return el;
    }));
  }
  async function loadAgentContexts(agents=state.agents) {
    await Promise.allSettled(agents.map(async agent=>{const session=await api(`/api/v1/agents/${agent.agentId}/session`);if(session.sessionName)agent.sessionName=session.sessionName;state.contexts.set(agent.agentId,session.contextUsage||null);}));
    renderAgentList();if(state.agent)updateAgentHeader();
  }
  async function refreshAgents(selectPrevious = false) {
    if (!state.connected) return;
    state.agents = await api('/api/v1/agents'); const previous = state.agent?.agentId || localStorage.rpAgentId;
    if(state.agent){const fresh=state.agents.find(x=>x.agentId===state.agent.agentId);if(fresh)state.agent=Object.assign(state.agent,fresh);}
    renderAgentList();void loadAgentContexts([...state.agents]);
    if (selectPrevious) { const found = state.agents.find(x => x.agentId === previous); if (found) await selectAgent(found); else connectSocket(); }
    else if (!state.ws) connectSocket();
  }
  function setAgentStatus(agentId,status) {
    const agent=state.agents.find(x=>x.agentId===agentId);if(!agent){void refreshAgents();return null;}agent.status=status;if(state.agent?.agentId===agentId)state.agent.status=status;renderAgentList();updateAgentHeader();return agent;
  }
  function updateAgentHeader(agent = state.agent) {
    if (!agent) return;
    $('agentTitle').textContent = agentLabel(agent); $('agentStatus').textContent = `${agent.agentId} · ${agent.cwd}`;
    const badge=$('agentStateBadge');badge.textContent=agent.status;badge.className=`state-badge state-${agent.status}`;
    const usage=state.contexts.get(agent.agentId),panel=$('contextUsage');panel.hidden=false;$('contextText').textContent=`Context ${usageText(usage)}`;const percent=Math.min(100,Math.max(0,Number(usage?.percent)||0));$('contextBar').style.width=`${percent}%`;panel.className=`context-usage ${usageLevel(usage)}`;
  }
  async function selectAgent(agent) {
    state.agent = agent; localStorage.rpAgentId = agent.agentId; updateAgentHeader();
    if (state.workspace && isInside(clean(agent.cwd), clean(state.workspace.rootPath))) $('agentCwd').value = relativeTo(clean(agent.cwd), clean(state.workspace.rootPath));
    $('messages').replaceChildren(); state.streams.clear();
    try { renderMessages(await api(`/api/v1/agents/${agent.agentId}/messages`)); await loadSessionIdentity(); } catch (error) { addCard('加载消息失败', error.message, 'error', true); }
    renderAgentList();
    connectSocket();
  }
  async function loadSessionIdentity() {
    if (!state.agent) return;
    const session = await api(`/api/v1/agents/${state.agent.agentId}/session`);
    if (session.sessionName) state.agent.sessionName = session.sessionName; state.contexts.set(state.agent.agentId,session.contextUsage||null);renderAgentList();updateAgentHeader();
  }

  function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking || part.text : part?.type === 'toolCall' ? `${part.name || 'Tool'}\n${JSON.stringify(part.arguments || {}, null, 2)}` : '').filter(Boolean).join('\n');
  }
  function addCard(title, content, kind = 'system', open = false, timestamp) {
    const details = document.createElement('details'); details.className = `msg ${kind}`; details.open = open;
    const summary = document.createElement('summary'); summary.textContent = (title || String(content).split('\n')[0] || kind).slice(0, 80);
    if (timestamp) { const time = document.createElement('span'); time.className = 'event-time'; time.textContent = new Date(timestamp * 1000).toLocaleTimeString(); summary.append(time); }
    const body = document.createElement('div'); body.className = 'msg-content'; body.textContent = content ?? '';
    details.append(summary, body); $('messages').append(details); $('messages').scrollTop = $('messages').scrollHeight; return {details, summary, body};
  }
  function renderMessages(messages) {
    if (!messages?.length) { $('messages').innerHTML = '<div class="empty">尚无消息</div>'; return; }
    for (const message of messages) {
      const role = message.role || 'event';
      if (Array.isArray(message.content) && role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) addCard(part.text.slice(0,60),part.text,'assistant');
          else if (part.type === 'thinking' && (part.thinking||part.text)) addCard('Thinking',part.thinking||part.text,'thinking');
          else if (part.type === 'toolCall') addCard(`🔧 ${part.name||'Tool'}`,JSON.stringify(part.arguments||{},null,2),'tool');
        }
      } else { const content = textContent(message.content); if (content) addCard(role === 'user' ? content.slice(0, 60) : role === 'assistant' ? content.slice(0, 60) : role, content, role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'toolResult' ? 'tool' : 'system'); }
    }
  }
  function ensureStream(key, title, kind) {
    if (!state.streams.has(key)) state.streams.set(key, addCard(title, '', kind, true));
    return state.streams.get(key);
  }
  function extensionRequest(agentId, ev, timestamp) {
    const card = addCard(ev.title || `Extension ${ev.kind}`, ev.message || ev.placeholder || ev.prefill || '', 'system', true, timestamp);
    const controls = document.createElement('div'); controls.className = 'dialog-actions';
    const send = async value => { try { await post(`/api/v1/agents/${agentId}/extension-response`, {requestId:ev.requestId, value}); controls.replaceChildren(document.createTextNode('已响应')); } catch (e) { toast(e.message); } };
    if (ev.kind === 'select') for (const option of ev.options || []) { const b = document.createElement('button'); b.textContent = option; b.onclick = () => send(option); controls.append(b); }
    else if (ev.kind === 'confirm') { for (const [label, value] of [['否',false],['是',true]]) { const b=document.createElement('button');b.textContent=label;b.onclick=()=>send(value);controls.append(b); } }
    else { const input = ev.kind === 'editor' ? document.createElement('textarea') : document.createElement('input'); input.value = ev.prefill || ''; input.placeholder = ev.placeholder || ''; const b = document.createElement('button'); b.textContent = '提交'; b.onclick = () => send(input.value); controls.append(input,b); }
    card.body.append(controls);
  }
  function handleAgentEvent(message) {
    if (message.type === 'subscribed') {
      const key = `rpSeq:${message.agentId}`, saved = Number(localStorage[key] || 0), current = Number(message.currentSequence || 0);
      // Agent event sequences restart when the server restores an Agent. A cursor
      // from the previous process must not cause every new event to be discarded.
      if (saved > current) localStorage[key] = current;
      return;
    }
    if (message.type === 'agent_snapshot') {
      localStorage[`rpSeq:${message.agentId}`] = message.lastSequence; if (state.agent?.agentId === message.agentId) { $('messages').replaceChildren(); renderMessages(message.messages); } return;
    }
    if (message.type !== 'agent_event') return;
    const key = `rpSeq:${message.agentId}`, last = Number(localStorage[key] || 0); if (message.sequence <= last) return; localStorage[key] = message.sequence;
    const ev = message.event || {}, selected = state.agent?.agentId === message.agentId;
    let eventAgent=state.agents.find(x=>x.agentId===message.agentId);
    if (ev.type === 'agent_start' || ev.type === 'auto_retry_start') eventAgent=setAgentStatus(message.agentId,'streaming')||eventAgent;
    else if (ev.type === 'agent_end') {
      const final=!ev.willRetry;eventAgent=setAgentStatus(message.agentId,final?'idle':'streaming')||eventAgent;
      if(final){if(selected)state.streams.clear();notifyComplete(eventAgent||{agentId:message.agentId},message.timestamp);if(eventAgent)void loadAgentContexts([eventAgent]);}
    } else if (ev.type === 'agent_settled') { eventAgent=setAgentStatus(message.agentId,'idle')||eventAgent;if(eventAgent)void loadAgentContexts([eventAgent]); }
    if (!selected) return;
    if (ev.type === 'agent_start') { $('messages').querySelector('.empty')?.remove(); }
    else if (ev.type === 'message_update') {
      const update = ev.assistantMessageEvent || {};
      if (update.type === 'text_delta') { const c=ensureStream('assistant','Assistant','assistant'); c.body.textContent += update.delta || ''; c.summary.firstChild.textContent = (c.body.textContent || 'Assistant').slice(0,60); }
      else if (update.type === 'thinking_delta') ensureStream('thinking','Thinking','thinking').body.textContent += update.delta || '';
    } else if (ev.type === 'tool_execution_start') addCard(`🔧 ${ev.toolName || 'Tool'}`, JSON.stringify(ev.args || {}, null, 2), 'tool', false, message.timestamp);
    else if (ev.type === 'tool_execution_end') addCard(`${ev.isError ? '✗' : '✓'} ${ev.toolName || 'Tool'}`, textContent(ev.result) || (ev.isError ? '执行失败' : '执行完成'), ev.isError ? 'error' : 'tool', false, message.timestamp);
    else if (ev.type === 'auto_retry_start' || ev.type === 'auto_retry_end') addCard('Retry', ev.errorMessage || ev.type, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_request') extensionRequest(message.agentId, ev, message.timestamp);
    else if (ev.type === 'extension_ui_notify') addCard(ev.notificationType || '通知', ev.message, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_status') { ev.text ? state.extensionStatus.set(ev.key, ev.text) : state.extensionStatus.delete(ev.key); renderExtensionStatus(); }
    else if (ev.type === 'extension_ui_widget') { ev.content ? state.widgets.set(ev.key, ev.content) : state.widgets.delete(ev.key); renderWidgets(); }
    else if (ev.type === 'extension_ui_title') { state.agent.sessionName = ev.title; updateAgentHeader(); }
    else if (ev.type === 'extension_ui_working_message') { ev.message ? state.extensionStatus.set('working',ev.message) : state.extensionStatus.delete('working'); renderExtensionStatus(); }
    else if (!['message_start','message_end','agent_end','agent_settled'].includes(ev.type)) addCard(ev.title || ev.type || 'Event', JSON.stringify(ev, null, 2), 'system', false, message.timestamp);
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  function renderExtensionStatus() { let row=$('extensionStatus'); if (!state.extensionStatus.size) { row?.remove(); return; } if(!row){row=document.createElement('div');row.id='extensionStatus';row.className='status-row';$('widgets').after(row);} row.textContent=[...state.extensionStatus.values()].join(' · '); }
  function renderWidgets() { $('widgets').replaceChildren(...[...state.widgets.entries()].map(([key,value])=>{const el=document.createElement('div');el.className='widget';el.dataset.key=key;el.textContent=Array.isArray(value)?value.map(x=>typeof x==='string'?x:x.text||'').join('\n'):String(value);return el;})); }

  function connectSocket() {
    if (!state.connected) return;
    clearTimeout(state.reconnectTimer); state.manuallyClosed = true; const previous=state.ws; state.ws=null; previous?.close(); state.manuallyClosed = false;
    const ws = new WebSocket(state.base.replace(/^http/, 'ws') + '/api/v1/ws', ['access-token.' + state.token]); state.ws = ws;
    ws.onopen = () => { state.reconnectAttempt = 0; $('status').textContent = '已配对 · 实时'; for (const agent of state.agents) { const key=`rpSeq:${agent.agentId}`, cursor=localStorage[key]; ws.send(JSON.stringify(cursor===undefined?{type:'subscribe',agentId:agent.agentId,fromNow:true}:{type:'subscribe',agentId:agent.agentId,lastSequence:Number(cursor)})); } ws.send(JSON.stringify({type:'subscribe_all',fromNow:true})); };
    ws.onmessage = event => { try { handleAgentEvent(JSON.parse(event.data)); } catch (error) { console.error(error); } };
    ws.onclose = () => { if (!state.connected || state.manuallyClosed || ws !== state.ws) return; $('status').textContent = '正在重连…'; const delays=[1000,2000,4000,8000,15000,30000], delay=delays[Math.min(state.reconnectAttempt++,delays.length-1)]; state.reconnectTimer=setTimeout(connectSocket,delay); };
    ws.onerror = () => {};
  }
  function updateNotificationButton() {
    const button=$('notifications');
    if (!('Notification' in window)) { button.textContent='通知不受支持'; button.disabled=true; return; }
    button.disabled=Notification.permission==='denied';
    button.textContent=Notification.permission==='granted'?'通知已启用':Notification.permission==='denied'?'通知已禁用':'启用通知';
  }
  async function enableNotifications() {
    if (!('Notification' in window)) return toast('当前浏览器不支持系统通知');
    const permission=await Notification.requestPermission(); updateNotificationButton();
    toast(permission==='granted'?'已启用所有 Agent 的完成通知':'未获得通知权限，请在浏览器设置中开启');
  }
  function notifyComplete(agent, timestamp) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const occurredAt=Number(timestamp)||Math.floor(Date.now()/1000);
    try { new Notification('Agent 完成', {body:`${agentLabel(agent)} 已转为空闲\n本地时间：${new Date(occurredAt*1000).toLocaleString()}\nUnix 时间戳：${occurredAt}`, timestamp:occurredAt*1000, tag:`remote-pi-${agent.agentId}-${occurredAt}`}); } catch (error) { console.error('Unable to show notification',error); }
  }

  function modal(title, build, okText = '确定') {
    const dialog=$('modal'), body=$('modalBody'); $('modalTitle').textContent=title; $('modalOk').textContent=okText; body.replaceChildren(); const value=build(body);
    return new Promise(resolve => { const done=()=>{dialog.removeEventListener('close',done);resolve(dialog.returnValue==='default'?(typeof value==='function'?value():value):null);};dialog.addEventListener('close',done);dialog.showModal(); });
  }
  const field = (body, label, value='', type='text') => { const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.type=type;input.value=value;l.append(input);body.append(l);return input; };
  async function createAgent() {
    if (!state.workspace) return toast('请先选择 Workspace');
    const cwd=$('agentCwd').value.trim()||'.'; let sessions=[]; try { sessions=await api(`/api/v1/sessions?workspaceId=${state.workspace.id}&path=${encodeURIComponent(cwd)}`); } catch(e){return toast(e.message);}
    const result=await modal('新建 Agent',body=>{const c=field(body,'工作路径',cwd);const l=document.createElement('label');l.textContent='Session';const s=document.createElement('select');s.innerHTML='<option value="">新 Session</option>'+sessions.map(x=>`<option value="${esc(x.path)}">${esc(x.name||x.sessionName||x.id||x.path)} · ${esc(x.modified||'')}</option>`).join('');l.append(s);body.append(l);return()=>({cwd:c.value.trim()||'.',sessionFile:s.value||undefined});},'创建');
    if (!result) return; try { const agent=await post('/api/v1/agents',{workspaceId:state.workspace.id,relativeCwd:result.cwd,sessionFile:result.sessionFile});await refreshAgents();await selectAgent(agent);}catch(e){toast(e.message);}
  }
  async function showSessionTree() {
    if (!state.agent) return toast('请选择 Agent'); const session=await api(`/api/v1/agents/${state.agent.agentId}/session`); const entries=session.entries||[];
    const choice=await modal('Session Tree',body=>{const actionLabel=document.createElement('label');actionLabel.textContent='操作';const action=document.createElement('select');action.innerHTML='<option value="navigate">Navigate 到条目</option><option value="fork">从用户消息 Fork 新 Agent</option>';actionLabel.append(action);body.append(actionLabel);const list=document.createElement('div');list.className='modal-list';let selected='';for(const e of entries){const b=document.createElement('button');b.type='button';b.className='choice';const text=textContent(e.message?.content||e.content)||e.type;b.innerHTML=`${e.id===session.leafId?'● ':'○ '}${esc(text.slice(0,100))}<small>${esc(e.id)}</small>`;b.onclick=()=>{selected=e.id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>selected?{entryId:selected,action:action.value}:null;},'执行');
    if(choice){if(choice.action==='fork'){const result=await post(`/api/v1/agents/${state.agent.agentId}/fork`,{entryId:choice.entryId});await refreshAgents();await selectAgent(result.agent);}else{await post(`/api/v1/agents/${state.agent.agentId}/navigate`,{entryId:choice.entryId});await selectAgent(state.agent);}}
  }
  async function revert() {
    if(!state.agent)return toast('请选择 Agent');const session=await api(`/api/v1/agents/${state.agent.agentId}/session`);const users=session.userMessages||[];
    const selected=await modal('Undo / Fork',body=>{const list=document.createElement('div');list.className='modal-list';let value=null;for(const u of [...users].reverse()){const id=u.entryId||u.id;const text=u.text||u.message||textContent(u.content||'');const b=document.createElement('button');b.type='button';b.className='choice';b.textContent=text.slice(0,160);b.onclick=()=>{value=id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>value;},'Fork');
    if(selected){const result=await post(`/api/v1/agents/${state.agent.agentId}/fork`,{entryId:selected});await refreshAgents();await selectAgent(result.agent);if(result.selectedText)$('input').value=result.selectedText;}
  }
  async function modelControls() {
    if(!state.agent)return toast('请选择 Agent');const cap=await api(`/api/v1/agents/${state.agent.agentId}/capabilities`);
    const result=await modal('模型与 Thinking',body=>{const ml=document.createElement('label');ml.textContent='模型';const m=document.createElement('select');for(const x of cap.models||[]){const o=document.createElement('option');o.value=JSON.stringify([x.provider,x.id]);o.textContent=`${x.provider} / ${x.name||x.id}`;o.selected=x.provider===cap.model?.provider&&x.id===cap.model?.id;m.append(o);}ml.append(m);body.append(ml);const tl=document.createElement('label');tl.textContent='Thinking level';const t=document.createElement('select');for(const x of cap.thinkingLevels||[]){const o=document.createElement('option');o.value=x;o.textContent=x;o.selected=x===cap.thinkingLevel;t.append(o);}tl.append(t);body.append(tl);return()=>({model:m.value?JSON.parse(m.value):null,thinking:t.value});});
    if(result){if(result.model)await post(`/api/v1/agents/${state.agent.agentId}/model`,{provider:result.model[0],modelId:result.model[1]});if(result.thinking)await post(`/api/v1/agents/${state.agent.agentId}/thinking`,{level:result.thinking});toast('设置已更新');}
  }

  $('pairCancel').onclick=()=>$('pairDialog').close();
  $('pairForm').onsubmit=async event=>{event.preventDefault();$('pairSubmit').disabled=true;try{await connect($('pairBase').value,$('pairToken').value);}catch(e){$('status').className='bad';$('status').textContent='连接失败';toast(e.message);}finally{$('pairSubmit').disabled=false;}};
  $('connect').onclick=openPair; $('notifications').onclick=enableNotifications; $('api').onchange=()=>{state.base=$('api').value.replace(/\/$/,'');localStorage.rpBase=state.base;openPair();};
  $('refreshWs').onclick=()=>refreshWs().catch(e=>toast(e.message));$('addWs').onclick=async()=>{if(!requireConnection())return;const result=await modal('添加 Workspace',body=>{const n=field(body,'名称');const p=field(body,'主机绝对路径');return()=>({label:n.value.trim(),rootPath:p.value.trim()});},'添加');if(result?.label&&result.rootPath){await post('/api/v1/workspaces',result);await refreshWs();}};
  $('workspaces').onchange=selectWorkspace;$('treeRoot').onclick=()=>openDirectory('.');$('treeUp').onclick=()=>openDirectory(parentPath(state.treePath));$('mentionCurrent').onclick=()=>insertMention(state.treePath);
  $('treePath').oncontextmenu=e=>showContextMenu(e,{relativePath:state.treePath,type:'directory'});$('filePrev').onclick=()=>openFile(state.filePath,Math.max(0,state.fileOffset-state.fileLimit));$('fileNext').onclick=()=>openFile(state.filePath,state.fileOffset+state.fileLimit);
  $('menuSetCwd').onclick=()=>{$('agentCwd').value=state.contextTarget.relativePath;$('contextMenu').hidden=true;};$('menuMention').onclick=()=>{insertMention(state.contextTarget.relativePath);$('contextMenu').hidden=true;};document.addEventListener('click',e=>{if(!$('contextMenu').contains(e.target))$('contextMenu').hidden=true;});
  $('newAgent').onclick=createAgent;$('abort').onclick=()=>state.agent&&post(`/api/v1/agents/${state.agent.agentId}/abort`).catch(e=>toast(e.message));$('stop').onclick=async()=>{if(state.agent&&confirm('停止这个 Agent？')){await api(`/api/v1/agents/${state.agent.agentId}`,{method:'DELETE'});state.agent=null;await refreshAgents();}};
  $('sessionName').onclick=async()=>{if(!state.agent)return;const result=await modal('Session 名称',body=>{const n=field(body,'名称',state.agent.sessionName||'');return()=>n.value.trim();});if(result){const s=await post(`/api/v1/agents/${state.agent.agentId}/session-name`,{name:result});state.agent.sessionName=s.sessionName||result;updateAgentHeader();await refreshAgents();}};
  $('sessionTree').onclick=()=>showSessionTree().catch(e=>toast(e.message));$('undo').onclick=()=>revert().catch(e=>toast(e.message));$('controls').onclick=()=>modelControls().catch(e=>toast(e.message));$('compact').onclick=async()=>{if(!state.agent)return;const instructions=await modal('Compact',body=>{const n=field(body,'可选指令');return()=>n.value;},'开始');if(instructions!==null){await post(`/api/v1/agents/${state.agent.agentId}/compact`,{instructions:instructions||undefined});toast('Compact 完成');}};
  $('prompt').onsubmit=async event=>{event.preventDefault();if(!state.agent)return toast('请先创建或选择 Agent');const text=$('input').value.trim();if(!text)return;const mode=$('sendMode').value,agentId=state.agent.agentId,sequenceBefore=localStorage[`rpSeq:${agentId}`];$('messages').querySelector('.empty')?.remove();addCard(text.slice(0,60),text,'user');$('input').value='';try{await post(`/api/v1/agents/${agentId}/${mode}`,{message:text});if(mode==='prompt'&&state.agent?.agentId===agentId&&localStorage[`rpSeq:${agentId}`]===sequenceBefore){const messages=await api(`/api/v1/agents/${agentId}/messages`);$('messages').replaceChildren();state.streams.clear();renderMessages(messages);}}catch(e){addCard('发送失败',e.message,'error',true);}};
  $('input').onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){$('prompt').requestSubmit();return;}if(event.key==='Escape')closeMention();};$('input').oninput=()=>{const before=$('input').value.slice(0,$('input').selectionStart);if(/(^|\s)@[^\s]*$/.test(before)&&$('mentionPicker').hidden)openMention(state.treePath);};
  $('mentionUp').onclick=()=>openMention(parentPath(state.mentionPath));$('mentionClose').onclick=closeMention;
  window.addEventListener('beforeunload',()=>{state.manuallyClosed=true;state.ws?.close();});
  updateNotificationButton(); openPair();
})();
