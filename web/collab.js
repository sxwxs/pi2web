/**
 * Collaboration board: the human side of the multi-agent hub.
 * Everything here is done with the pairing code; agent-side endpoints (findings, scores, …) are deliberately absent.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = {base: localStorage.rpBase || location.origin, token: localStorage.rpToken || '', connected: false,
    sessions: [], sessionId: new URLSearchParams(location.search).get('session') || '', detail: null, escalations: [],
    workspaces: [], agents: [], ws: null, reconnectTimer: null, refreshTimer: null, lastToken: null};

  const toast = text => {$('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 4000)};
  async function request(base, token, url, options = {}) {
    if (!token) throw Error('请先输入配对码');
    const response = await fetch(base + url, {...options, headers: {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fields = (body.error?.fieldErrors || []).map(entry => `${entry.path}: ${entry.message}`).join('；');
      throw Error(`${body.error?.message || `HTTP ${response.status}`}${fields ? ` (${fields})` : ''}`);
    }
    return body.data;
  }
  const api = (url, options) => request(state.base, state.token, url, options);
  const post = (url, body = {}) => api(url, {method: 'POST', body: JSON.stringify(body)});

  // ---------------------------------------------------------------- connection
  function openPair() {
    $('pairBase').value = state.base;
    $('pairToken').value = state.token || localStorage.rpToken || '';
    $('pairRemember').checked = !!localStorage.rpToken;
    if (!$('pairDialog').open) $('pairDialog').showModal();
  }
  async function connect(base, token) {
    const candidateBase = base.trim().replace(/\/$/, '') || location.origin;
    await request(candidateBase, token.trim(), '/api/v1/system/status');
    state.base = candidateBase; state.token = token.trim(); state.connected = true;
    localStorage.rpBase = state.base;
    // Same rule as the main console: the code is only persisted when the user asks for it on this device.
    if ($('pairRemember').checked) localStorage.rpToken = state.token;
    else if (localStorage.rpToken && localStorage.rpToken !== state.token) localStorage.removeItem('rpToken');
    $('status').className = 'ok'; $('status').textContent = '已配对';
    $('pairDialog').close();
    openSocket();
    await refreshAll();
  }
  function openSocket() {
    state.ws?.close(); clearTimeout(state.reconnectTimer);
    const url = `${state.base.replace(/^http/, 'ws')}/api/v1/ws`;
    const socket = new WebSocket(url, [`access-token.${state.token}`]);
    state.ws = socket;
    socket.onopen = () => socket.send(JSON.stringify({type: 'subscribe_collab'}));
    socket.onmessage = event => {
      const message = JSON.parse(event.data || '{}');
      if (message.type !== 'collab_event') return;
      // Every hub event can change the board; coalesce bursts into a single refresh.
      clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(() => void refreshAll(), 250);
    };
    socket.onclose = () => {if (state.connected) state.reconnectTimer = setTimeout(openSocket, 2000)};
  }

  // ---------------------------------------------------------------- data
  async function refreshAll() {
    if (!state.connected) return;
    try {
      const status = $('statusFilter').value;
      [state.sessions, state.escalations, state.workspaces, state.agents] = await Promise.all([
        api(`/api/v1/collab/sessions?limit=100${status ? `&status=${status}` : ''}`),
        api('/api/v1/collab/escalations?status=pending'),
        api('/api/v1/workspaces').catch(() => []),
        api('/api/v1/agents').catch(() => [])
      ]);
      if (state.sessionId) state.detail = await loadDetail(state.sessionId).catch(() => null);
      renderSessions(); renderWorkspaces(); renderDetail();
    } catch (error) {
      $('status').className = 'bad'; $('status').textContent = error.message;
    }
  }
  async function loadDetail(sessionId) {
    const session = await api(`/api/v1/collab/sessions/${sessionId}`);
    const [issues, events, escalations, criteria] = await Promise.all([
      api(`/api/v1/collab/sessions/${sessionId}/issues`).catch(() => []),
      api(`/api/v1/collab/sessions/${sessionId}/events?limit=200`).catch(() => []),
      api(`/api/v1/collab/escalations?sessionId=${sessionId}`).catch(() => []),
      session.kind === 'scoring' ? api(`/api/v1/collab/sessions/${sessionId}/criteria`).catch(() => []) : Promise.resolve([])
    ]);
    return {session, issues, events, escalations, criteria};
  }
  const select = async sessionId => {
    state.sessionId = sessionId; state.lastToken = null;
    history.replaceState({}, '', `?session=${encodeURIComponent(sessionId)}`);
    state.detail = await loadDetail(sessionId).catch(error => {toast(error.message); return null});
    renderSessions(); renderDetail();
  };

  // ---------------------------------------------------------------- render
  const phasePill = session => {
    const tone = session.status !== 'active' ? 'green' : session.stalled ? 'red' : session.phase === 'awaiting_human' ? 'yellow' : 'blue';
    return `<span class="pill ${tone}">${esc(session.phase)}</span>`;
  };
  function renderSessions() {
    $('escalationBadge').innerHTML = state.escalations.length
      ? `<span class="pill red">${state.escalations.length} 项待人工裁定</span>` : '<span class="muted">无待裁定项</span>';
    $('sessions').innerHTML = state.sessions.length ? state.sessions.map(session => `
      <button class="session-item ${session.sessionId === state.sessionId ? 'selected' : ''}" data-session="${esc(session.sessionId)}">
        <b>${esc(session.title)}</b>
        <small>${esc(session.kind)} · ${phasePill(session)} · round ${session.round}${session.stalled ? ' · <span class="pill red">停滞</span>' : ''}</small>
      </button>`).join('') : '<p class="muted">没有会话</p>';
    for (const button of $('sessions').querySelectorAll('[data-session]')) button.onclick = () => void select(button.dataset.session);
  }
  function renderWorkspaces() {
    $('newWorkspace').innerHTML = state.workspaces.map(workspace => `<option value="${esc(workspace.id)}">${esc(workspace.label)}</option>`).join('');
  }
  function renderDetail() {
    if (!state.detail) {$('detail').innerHTML = '<p class="muted">选择左侧的协作会话，或先创建一个。</p>'; return}
    const {session, issues, events, escalations, criteria} = state.detail;
    const progress = session.progress || {};
    const pending = escalations.filter(entry => entry.status === 'pending');
    $('detail').innerHTML = `
      <div class="card">
        <h3><span class="grow">${esc(session.title)}</span>${phasePill(session)}<span class="pill">round ${session.round}</span><span class="pill">${esc(session.status)}</span></h3>
        <div class="muted">${esc(session.sessionId)} · ${esc(session.kind)} · ${esc(session.cwd)}</div>
        <div class="muted">对象：${esc(session.subject.type)} = ${esc(session.subject.value)}${session.subject.notes ? ` · ${esc(session.subject.notes)}` : ''}</div>
        ${session.stalled ? `<p class="pill red">停滞自 ${esc(session.stalled.since)}，等待：${esc((session.stalled.waitingOn || []).join(', '))}</p>` : ''}
        <p class="muted">进度：${esc(JSON.stringify(progress))}</p>
        ${session.policy?.implementationFirst ? '<p class="muted">模式：先开发后评审（implementing → collecting 自动切换）</p>' : ''}
        ${session.outcome?.verdict ? `<p><span class="pill ${session.outcome.verdict === 'approved' ? 'green' : 'yellow'}">结论：${esc(session.outcome.verdict)}</span>${session.outcome.approval?.unanimous ? ' <span class="pill green">评审全票通过</span>' : ''}</p>` : ''}
        <div class="row">
          <button data-action="advance">推进阶段</button>
          <button data-action="force">强制推进…</button>
          ${session.kind === 'scoring' ? '<button data-action="finalize">结算评分</button>' : ''}
        </div>
      </div>

      <div class="card">
        <h3>参与者 <span class="grow"></span></h3>
        <table><thead><tr><th>名称</th><th>角色</th><th>绑定</th><th>模型</th><th>Token</th><th>状态</th></tr></thead><tbody>
          ${(session.participants || []).map(participant => `<tr>
            <td>${esc(participant.displayName)}<br><small class="muted">${esc(participant.participantId)}</small></td>
            <td>${esc(participant.role)}</td>
            <td>${esc(participant.binding.type)}${participant.binding.agentId ? `<br><small class="muted">${esc(participant.binding.agentId)}</small>` : ''}</td>
            <td>${esc(participant.model || '-')}</td>
            <td>${participant.tokensUsed}/${participant.tokenBudget}${participant.tokensEstimated ? ' <small class="muted">(估算)</small>' : ''}</td>
            <td>${esc(participant.state)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">还没有参与者</td></tr>'}
        </tbody></table>
        <form id="participantForm" class="row" style="margin-top:10px">
          <label>角色<select id="pRole"><option value="reviewer">reviewer</option><option value="implementer">implementer</option><option value="moderator">moderator</option></select></label>
          <label>名称<input id="pName" required placeholder="reviewer-security"></label>
          <label>绑定<select id="pBinding"><option value="external">external（自建 Agent 轮询）</option><option value="managed">managed（本机 Agent，自动唤醒）</option></select></label>
          <label>Agent<select id="pAgent"><option value="">—</option>${state.agents.map(agent => `<option value="${esc(agent.agentId)}">${esc(agent.sessionName || agent.agentId)}</option>`).join('')}</select></label>
          <label>模型标注<input id="pModel" placeholder="anthropic/claude-sonnet-4" size="18"></label>
          <button type="submit">登记参与者</button>
        </form>
        ${state.lastToken ? `<div class="token-box">participantToken（只显示一次，请立即交给对应 Agent）：<br>${esc(state.lastToken)}</div>` : ''}
      </div>

      ${pending.length ? `<div class="card">
        <h3><span class="pill red">待人工裁定 ${pending.length}</span></h3>
        ${pending.map(entry => `<div style="margin-bottom:12px;border-bottom:1px solid var(--line);padding-bottom:10px">
          <b>${esc(entry.kind)}</b> <span class="pill ${entry.urgency === 'high' ? 'red' : 'yellow'}">${esc(entry.urgency)}</span>
          <p>${esc(entry.summary)}</p><p><b>问题：</b>${esc(entry.question)}</p>
          ${entry.options.length ? `<p class="muted">候选：${esc(entry.options.join(' / '))}</p>` : ''}
          ${entry.positions.length ? `<details class="raw"><summary>各方立场</summary><pre>${esc(JSON.stringify(entry.positions, null, 2))}</pre></details>` : ''}
          <form class="row resolve-form" data-escalation="${esc(entry.escalationId)}" style="margin-top:8px">
            <label>裁定<input name="decision" required placeholder="fix in this round"></label>
            <label style="flex:1">理由（≥10 字符）<input name="rationale" required></label>
            ${entry.refId && entry.kind === 'issue_dispute' ? `<label>Issue 处理<select name="issueDecision"><option value="">不改状态</option><option value="resolved">resolved</option><option value="wontfix">wontfix</option><option value="closed">closed</option><option value="reopen">reopen</option></select></label>` : ''}
            <button type="submit">提交裁定</button>
          </form>
        </div>`).join('')}
      </div>` : ''}

      ${session.kind === 'review' ? `<div class="card">
        <h3>Issues（${issues.length}）</h3>
        <table><thead><tr><th>标题</th><th>严重度</th><th>状态</th><th>位置</th><th>轮次</th></tr></thead><tbody>
          ${issues.map(issue => `<tr>
            <td>${esc(issue.title)}<br><small class="muted">${esc(issue.category)} · ${esc(issue.requiredAction)}</small></td>
            <td>${esc(issue.severity)}</td><td>${esc(issue.status)}</td>
            <td>${esc(issue.location?.path || '')}${issue.location?.startLine ? `:${issue.location.startLine}` : ''}</td>
            <td>${issue.round}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">还没有 issue</td></tr>'}
        </tbody></table></div>` : `<div class="card">
        <h3>评分维度（${criteria.length}）</h3>
        <table><thead><tr><th>名称</th><th>状态</th><th>权重</th><th>定义</th></tr></thead><tbody>
          ${criteria.map(criterion => `<tr><td>${esc(criterion.name)}</td><td>${esc(criterion.state)}</td><td>${criterion.weight ?? '-'}</td><td>${esc(criterion.definition)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">还没有维度</td></tr>'}
        </tbody></table>
        ${session.outcome ? `<details class="raw" open><summary>结算结果</summary><pre>${esc(JSON.stringify(session.outcome, null, 2))}</pre></details>` : ''}</div>`}

      <div class="card"><h3>事件（最新 ${Math.min(events.length, 60)} 条）</h3>
        <div class="events">${events.slice(-60).reverse().map(event => `<div><span class="muted">${esc(event.createdAt.slice(11, 19))}</span> <b>${esc(event.type)}</b> ${esc(JSON.stringify(event.payload).slice(0, 240))}</div>`).join('') || '<span class="muted">暂无事件</span>'}</div>
      </div>`;
    bindDetail();
  }

  function bindDetail() {
    const sessionId = state.sessionId;
    const guard = fn => async event => {
      event?.preventDefault();
      try {await fn(); await refreshAll()} catch (error) {toast(error.message)}
    };
    for (const button of $('detail').querySelectorAll('[data-action]')) {
      const action = button.dataset.action;
      button.onclick = guard(async () => {
        if (action === 'advance') {await post(`/api/v1/collab/sessions/${sessionId}/advance`, {}); toast('已推进')}
        if (action === 'force') {
          const reason = prompt('强制推进会跳过未提交的参与者。请说明理由（会记入事件日志）：');
          if (!reason) return;
          await post(`/api/v1/collab/sessions/${sessionId}/advance`, {force: true, reason});
          toast('已强制推进');
        }
        if (action === 'finalize') {await post(`/api/v1/collab/sessions/${sessionId}/finalize`, {rulings: []}); toast('已结算')}
      });
    }
    const participantForm = $('participantForm');
    if (participantForm) participantForm.onsubmit = guard(async () => {
      const bindingType = $('pBinding').value, agentId = $('pAgent').value;
      if (bindingType === 'managed' && !agentId) throw Error('managed 参与者必须选择一个本机 Agent');
      const result = await post(`/api/v1/collab/sessions/${sessionId}/participants`, {
        role: $('pRole').value, displayName: $('pName').value.trim(), ...($('pModel').value.trim() ? {model: $('pModel').value.trim()} : {}),
        binding: bindingType === 'managed' ? {type: 'managed', agentId} : {type: 'external'}
      });
      state.lastToken = bindingType === 'managed' ? null : result.participantToken;
      toast(bindingType === 'managed' ? '已登记，中枢会在有任务时自动唤醒该 Agent' : '已登记，请复制 participantToken');
    });
    for (const form of $('detail').querySelectorAll('.resolve-form')) form.onsubmit = guard(async () => {
      const data = new FormData(form), issueDecision = String(data.get('issueDecision') || '');
      await post(`/api/v1/collab/escalations/${form.dataset.escalation}/resolve`, {
        decision: String(data.get('decision')), rationale: String(data.get('rationale')), ...(issueDecision ? {issueDecision} : {})
      });
      toast('裁定已生效');
    });
  }

  // ---------------------------------------------------------------- events
  $('connect').onclick = openPair;
  $('pairCancel').onclick = () => $('pairDialog').close();
  $('pairForm').onsubmit = async event => {
    event.preventDefault();
    try {await connect($('pairBase').value, $('pairToken').value)} catch (error) {toast(error.message)}
  };
  $('refresh').onclick = () => void refreshAll();
  $('statusFilter').onchange = () => void refreshAll();
  $('createForm').onsubmit = async event => {
    event.preventDefault();
    try {
      const session = await post('/api/v1/collab/sessions', {
        kind: $('newKind').value, title: $('newTitle').value.trim(), workspaceId: $('newWorkspace').value, relativeCwd: $('newCwd').value.trim() || '.',
        subject: {type: $('newSubjectType').value, value: $('newSubjectValue').value.trim(), ...($('newSubjectNotes').value.trim() ? {notes: $('newSubjectNotes').value.trim()} : {})},
        ...($('newImplementationFirst').checked ? {policy: {implementationFirst: true}} : {})
      });
      toast('会话已创建');
      await refreshAll(); await select(session.sessionId);
    } catch (error) {toast(error.message)}
  };
  window.addEventListener('beforeunload', () => state.ws?.close());

  if (state.token) connect(state.base, state.token).catch(() => openPair());
  else openPair();
})();
