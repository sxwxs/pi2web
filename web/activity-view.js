(() => {
  'use strict';

  // Presentation of the server-maintained Agent activity (see src/activity.ts).
  // The server reports what is happening and since when; elapsed times tick locally.
  const PHASE_TEXT = {
    waiting_llm: ['⏳', '等待 LLM 响应'],
    thinking: ['💭', 'LLM 思考中'],
    generating: ['✍️', 'LLM 输出中'],
    preparing_tool: ['🛠️', '生成工具参数'],
    running_tools: ['🔧', '执行工具'],
    retrying: ['🔁', '重试'],
    compacting: ['🗜️', '压缩上下文'],
    stopping: ['⏹️', '正在停止']
  };
  /** Streaming phases that report an estimated throughput, and how their output count reads. */
  const STREAM_COUNT = {thinking: '已思考', generating: '已输出', preparing_tool: '参数'};

  const isBusy = activity =>
    !!activity &&
    (!!activity.run ||
      (!!activity.phase?.kind && activity.phase.kind !== 'idle') ||
      !!activity.bash?.length ||
      !!activity.dialogs?.length);

  function formatDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000)),
      h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60),
      s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** What an Agent is doing, most important first: open dialogs, the run's phase, then user shell commands. */
  function activityParts(activity) {
    if (!activity) return [];
    const parts = (activity.dialogs || []).map(dialog => ({
      icon: '❓',
      text: `等待你回答${dialog.title ? `：${dialog.title}` : ''}`,
      since: dialog.since
    }));
    const phase = activity.phase;
    if (phase && phase.kind !== 'idle') {
      const [icon, label] = PHASE_TEXT[phase.kind] || ['•', phase.kind];
      const metrics = activity.metrics;
      const ttft =
        metrics?.firstResponseAt === undefined
          ? ''
          : ` · TTFT ${formatDuration(metrics.firstResponseAt - metrics.turnStartedAt)}`;
      // `textStartedAt`: backends before per-phase throughput only measured the text phase.
      const streamStartedAt = metrics?.streamStartedAt ?? metrics?.textStartedAt;
      const streaming =
        STREAM_COUNT[phase.kind] && (metrics?.streamStartedAt !== undefined || phase.kind === 'generating');
      const output = streaming && metrics?.chars ? ` · ${STREAM_COUNT[phase.kind]} ${metrics.chars} 字` : '';
      const speed =
        streaming && streamStartedAt !== undefined
          ? {speed: {tokens: metrics.estimatedTokens, since: streamStartedAt}}
          : {};
      if (phase.kind === 'running_tools')
        for (const tool of phase.tools || [])
          parts.push({
            icon,
            text: `${tool.toolName}${tool.summary ? `: ${tool.summary}` : ''}`,
            since: tool.since
          });
      else if (phase.kind === 'preparing_tool')
        parts.push({
          icon,
          text: `${label}${phase.toolName ? `：${phase.toolName}` : ''}${ttft}${output}`,
          since: phase.since,
          ...speed
        });
      else if (phase.kind === 'retrying')
        parts.push({
          icon,
          text: `${label}${phase.attempt ? ` ${phase.attempt}/${phase.maxAttempts || '?'}` : ''}${phase.error ? ` · ${phase.error}` : ''}`,
          since: phase.since
        });
      else parts.push({icon, text: `${label}${ttft}${output}`, since: phase.since, ...speed});
    }
    if (activity.pauseRequested)
      parts.push({
        icon: '⏸️',
        text: activity.pauseRequested.reached ? '已到暂停点，正在收尾' : '将在下次调用模型前暂停',
        since: activity.pauseRequested.since
      });
    for (const bash of activity.bash || [])
      parts.push({icon: '$', text: bash.command || 'bash', since: bash.since});
    return parts;
  }

  /**
   * DOM builders. `serverNow(backendId)` returns that backend's current time, so
   * client clock skew does not distort elapsed times.
   */
  function createActivityView(serverNow) {
    const CHIP =
      '<span class="activity-chip"><span class="activity-text"></span><span class="activity-speed" hidden></span><span class="elapsed"></span></span>';
    const setText = (node, text) => {
      if (node.textContent !== text) node.textContent = text;
    };
    /** An elapsed time ticks while it has `data-since`. */
    function setElapsed(span, backendId, since) {
      span.dataset.since = String(since);
      span.dataset.backend = backendId || '';
      setText(span, formatElapsed(serverNow(backendId) - since));
    }
    function elapsed(backendId, since) {
      const span = document.createElement('span');
      span.className = 'elapsed';
      setElapsed(span, backendId, since);
      return span;
    }
    function chip(part, backendId) {
      const node = document.createElement('span');
      node.innerHTML = CHIP;
      fillChip(node.firstElementChild, part, backendId);
      return node.firstElementChild;
    }
    /** Show `part` in an existing chip. Only its text and data change, so a chip can follow an Agent. */
    function fillChip(node, part, backendId) {
      const [text, speed, time] = node.children;
      setText(text, `${part.icon} ${part.text}`);
      text.title = part.text;
      speed.hidden = !part.speed;
      if (part.speed) {
        speed.dataset.tokens = String(part.speed.tokens);
        speed.dataset.since = String(part.speed.since);
        speed.dataset.backend = backendId || '';
        setText(speed, speedText(part.speed.tokens, serverNow(backendId) - part.speed.since));
      } else delete speed.dataset.since;
      setElapsed(time, backendId, part.since);
    }
    /** The full activity of the selected Agent: every part plus the run's total time. */
    function bar(activity, backendId) {
      const nodes = activityParts(activity).map(part => chip(part, backendId));
      if (activity?.run) {
        const run = document.createElement('span');
        run.className = 'activity-run';
        run.append('本次运行 ', elapsed(backendId, activity.run.startedAt));
        nodes.push(run);
      }
      return nodes;
    }
    /**
     * One compact line in an Agent list card: the most important part and how many more there are.
     * It is filled in place, so the card keeps the same elements however its Agent's activity changes.
     */
    function updateLine(node, activity, backendId) {
      if (!node.firstElementChild) node.innerHTML = `${CHIP}<span></span>`;
      const parts = activityParts(activity),
        [chipNode, more] = node.children;
      node.hidden = !parts.length;
      if (!parts.length) {
        for (const span of chipNode.querySelectorAll('[data-since]')) delete span.dataset.since;
        return;
      }
      fillChip(chipNode, parts[0], backendId);
      more.hidden = parts.length < 2;
      setText(more, `+${parts.length - 1}`);
    }
    function speedText(tokens, ms) {
      return ms < 1000 ? ' · 估算中' : ` · 约 ${((tokens * 1000) / ms).toFixed(1)} token/s`;
    }
    function tick() {
      for (const el of document.querySelectorAll('.elapsed[data-since]'))
        el.textContent = formatElapsed(serverNow(el.dataset.backend) - Number(el.dataset.since));
      for (const el of document.querySelectorAll('.activity-speed[data-since]'))
        el.textContent = speedText(
          Number(el.dataset.tokens),
          serverNow(el.dataset.backend) - Number(el.dataset.since)
        );
    }
    return {bar, updateLine, tick};
  }

  window.ActivityView = {isBusy, formatElapsed, activityParts, createActivityView};
})();
