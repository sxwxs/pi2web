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
    workspaces: [], agents: [], ws: null, reconnectTimer: null, refreshTimer: null, lastToken: null,
    modelCatalogs: new Map(), agentCapabilities: new Map()};

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
    socket.onopen = () => {socket.send(JSON.stringify({type: 'subscribe_collab'})); socket.send(JSON.stringify({type: 'subscribe_all', fromNow: true}))};
    socket.onmessage = event => {
      const message = JSON.parse(event.data || '{}');
      const lifecycle = message.type === 'agent_event' && ['agent_start','agent_end','agent_settled','auto_retry_start','auto_retry_end'].includes(message.event?.type);
      if (message.type !== 'collab_event' && !lifecycle) return;
      // Collaboration changes and Agent lifecycle changes both affect whether a wait is truly stalled.
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
    const [issues, events, escalations, criteria, consensus] = await Promise.all([
      api(`/api/v1/collab/sessions/${sessionId}/issues`).catch(() => []),
      // `tail` asks for the newest events; paging from sequence 0 would freeze the timeline after 200 events.
      api(`/api/v1/collab/sessions/${sessionId}/events?tail=200`).catch(() => []),
      api(`/api/v1/collab/escalations?sessionId=${sessionId}`).catch(() => []),
      session.kind === 'scoring' ? api(`/api/v1/collab/sessions/${sessionId}/criteria`).catch(() => []) : Promise.resolve([]),
      session.kind === 'review' ? api(`/api/v1/collab/sessions/${sessionId}/review-consensus`).catch(() => ({issueVotes:[],mergeProposals:[],discussions:[],issueConsensus:[]})) : Promise.resolve(null)
    ]);
    return {session, issues, events, escalations, criteria, consensus};
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
  /** Compact live state diagram. Consensus sub-phases share one semantic step instead of exposing old API noise. */
  function reviewFlowChart(session) {
    if (session.kind !== 'review') return '';
    const groups = {draft:0, implementing:1, collecting:2, consolidating:3, validating:3, merge_voting:3, issue_discussing:3, issue_reconsidering:3, awaiting_human:3, finished:4};
    const current = groups[session.phase] ?? 0, finished = session.status === 'finished';
    const steps = [
      {label:'准备',detail:'人员与范围',group:0},
      {label:session.round > 1 ? '修复' : '开发',detail:'可选',group:1,optional:true},
      {label:'独立盲审',detail:`review round ${session.round}`,group:2},
      {label:'问题共识',detail:session.phase === 'awaiting_human' ? '等待人工裁定' : '投票 · 合并 · 讨论',group:3},
      {label:'评审完成',detail:'输出报告',group:4}
    ];
    const nodes = steps.map(step => {
      const active = !finished && step.group === current, done = finished || step.group < current;
      return `<div class="flow-step ${active?'active':''} ${done?'done':''} ${step.optional?'optional':''}"><b>${done?'✓ ':''}${esc(step.label)}</b><small>${esc(step.detail)}</small></div>`;
    });
    return `<div class="card"><h3>Review 动态流程</h3><div class="flow-chart">${nodes.map((node,index)=>`${index?'<span class="flow-arrow">→</span>':''}${node}`).join('')}</div><div class="flow-loop">评审完成后可直接复核当前代码，或先交给选定的开发 Agent 修复；随后回到“独立盲审”，不再经过 responding/adjudicating。</div></div>`;
  }
  function recheckCard(session, issues) {
    if (session.kind !== 'review' || session.status !== 'finished') return '';
    const implementers = (session.participants || []).filter(entry => entry.role === 'implementer' && entry.state === 'active');
    const actions = issues.filter(issue => ['confirmed','open','answered','escalated'].includes(issue.status));
    return `<div class="card"><h3>继续这个 Review <span class="grow"></span><span class="pill yellow">${actions.length} 个待复核问题</span></h3>
      <div class="recheck-actions"><p><b>直接复核</b>：代码已由人工或其它 Agent 修改，立即固定新 baseline 并召集原 Reviewer。</p>
        <button type="button" data-action="recheck">复核当前代码</button></div>
      <div class="recheck-actions" style="margin-top:10px"><p><b>修复后复核</b>：先把确认的问题交给一个开发 Agent；它提交 ready 后，中枢自动召集 Reviewer。</p>
        <div class="row"><label>负责修复的开发 Agent<select id="recheckImplementer">${implementers.map(entry=>`<option value="${esc(entry.participantId)}">${esc(entry.displayName)}</option>`).join('')}</select></label>
        <button type="button" data-action="fix-recheck" ${implementers.length?'':'disabled'}>推进到修复 → 复核</button></div>
        ${implementers.length?'':'<small class="muted">请先在下方参与者区域新增一个 implementer Agent。</small>'}</div>
    </div>`;
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
  const waitingAgentDetails = session => ((session.progress || {}).waitingOn || []).map(participantId => {
    const participant = (session.participants || []).find(entry => entry.participantId === participantId), agent = state.agents.find(entry => entry.agentId === participant?.agentId);
    const status = agent?.status || 'unknown', activelyRunning = ['starting','streaming','stopping'].includes(status), needsUser = status === 'waiting_for_user';
    return {participantId, name: participant?.displayName || participantId, status, activelyRunning, retryable: !activelyRunning && !needsUser};
  });
  /** Local agents that may still take a seat: the hub rejects the same agentId twice in one session. */
  const availableAgents = session => {
    const taken = new Set((session.participants || []).map(participant => participant.agentId).filter(Boolean));
    return state.agents.filter(agent => !taken.has(agent.agentId));
  };
  /** innerHTML 重建会清空正在填写的表单；刷新由每条 hub 事件触发，所以必须显式保存草稿。 */
  const PARTICIPANT_FIELDS = ['pRole', 'pAgent', 'pNewModel'];
  const readParticipantDraft = () => PARTICIPANT_FIELDS.map(id => [id, $(id)?.value ?? '']).filter(([, value]) => value !== '');
  const restoreParticipantDraft = draft => {
    for (const [id, value] of draft) {
      const field = $(id);
      if (!field) continue;
      if (field.tagName === 'SELECT' && ![...field.options].some(option => option.value === value)) continue;
      field.value = value;
    }
  };
  const normalizedPath = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  const relativeCwdFor = session => {
    const workspace = state.workspaces.find(entry => entry.id === session.workspaceId);
    if (!workspace) return '.';
    const root = normalizedPath(workspace.rootPath), cwd = normalizedPath(session.cwd);
    return cwd === root ? '.' : cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : '.';
  };
  const modelLabel = model => model?.provider && model?.id ? `${model.provider}/${model.id}` : '';
  const roleLabel = role => ({reviewer: '评审', implementer: '开发', moderator: '协调'}[role] || role);
  const generatedAgentName = (session, role) => {
    const number = (session.participants || []).filter(entry => entry.role === role).length + 1;
    return `${session.title} · ${roleLabel(role)} Agent ${number}`.slice(0, 100);
  };
  const catalogKey = session => `${session.workspaceId}:${relativeCwdFor(session)}`;
  function modelOptionsHtml(session) {
    const cached = state.modelCatalogs.get(catalogKey(session));
    if (!cached || typeof cached.then === 'function') return '<option value="">正在读取可用模型…</option>';
    if (!(cached.models || []).length) return '<option value="">没有可用模型</option>';
    return cached.models.map(model => `<option value="${esc(JSON.stringify([model.provider, model.id]))}"${model.provider === cached.model?.provider && model.id === cached.model?.id ? ' selected' : ''}>${esc(model.provider)} / ${esc(model.name || model.id)}</option>`).join('');
  }
  async function loadModelCatalog(session) {
    const key = catalogKey(session);
    if (state.modelCatalogs.has(key)) return state.modelCatalogs.get(key);
    const pending = api(`/api/v1/agents/models?workspaceId=${encodeURIComponent(session.workspaceId)}&relativeCwd=${encodeURIComponent(relativeCwdFor(session))}`)
      .then(value => {state.modelCatalogs.set(key, value); return value})
      .catch(error => {state.modelCatalogs.delete(key); throw error});
    state.modelCatalogs.set(key, pending);
    return pending;
  }
  async function agentCapabilities(agentId, force = false) {
    if (!force && state.agentCapabilities.has(agentId)) return state.agentCapabilities.get(agentId);
    const capabilities = await api(`/api/v1/agents/${encodeURIComponent(agentId)}/capabilities`);
    state.agentCapabilities.set(agentId, capabilities);
    return capabilities;
  }
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
  function issueConsensusCells(session, consensus, issueId) {
    const current = (consensus?.issueConsensus || []).find(entry => entry.issueId === issueId), discussions = (consensus?.discussions || []).filter(entry => entry.issueId === issueId);
    const votes = current?.positions?.length ? current.positions.map(position => `<div><span class="pill ${position.stance === 'approve' ? 'green' : position.stance === 'reject' ? 'red' : 'yellow'}">${esc(position.stance || '未投')}</span> ${esc(participantName(session, position.participantId))}${position.implicit ? ' <small class="muted">(提出者)</small>' : ''}${position.rationale ? `<br><small>${esc(position.rationale)}</small>` : ''}</div>`).join('') : '<span class="muted">尚未开始投票</span>';
    const thread = discussions.length ? `<details><summary>${discussions.length} 条讨论</summary>${discussions.map(message => `<div style="margin:6px 0"><b>${esc(participantName(session, message.authorId))}</b> · round ${esc(message.payload?.consensusRound ?? '')}<br>${esc(message.payload?.argument || '')}</div>`).join('')}</details>` : '<span class="muted">—</span>';
    return {votes, thread};
  }
  function mergeProposalCard(session, consensus, issues) {
    const proposals = consensus?.mergeProposals || [];
    if (!proposals.length) return '<div class="card"><h3>合并申请与投票（0）</h3><p class="muted">尚无重复 Issue 合并申请。</p></div>';
    const label = issueId => {const issue=issues.find(entry=>entry.issueId===issueId);return issue?.number ? `#${issue.number}` : issueId.slice(0, 8)};
    const reviewers=(session.participants || []).filter(entry=>entry.role==='reviewer'&&entry.state!=='left');
    return `<div class="card"><h3>合并申请与投票（${proposals.length}）</h3><table><thead><tr><th>申请</th><th>合并理由</th><th>发起者</th><th>赞成票</th><th>反对票 / 理由</th><th>结果</th></tr></thead><tbody>${proposals.map((proposal,index)=>{
      const proposers=proposal.votes.filter(vote=>vote.proposer),approves=proposal.votes.filter(vote=>vote.stance==='approve'),rejects=proposal.votes.filter(vote=>vote.stance==='reject'),complete=reviewers.every(reviewer=>proposal.votes.some(vote=>vote.participantId===reviewer.participantId)),status=rejects.length?'未通过':complete?'全票通过':'投票中';
      return `<tr><td><b>合并申请 ${index+1}</b><br>${proposal.issueIds.map(id=>`<span class="pill">${esc(label(id))}</span>`).join(' + ')}</td><td>${esc(proposal.rationale)}</td><td>${proposers.map(vote=>esc(participantName(session,vote.participantId))).join('、')}</td><td>${approves.map(vote=>esc(participantName(session,vote.participantId))).join('、')||'—'}</td><td>${rejects.map(vote=>`<b>${esc(participantName(session,vote.participantId))}</b>${vote.rationale?`：${esc(vote.rationale)}`:''}`).join('<br>')||'—'}</td><td><span class="pill ${status==='全票通过'?'green':status==='未通过'?'red':'yellow'}">${status}</span></td></tr>`}).join('')}</tbody></table></div>`;
  }
  function reviewSummaryCard(consensus) {
    const summary=consensus?.summary;if(!summary)return '';
    const tone=summary.verdict==='approved'?'green':summary.verdict==='changes_required'?'red':'yellow';
    return `<div class="card"><h3>评审总结 <span class="grow"></span><span class="pill ${tone}">${esc(summary.verdict)}</span></h3>
      <p><b>${summary.actionItemCount ? `仍有 ${summary.actionItemCount} 项需要修复或跟进` : '没有剩余修复项'}</b>（共 ${summary.totalIssues} 项）</p>
      <p class="muted">${esc(summary.description)} · 严重程度：${esc(JSON.stringify(summary.bySeverity))} · 处理结果：${esc(JSON.stringify(summary.byDisposition))}</p>
      ${summary.actionItems?.length?`<table><thead><tr><th>ID / 严重程度</th><th>需要修什么</th><th>位置</th><th>当前处理</th></tr></thead><tbody>${summary.actionItems.map(item=>`<tr><td><b>#${esc(item.number)}</b><br><span class="pill ${['blocker','critical'].includes(item.severity)?'red':item.severity==='major'?'yellow':''}">${esc(item.severity)}</span></td><td><b>${esc(item.title)}</b><br>${esc(item.description)}${item.impact?`<details><summary>影响</summary>${esc(item.impact)}</details>`:''}</td><td>${esc(item.location?.path||'')}${item.location?.startLine?`:${item.location.startLine}`:''}</td><td><span class="pill yellow">${esc(item.disposition)}</span>${item.response?.rationale?`<br><small>${esc(item.response.rationale)}</small>`:''}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">所有 Issue 都已有终态处理。</p>'}
    </div>`;
  }
  function renderDetail() {
    if (!state.detail) {$('detail').innerHTML = '<p class="muted">选择左侧的协作会话，或先创建一个。</p>'; return}
    const draft = readParticipantDraft();
    const {session, issues, events, escalations, criteria, consensus} = state.detail;
    const progress = session.progress || {};
    const pending = escalations.filter(entry => entry.status === 'pending'), waitingDetails = waitingAgentDetails(session), allRunning = waitingDetails.length > 0 && waitingDetails.every(entry => entry.activelyRunning), retryableWaiting = waitingDetails.filter(entry => entry.retryable);
    const displayedVerdict=session.kind==='review'?(consensus?.summary?.verdict||session.outcome?.verdict):session.outcome?.verdict;
    const waitingStatus = waitingDetails.map(entry => `${entry.name}（${entry.status}）`).join('、');
    const stallNotice = !session.stalled ? '' : allRunning
      ? `<div style="display:block" class="pill yellow"><b>评审耗时较长，但 Agent 仍在运行</b>（超过提醒阈值，自 ${esc(session.stalled.since)}）<br>当前状态：${esc(waitingStatus)}<br><small>这些 Agent 仍是 streaming / starting，请继续等待。不要重复提醒；提高超时时间只会延后这条提示，不会加速评审。</small></div>`
      : `<div style="display:block" class="pill red"><b>协作等待提交</b>（自 ${esc(session.stalled.since)}）<br>当前状态：${esc(waitingStatus || (session.stalled.waitingOn || []).map(id => participantName(session, id)).join('、'))}<br><small>idle / unloaded / error 表示 Agent 已不再执行但尚未提交当前阶段 API，可重新提醒；waiting_for_user 需要先到 Agent 控制台处理交互。强制推进会跳过未提交结果。</small></div>`;
    $('detail').innerHTML = `
      <div class="card">
        <h3><span class="grow">${esc(session.title)}</span>${phasePill(session)}<span class="pill">round ${session.round}</span><span class="pill">${esc(session.status)}</span></h3>
        <div class="muted">${esc(session.sessionId)} · ${esc(session.kind)} · ${esc(session.cwd)}</div>
        <div class="muted">对象：${esc(session.subject.type)} = ${esc(session.subject.value)}${session.subject.notes ? ` · ${esc(session.subject.notes)}` : ''}</div>
        ${stallNotice}
        <p class="muted">进度：${esc(JSON.stringify(progress))}</p>
        ${session.policy?.implementationFirst ? '<p class="muted">模式：先开发后评审（implementing → collecting 自动切换）</p>' : ''}
        ${session.kind === 'review' ? (session.policy?.consensusReview ? `<p class="muted">共识评审：盲审汇总 → 问题投票 / 合并提议 → 合并投票 → 最多 ${esc(session.policy.maxConsensusRounds)} 轮讨论 → 输出报告</p>` : '<p class="muted">共识评审：关闭（收集完成后直接输出报告）</p>') : ''}
        ${displayedVerdict ? `<p><span class="pill ${displayedVerdict === 'approved' ? 'green' : displayedVerdict === 'changes_required' ? 'red' : 'yellow'}">结论：${esc(displayedVerdict)}</span>${session.outcome?.approval?.unanimous ? ' <span class="pill green">问题认定已全票完成</span>' : ''}</p>` : ''}
        ${session.status === 'active' ? `<div class="row">
          <button data-action="advance">推进阶段</button>
          ${retryableWaiting.length ? `<button data-action="retry">重新提醒已停止的 Agent（${retryableWaiting.length}）</button>` : ''}
          <button data-action="force">强制跳过未提交并推进…</button>
        </div>` : ''}
      </div>

      ${reviewFlowChart(session)}
      ${recheckCard(session, issues)}

      <div class="card">
        <h3>参与者 <span class="grow"></span></h3>
        <table><thead><tr><th>名称</th><th>角色</th><th>Agent</th><th>模型</th><th>Token</th><th>状态</th><th>待办</th></tr></thead><tbody>
          ${(session.participants || []).map(participant => `<tr>
            <td>${esc(participant.displayName)}<br><small class="muted">${esc(participant.participantId)}</small></td>
            <td>${esc(participant.role)}</td>
            <td>${esc(participant.agentId || '—')} <span class="pill ${['streaming','starting'].includes(state.agents.find(agent => agent.agentId === participant.agentId)?.status) ? 'blue' : ''}">${esc(state.agents.find(agent => agent.agentId === participant.agentId)?.status || 'unknown')}</span>
              <br><button type="button" class="rebind" data-participant="${esc(participant.participantId)}">改绑…</button></td>
            <td>${esc(participant.model || '-')}</td>
            <td>${participant.tokensUsed}/${participant.tokenBudget}${participant.tokensEstimated ? ' <small class="muted">(估算)</small>' : ''}</td>
            <td>${esc(participant.state)}${participant.state === 'budget_exhausted' ? `<br><button type="button" class="raise-budget" data-participant="${esc(participant.participantId)}" data-used="${participant.tokensUsed}">提额…</button>` : ''}</td>
            <td>${participant.pendingTasks ? `<span class="pill red">${participant.pendingTasks} 未送达</span>` : '<span class="muted">-</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">还没有参与者</td></tr>'}
        </tbody></table>
        <form id="participantForm" class="row" style="margin-top:10px">
          <label>角色<select id="pRole">${session.status === 'finished' && session.kind === 'review' ? '<option value="implementer">开发 implementer</option>' : '<option value="reviewer">评审 reviewer</option><option value="implementer">开发 implementer</option><option value="moderator">协调 moderator</option>'}</select></label>
          <label>Agent<select id="pAgent" required><option value="__new__">＋ 新建 Agent</option>${availableAgents(session).map(agent => `<option value="${esc(agent.agentId)}">${esc(agent.sessionName || agent.agentId)}${agent.status ? ` (${esc(agent.status)})` : ''}</option>`).join('')}</select></label>
          <label id="pNewModelWrap" class="participant-config">新 Agent 使用的模型<select id="pNewModel" required>${modelOptionsHtml(session)}</select><small class="field-help">只列出 Pi 当前已配置凭据、在这个项目中实际可用的模型。</small></label>
          <span id="pAgentHint" class="field-help">新 Agent 的名称会根据会话和角色自动生成；模型标注会从实际模型自动填写。</span>
          <button id="participantSubmit" type="submit">新建并加入</button>
        </form>
        ${state.lastToken ? `<div class="token-box">participantToken（只显示一次；中枢已自存一份，唤醒该 Agent 时会带上它）：<br>${esc(state.lastToken)}</div>` : ''}
      </div>

      ${pending.length ? `<div class="card">
        <h3><span class="pill red">待人工裁定 ${pending.length}</span></h3>
        ${pending.map(entry => `<div style="margin-bottom:12px;border-bottom:1px solid var(--line);padding-bottom:10px">
          <b>${esc(entry.kind)}</b> <span class="pill ${entry.urgency === 'high' ? 'red' : 'yellow'}">${esc(entry.urgency)}</span>
          <p>${esc(entry.summary)}</p><p><b>问题：</b>${esc(entry.question)}</p>
          ${entry.options.length ? `<p class="muted">候选：${esc(entry.options.join(' / '))}</p>` : ''}
          ${entry.positions.length ? `<details class="raw"><summary>${entry.kind === 'issue_dispute' ? '完整投票 / 辩论记录' : '各方立场'}</summary><pre>${esc(JSON.stringify(entry.positions, null, 2))}</pre></details>` : ''}
          ${entry.kind === 'score_dispute'
            ? '<p class="muted">评分争议在下方“人工结算评分”里一次性裁定（需要每个争议维度的分数），提交后本条自动关闭。</p>'
            : `<form class="row resolve-form" data-escalation="${esc(entry.escalationId)}" style="margin-top:8px">
            <label>裁定<input name="decision" required placeholder="fix in this round"></label>
            <label style="flex:1">理由（≥10 字符）<input name="rationale" required></label>
            ${entry.refId && entry.kind === 'issue_dispute' ? `<label>Issue 处理<select name="issueDecision" required><option value="" disabled selected>选一个</option><option value="reopen">判定为有效问题，交给实现 Agent（reopen）</option><option value="wontfix">判定不是问题 / 无需修复（wontfix）</option><option value="resolved">人工确认已解决（resolved）</option><option value="closed">直接关闭（closed）</option></select></label>` : ''}
            ${escalationRemedy(session, entry)}
            <button type="submit">提交裁定</button>
          </form>`}
        </div>`).join('')}
      </div>` : ''}

      ${finalizeCard(session, criteria)}

      ${session.kind === 'review' ? `${reviewSummaryCard(consensus)}<div class="card">
        <h3>Issues（${issues.length}）<span class="grow"></span><span class="muted">当前共识轮次 ${session.debateRound || 0} / ${session.policy?.maxConsensusRounds || 3}</span></h3>
        <table><thead><tr><th>ID</th><th>标题 / 提出者</th><th>严重程度</th><th>状态</th><th>问题投票</th><th>Discussion</th></tr></thead><tbody>
          ${issues.map(issue => {const cells=issueConsensusCells(session, consensus, issue.issueId),merged=issues.find(entry=>entry.issueId===issue.mergedInto),summaryItem=consensus?.summary?.issues?.find(entry=>entry.issueId===issue.issueId),disposition=summaryItem?.disposition||issue.status;return `<tr>
            <td><b title="${esc(issue.issueId)}">#${esc(issue.number || '?')}</b></td>
            <td><b>${esc(issue.title)}</b><br><small>${esc(participantName(session, issue.reporterId))}</small><br><small class="muted">${esc(issue.category)} · ${esc(issue.location?.path || '')}${issue.location?.startLine ? `:${issue.location.startLine}` : ''}</small></td>
            <td><span class="pill ${['blocker','critical'].includes(issue.severity)?'red':issue.severity==='major'?'yellow':''}">${esc(issue.severity)}</span></td>
            <td>${esc(disposition)}${disposition!==issue.status?`<br><small class="muted">原状态：${esc(issue.status)}</small>`:''}${issue.mergedInto ? `<br><small>→ #${esc(merged?.number || '?')}</small>` : ''}</td><td>${cells.votes}</td><td>${cells.thread}</td></tr>`}).join('') || '<tr><td colspan="6" class="muted">还没有 issue</td></tr>'}
        </tbody></table></div>${mergeProposalCard(session, consensus, issues)}` : `<div class="card">
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

  async function updateParticipantAgentUi(session) {
    const select = $('pAgent'), modelSelect = $('pNewModel'), wrap = $('pNewModelWrap'), hint = $('pAgentHint'), submit = $('participantSubmit');
    if (!select || !modelSelect || !wrap || !hint || !submit) return;
    const isNew = select.value === '__new__';
    wrap.hidden = !isNew; modelSelect.required = isNew; submit.textContent = isNew ? '新建并加入' : '加入协作'; submit.disabled = false;
    if (isNew) {
      const generated = generatedAgentName(session, $('pRole').value);
      hint.textContent = `将自动命名为“${generated}”；参与者名称和模型标注均自动填写。`;
      const previous = modelSelect.value;
      modelSelect.replaceChildren(Object.assign(document.createElement('option'), {value: '', textContent: '正在读取可用模型…'}));
      try {
        const capabilities = await loadModelCatalog(session);
        if (state.sessionId !== session.sessionId || $('pAgent')?.value !== '__new__') return;
        const models = capabilities.models || [];
        modelSelect.replaceChildren(...models.map(model => {
          const option = document.createElement('option');
          option.value = JSON.stringify([model.provider, model.id]);
          option.textContent = `${model.provider} / ${model.name || model.id}`;
          option.selected = previous ? option.value === previous : model.provider === capabilities.model?.provider && model.id === capabilities.model?.id;
          return option;
        }));
        if (!models.length) {
          modelSelect.replaceChildren(Object.assign(document.createElement('option'), {value: '', textContent: '没有可用模型'}));
          submit.disabled = true; hint.textContent = 'Pi 当前没有可用模型。请先在 Pi 中配置模型凭据。';
        }
      } catch (error) {
        if (state.sessionId !== session.sessionId) return;
        modelSelect.replaceChildren(Object.assign(document.createElement('option'), {value: '', textContent: '模型加载失败'}));
        submit.disabled = true; hint.textContent = `无法读取模型：${error.message}`;
      }
      return;
    }
    const agentId = select.value, agent = state.agents.find(entry => entry.agentId === agentId);
    hint.textContent = `使用“${agent?.sessionName || agent?.agentId || agentId}”；正在读取实际模型…`;
    try {
      const capabilities = await agentCapabilities(agentId, true);
      if (state.sessionId !== session.sessionId || $('pAgent')?.value !== agentId) return;
      const actual = modelLabel(capabilities.model);
      hint.textContent = `使用“${agent?.sessionName || agent?.agentId || agentId}”${actual ? `；模型标注将自动填写为 ${actual}` : '；当前 Agent 未报告模型'}。`;
    } catch (error) {
      if ($('pAgent')?.value === agentId) hint.textContent = `无法读取该 Agent 的实际模型：${error.message}`;
    }
  }

  function bindDetail() {
    const sessionId = state.sessionId;
    const guard = fn => async event => {
      event?.preventDefault();
      try {await fn(); await refreshAll()} catch (error) {toast(error.message)}
    };
    if ($('pAgent')) $('pAgent').onchange = () => void updateParticipantAgentUi(state.detail.session);
    if ($('pRole')) $('pRole').onchange = () => void updateParticipantAgentUi(state.detail.session);
    if ($('pAgent')) void updateParticipantAgentUi(state.detail.session);
    for (const button of $('detail').querySelectorAll('[data-action]')) {
      const action = button.dataset.action;
      button.onclick = guard(async () => {
        if (action === 'advance') {await post(`/api/v1/collab/sessions/${sessionId}/advance`, {}); toast('已推进')}
        if (action === 'retry') {
          const participantIds = waitingAgentDetails(state.detail.session).filter(entry => entry.retryable).map(entry => entry.participantId);
          if (!participantIds.length) {toast('等待中的 Agent 仍在运行，无需重复提醒'); return}
          const result=await post(`/api/v1/collab/sessions/${sessionId}/retry-waiting`, {participantIds});
          toast(result.retried.length ? `已重新提醒 ${result.retried.length} 个已停止的 Agent` : 'Agent 状态已经变化，目前没有可安全重试的对象');
        }
        if (action === 'force') {
          const reason = prompt('强制推进会跳过未提交的参与者。请说明理由（会记入事件日志）：');
          if (!reason) return;
          await post(`/api/v1/collab/sessions/${sessionId}/advance`, {force: true, reason});
          toast('已强制推进');
        }
        if (action === 'recheck') {
          if (!confirm('确认当前代码已经准备好复核？中枢会固定新 baseline 并立即召集所有 Reviewer。')) return;
          await post(`/api/v1/collab/sessions/${sessionId}/recheck`, {mode:'review_only'});
          toast('已开启新一轮复核');
        }
        if (action === 'fix-recheck') {
          const participantId = $('recheckImplementer')?.value;
          if (!participantId) throw Error('请先选择一个开发 Agent');
          await post(`/api/v1/collab/sessions/${sessionId}/recheck`, {mode:'fix_then_review', implementerParticipantIds:[participantId]});
          toast('已交给开发 Agent 修复；完成后将自动召集 Reviewer');
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
      const session = state.detail.session, role = $('pRole').value, choice = $('pAgent').value;
      let agentId = choice, displayName = '', actualModel = '', createdAgent = null;
      if (choice === '__new__') {
        const raw = $('pNewModel').value;
        if (!raw) throw Error('请先选择新 Agent 使用的模型');
        const [provider, modelId] = JSON.parse(raw);
        displayName = generatedAgentName(session, role);
        createdAgent = await post('/api/v1/agents', {
          workspaceId: session.workspaceId, relativeCwd: relativeCwdFor(session),
          model: {provider, modelId}, sessionName: displayName
        });
        agentId = createdAgent.agentId; actualModel = `${provider}/${modelId}`;
      } else {
        const agent = state.agents.find(entry => entry.agentId === agentId);
        if (!agent) throw Error('所选 Agent 已不存在，请刷新后重试');
        const capabilities = await agentCapabilities(agentId, true);
        actualModel = modelLabel(capabilities.model);
        displayName = (agent.sessionName?.trim() || generatedAgentName(session, role)).slice(0, 100);
        if (!agent.sessionName?.trim()) {
          const summary = await post(`/api/v1/agents/${encodeURIComponent(agentId)}/session-name`, {name: displayName});
          agent.sessionName = summary.sessionName || displayName;
        }
      }
      try {
        await post(`/api/v1/collab/sessions/${sessionId}/participants`, {
          role, displayName, agentId, ...(actualModel ? {model: actualModel} : {})
        });
      } catch (error) {
        // Do not leave an accidental Agent in the active list if seat registration raced with a phase change.
        if (createdAgent) await post(`/api/v1/agents/${createdAgent.agentId}/archive`).catch(() => {});
        throw error;
      }
      state.agentCapabilities.delete(agentId); state.lastToken = null;
      toast(`“${displayName}”已加入；中枢会在有任务时自动唤醒它`);
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
      const capabilities = await agentCapabilities(picked.agentId, true), actualModel = modelLabel(capabilities.model);
      await post(`/api/v1/collab/sessions/${sessionId}/participants/${button.dataset.participant}/binding`, {agentId: picked.agentId, ...(actualModel ? {model: actualModel} : {})});
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
  const subjectUi = {
    commit_range: {label: 'Git 范围', placeholder: 'HEAD~1..HEAD', value: 'HEAD~1..HEAD', help: '填写 Git revision range，例如 HEAD~1..HEAD 或 main...feature。中枢会记录这个基线范围并放进 Agent 任务包。'},
    diff: {label: '改动说明', placeholder: '当前工作区相对 HEAD 的未提交改动', value: '当前工作区相对 HEAD 的未提交改动', help: '用于评审当前工作区的 staged / unstaged / untracked 改动；这里写一句范围说明即可，实际脏状态会自动生成基线哈希。'},
    paths: {label: '文件 / 目录', placeholder: 'src/pay, test/pay.test.ts', value: 'src/', help: '填写相对于工作目录的文件或目录，多个值用逗号分隔；中枢会把它们记录为基线路径并告知 Agent。'},
    free: {label: '范围说明', placeholder: '整个工作区，重点关注支付回调', value: '整个工作区', help: '用自然语言描述评审或评分范围。该文字会原样进入所有 Agent 的任务包。'}
  };
  const subjectDrafts = {commit_range: $('newSubjectValue').value};
  let activeSubjectType = $('newSubjectType').value;
  function updateSubjectUi() {
    const type = $('newSubjectType').value, config = subjectUi[type];
    if (activeSubjectType !== type) subjectDrafts[activeSubjectType] = $('newSubjectValue').value;
    $('newSubjectValueLabel').textContent = config.label;
    $('newSubjectValue').placeholder = config.placeholder;
    $('newSubjectValue').value = subjectDrafts[type] ?? config.value;
    $('newSubjectHelp').textContent = config.help;
    activeSubjectType = type;
  }
  $('newSubjectType').onchange = updateSubjectUi;
  updateSubjectUi();
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
      const consensusRounds = Number($('newConsensusRounds').value);
      if (!Number.isInteger(consensusRounds) || consensusRounds < 1 || consensusRounds > 10) throw Error('争议辩论轮数必须是 1–10 的整数');
      const session = await post('/api/v1/collab/sessions', {
        kind: $('newKind').value, title: $('newTitle').value.trim(), workspaceId: $('newWorkspace').value, relativeCwd: $('newCwd').value.trim() || '.',
        subject: {type: $('newSubjectType').value, value: $('newSubjectValue').value.trim(), ...($('newSubjectNotes').value.trim() ? {notes: $('newSubjectNotes').value.trim()} : {})},
        policy: {consensusReview: $('newKind').value === 'review', maxConsensusRounds: consensusRounds, ...($('newImplementationFirst').checked ? {implementationFirst: true} : {})}
      });
      toast('会话已创建');
      await refreshAll(); await select(session.sessionId);
    } catch (error) {toast(error.message)}
  };
  window.addEventListener('beforeunload', () => state.ws?.close());

  if (state.token) connect(state.base, state.token).catch(() => openPair());
  else openPair();
})();
