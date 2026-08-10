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
    // Unchecking must always clear it, including when the saved code is the one just used to reconnect.
    if ($('pairRemember').checked) localStorage.rpToken = state.token;
    else localStorage.removeItem('rpToken');
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
        // A silently swallowed agent list used to leave the seat form with nothing to bind to.
        api('/api/v1/agents').catch(error => {toast(`本机 Agent 列表加载失败：${error.message}`); return []})
      ]);
      if (state.sessionId) {
        const wanted = state.sessionId, detail = await loadDetail(wanted).catch(() => null);
        // A slower response for a session the user already left must not overwrite the current one.
        if (state.sessionId === wanted) state.detail = detail;
      }
      renderSessions(); renderWorkspaces(); renderDetail();
    } catch (error) {
      $('status').className = 'bad'; $('status').textContent = error.message;
    }
  }
  async function loadDetail(sessionId) {
    const session = await api(`/api/v1/collab/sessions/${sessionId}`);
    const [issues, events, escalations, criteria] = await Promise.all([
      api(`/api/v1/collab/sessions/${sessionId}/issues`).catch(() => []),
      // `tail` asks for the newest events; paging from sequence 0 would freeze the timeline after 200 events.
      api(`/api/v1/collab/sessions/${sessionId}/events?tail=200`).catch(() => []),
      api(`/api/v1/collab/escalations?sessionId=${sessionId}`).catch(() => []),
      session.kind === 'scoring' ? api(`/api/v1/collab/sessions/${sessionId}/criteria`).catch(() => []) : Promise.resolve([])
    ]);
    return {session, issues, events, escalations, criteria};
  }
  const select = async sessionId => {
    state.sessionId = sessionId; state.lastToken = null;
    history.replaceState({}, '', `?session=${encodeURIComponent(sessionId)}`);
    const detail = await loadDetail(sessionId).catch(error => {toast(error.message); return null});
    // Selecting A then B must not end up showing A while every action button targets B.
    if (state.sessionId !== sessionId) return;
    state.detail = detail;
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
  /** The hub reports participantIds; a human reading the board wants the names it typed in. */
  const participantName = (session, participantId) =>
    (session.participants || []).find(entry => entry.participantId === participantId)?.displayName || participantId;
  /** Local agents that may still take a seat: the hub rejects the same agentId twice in one session. */
  const availableAgents = session => {
    const taken = new Set((session.participants || []).map(participant => participant.agentId).filter(Boolean));
    return state.agents.filter(agent => !taken.has(agent.agentId));
  };
  /** innerHTML 重建会清空正在填写的表单；刷新由每条 hub 事件触发，所以必须显式保存草稿。 */
  const PARTICIPANT_FIELDS = ['pRole', 'pName', 'pAgent', 'pModel'];
  const readParticipantDraft = () => PARTICIPANT_FIELDS.map(id => [id, $(id)?.value ?? '']).filter(([, value]) => value !== '');
  const restoreParticipantDraft = draft => {
    for (const [id, value] of draft) {
      const field = $(id);
      if (!field) continue;
      if (field.tagName === 'SELECT' && ![...field.options].some(option => option.value === value)) continue;
      field.value = value;
    }
  };
  /**
   * 结算只在 awaiting_human 阶段出现，而且必须为每个争议维度填一个合法分数：
   * 空 rulings 会让中枢用 0 分关掉一个还没结束的会话。
   */
  const finalizeCard = (session, criteria) => {
    if (session.kind !== 'scoring' || session.phase !== 'awaiting_human' || session.status !== 'active') return '';
    const contested = (session.progress && session.progress.contested) || [];
    const scale = session.policy?.scoring?.scale || {min: 0, max: 10, step: 1};
    if (!contested.length) return `<div class="card"><h3>人工结算评分</h3><p class="muted">没有争议维度需要裁定；请先处理其它待裁定项。</p></div>`;
    const name = criterionId => (criteria.find(entry => entry.criterionId === criterionId) || {}).name || criterionId;
    return `<div class="card">
      <h3><span class="pill yellow">人工结算评分</span></h3>
      <p class="muted">面板在 ${contested.length} 个维度上没有收敛，请为每个维度给出最终分（${scale.min}–${scale.max}，步长 ${scale.step}）。</p>
      <form id="finalizeForm">
        ${contested.map(criterionId => `<div class="row" data-criterion="${esc(criterionId)}">
          <label>${esc(name(criterionId))}<input name="score-${esc(criterionId)}" type="number" required
            min="${scale.min}" max="${scale.max}" step="${scale.step}" style="width:90px"></label>
          <label style="flex:1">理由（≥10 字符）<input name="rationale-${esc(criterionId)}" required minlength="10"></label>
        </div>`).join('')}
        <div class="row"><button type="submit">结算并结束会话</button></div>
      </form>
    </div>`;
  };
  /**
   * 裁定只能用一次（再次提交返回 409），所以带结构化补救措施的升级必须把参数直接放在表单里：
   * 只填 decision/rationale 的话什么都不会发生，而且那一次机会就用掉了。
   */
  const escalationRemedy = (session, entry) => {
    if (entry.kind === 'budget_exhausted') {
      const seat = (session.participants || []).find(participant => participant.participantId === entry.refId);
      const used = seat ? seat.tokensUsed : 0;
      return `<label>新预算（须 > 已用 ${used}）<input name="tokenBudget" type="number" min="${used + 1}" step="1" value="${Math.max(used * 2, used + 1000)}" style="width:120px"></label>
        <span class="muted">留空 = 不提额（换人 / 强推）；提额也可事后单独调 POST /participants/{id}/budget。</span>`;
    }
    if (entry.kind === 'other') {
      const cap = session.policy?.maxTotalRounds ?? 0;
      return `<label>新的最大轮数（须 > ${cap}）<input name="maxTotalRounds" type="number" min="${cap + 1}" max="50" step="1" style="width:110px"></label>
        <span class="muted">留空 = 不抬轮次上限。</span>`;
    }
    return '';
  };
  function renderDetail() {
    if (!state.detail) {$('detail').innerHTML = '<p class="muted">选择左侧的协作会话，或先创建一个。</p>'; return}
    const draft = readParticipantDraft();
    const {session, issues, events, escalations, criteria} = state.detail;
    const progress = session.progress || {};
    const pending = escalations.filter(entry => entry.status === 'pending');
    $('detail').innerHTML = `
      <div class="card">
        <h3><span class="grow">${esc(session.title)}</span>${phasePill(session)}<span class="pill">round ${session.round}</span><span class="pill">${esc(session.status)}</span></h3>
        <div class="muted">${esc(session.sessionId)} · ${esc(session.kind)} · ${esc(session.cwd)}</div>
        <div class="muted">对象：${esc(session.subject.type)} = ${esc(session.subject.value)}${session.subject.notes ? ` · ${esc(session.subject.notes)}` : ''}</div>
        ${session.stalled ? `<p class="pill red" style="display:block">停滞自 ${esc(session.stalled.since)}，等待：${esc((session.stalled.waitingOn || []).map(id => participantName(session, id)).join('、'))}</p>` : ''}
        <p class="muted">进度：${esc(JSON.stringify(progress))}</p>
        ${session.policy?.implementationFirst ? '<p class="muted">模式：先开发后评审（implementing → collecting 自动切换）</p>' : ''}
        ${session.outcome?.verdict ? `<p><span class="pill ${session.outcome.verdict === 'approved' ? 'green' : 'yellow'}">结论：${esc(session.outcome.verdict)}</span>${session.outcome.approval?.unanimous ? ' <span class="pill green">评审全票通过</span>' : ''}</p>` : ''}
        <div class="row">
          <button data-action="advance">推进阶段</button>
          <button data-action="force">强制推进…</button>
        </div>
      </div>

      <div class="card">
        <h3>参与者 <span class="grow"></span></h3>
        <table><thead><tr><th>名称</th><th>角色</th><th>Agent</th><th>模型</th><th>Token</th><th>状态</th><th>待办</th></tr></thead><tbody>
          ${(session.participants || []).map(participant => `<tr>
            <td>${esc(participant.displayName)}<br><small class="muted">${esc(participant.participantId)}</small></td>
            <td>${esc(participant.role)}</td>
            <td>${esc(participant.agentId || '—')}
              <br><button type="button" class="rebind" data-participant="${esc(participant.participantId)}">改绑…</button></td>
            <td>${esc(participant.model || '-')}</td>
            <td>${participant.tokensUsed}/${participant.tokenBudget}${participant.tokensEstimated ? ' <small class="muted">(估算)</small>' : ''}</td>
            <td>${esc(participant.state)}${participant.state === 'budget_exhausted' ? `<br><button type="button" class="raise-budget" data-participant="${esc(participant.participantId)}" data-used="${participant.tokensUsed}">提额…</button>` : ''}</td>
            <td>${participant.pendingTasks ? `<span class="pill red">${participant.pendingTasks} 未送达</span>` : '<span class="muted">-</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">还没有参与者</td></tr>'}
        </tbody></table>
        <form id="participantForm" class="row" style="margin-top:10px">
          <label>角色<select id="pRole"><option value="reviewer">reviewer</option><option value="implementer">implementer</option><option value="moderator">moderator</option></select></label>
          <label>名称<input id="pName" required placeholder="reviewer-security"></label>
          <label>绑定 Agent<select id="pAgent" required><option value="" disabled selected>选一个本机 Agent</option>${availableAgents(session).map(agent => `<option value="${esc(agent.agentId)}">${esc(agent.sessionName || agent.agentId)}${agent.status ? ` (${esc(agent.status)})` : ''}</option>`).join('')}</select></label>
          ${availableAgents(session).length ? '' : '<span class="pill red">没有空闲的本机 Agent，请先在首页新建一个</span>'}
          <label>模型标注<input id="pModel" placeholder="anthropic/claude-sonnet-4" size="18"></label>
          <button type="submit">登记参与者</button>
        </form>
        ${state.lastToken ? `<div class="token-box">participantToken（只显示一次；中枢已自存一份，唤醒该 Agent 时会带上它）：<br>${esc(state.lastToken)}</div>` : ''}
      </div>

      ${pending.length ? `<div class="card">
        <h3><span class="pill red">待人工裁定 ${pending.length}</span></h3>
        ${pending.map(entry => `<div style="margin-bottom:12px;border-bottom:1px solid var(--line);padding-bottom:10px">
          <b>${esc(entry.kind)}</b> <span class="pill ${entry.urgency === 'high' ? 'red' : 'yellow'}">${esc(entry.urgency)}</span>
          <p>${esc(entry.summary)}</p><p><b>问题：</b>${esc(entry.question)}</p>
          ${entry.options.length ? `<p class="muted">候选：${esc(entry.options.join(' / '))}</p>` : ''}
          ${entry.positions.length ? `<details class="raw"><summary>各方立场</summary><pre>${esc(JSON.stringify(entry.positions, null, 2))}</pre></details>` : ''}
          ${entry.kind === 'score_dispute'
            ? '<p class="muted">评分争议在下方“人工结算评分”里一次性裁定（需要每个争议维度的分数），提交后本条自动关闭。</p>'
            : `<form class="row resolve-form" data-escalation="${esc(entry.escalationId)}" style="margin-top:8px">
            <label>裁定<input name="decision" required placeholder="fix in this round"></label>
            <label style="flex:1">理由（≥10 字符）<input name="rationale" required></label>
            ${entry.refId && entry.kind === 'issue_dispute' ? `<label>Issue 处理<select name="issueDecision" required><option value="" disabled selected>选一个</option><option value="resolved">resolved</option><option value="wontfix">wontfix</option><option value="closed">closed</option><option value="reopen">reopen</option></select></label>` : ''}
            ${escalationRemedy(session, entry)}
            <button type="submit">提交裁定</button>
          </form>`}
        </div>`).join('')}
      </div>` : ''}

      ${finalizeCard(session, criteria)}

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
    restoreParticipantDraft(draft);
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
      });
    }
    const finalizeForm = $('finalizeForm');
    if (finalizeForm) finalizeForm.onsubmit = guard(async () => {
      const session = state.detail.session, scale = session.policy?.scoring?.scale || {min: 0, max: 10, step: 1};
      const data = new FormData(finalizeForm);
      const rulings = [...finalizeForm.querySelectorAll('[data-criterion]')].map(row => {
        const criterionId = row.dataset.criterion, score = Number(data.get(`score-${criterionId}`));
        if (!Number.isFinite(score) || score < scale.min || score > scale.max) throw Error(`分数必须在 ${scale.min}–${scale.max} 之间`);
        if (Math.abs((score - scale.min) / scale.step - Math.round((score - scale.min) / scale.step)) > 1e-9) throw Error(`分数必须是 ${scale.step} 的整数倍`);
        const rationale = String(data.get(`rationale-${criterionId}`) || '').trim();
        if (rationale.length < 10) throw Error('每个维度的裁定都需要至少 10 个字符的理由');
        return {criterionId, score, rationale};
      });
      await post(`/api/v1/collab/sessions/${sessionId}/finalize`, {rulings});
      toast('已结算');
    });
    const participantForm = $('participantForm');
    if (participantForm) participantForm.onsubmit = guard(async () => {
      const agentId = $('pAgent').value;
      if (!agentId) throw Error('请先选一个本机 Agent：每个座位都由中枢唤醒，没有自助参与这回事');
      await post(`/api/v1/collab/sessions/${sessionId}/participants`, {
        role: $('pRole').value, displayName: $('pName').value.trim(), agentId,
        ...($('pModel').value.trim() ? {model: $('pModel').value.trim()} : {})
      });
      $('pName').value = ''; $('pModel').value = ''; $('pAgent').value = '';
      state.lastToken = null;
      toast('已登记，中枢会在有任务时自动唤醒该 Agent');
    });
    for (const button of $('detail').querySelectorAll('.rebind')) button.onclick = guard(async () => {
      const session = state.detail.session, choices = availableAgents(session);
      if (!choices.length) throw Error('没有空闲的本机 Agent 可以接手这个座位');
      const answer = prompt([
        '把这个座位交给哪个本机 Agent？输入序号：',
        ...choices.map((agent, index) => `${index + 1}. ${agent.sessionName || agent.agentId}${agent.status ? ` (${agent.status})` : ''}`)
      ].join('\n'), '');
      if (answer === null) return;
      const picked = choices[Number(answer.trim()) - 1];
      if (!picked) throw Error('序号无效');
      await post(`/api/v1/collab/sessions/${sessionId}/participants/${button.dataset.participant}/binding`, {agentId: picked.agentId});
      state.lastToken = null;
      toast('已改绑，待办任务会立即推送给新的 Agent（旧 token 已失效）');
    });
    for (const button of $('detail').querySelectorAll('.raise-budget')) button.onclick = guard(async () => {
      const used = Number(button.dataset.used || 0);
      const answer = prompt(`新的 token 预算（必须大于已用 ${used}）：`, String(Math.max(used * 2, used + 1000)));
      if (answer === null) return;
      await post(`/api/v1/collab/sessions/${sessionId}/participants/${button.dataset.participant}/budget`, {tokenBudget: Number(answer)});
      toast('已提额，该座位可以继续提交');
    });
    for (const form of $('detail').querySelectorAll('.resolve-form')) form.onsubmit = guard(async () => {
      const data = new FormData(form), issueDecision = String(data.get('issueDecision') || '');
      // 空字符串不能当数字发出去：中枢会把非法的 extra 直接 422，而不是默默什么都不做。
      const extra = {};
      const budget = String(data.get('tokenBudget') || '').trim();
      if (budget) extra.tokenBudget = Number(budget);
      const rounds = String(data.get('maxTotalRounds') || '').trim();
      if (rounds) extra.maxTotalRounds = Number(rounds);
      await post(`/api/v1/collab/escalations/${form.dataset.escalation}/resolve`, {
        decision: String(data.get('decision')), rationale: String(data.get('rationale')),
        ...(issueDecision ? {issueDecision} : {}), ...(Object.keys(extra).length ? {extra} : {})
      });
      toast(Object.keys(extra).length ? '裁定已生效，并已应用到会话' : '裁定已生效');
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
