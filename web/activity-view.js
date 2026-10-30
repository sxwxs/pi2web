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
          text: `${label}${phase.toolName ? `：${phase.toolName}` : ''}${ttft}`,
          since: phase.since
        });
      else if (phase.kind === 'retrying')
        parts.push({
          icon,
          text: `${label}${phase.attempt ? ` ${phase.attempt}/${phase.maxAttempts || '?'}` : ''}${phase.error ? ` · ${phase.error}` : ''}`,
          since: phase.since
        });
      else {
        const output = phase.kind === 'generating' && metrics?.chars ? ` · 已输出 ${metrics.chars} 字` : '';
        parts.push({
          icon,
          text: `${label}${ttft}${output}`,
          since: phase.since,
          ...(phase.kind === 'generating' && metrics?.textStartedAt !== undefined
            ? {speed: {tokens: metrics.estimatedTokens, since: metrics.textStartedAt}}
            : {})
        });
      }
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
    function elapsed(backendId, since) {
      const span = document.createElement('span');
      span.className = 'elapsed';
      span.dataset.since = String(since);
      span.dataset.backend = backendId || '';
      span.textContent = formatElapsed(serverNow(backendId) - since);
      return span;
    }
    function chip(part, backendId) {
      const node = document.createElement('span'),
        text = document.createElement('span');
      node.className = 'activity-chip';
      text.className = 'activity-text';
      text.textContent = `${part.icon} ${part.text}`;
      text.title = part.text;
      node.append(text);
      if (part.speed) {
        const speed = document.createElement('span');
        speed.className = 'activity-speed';
        speed.dataset.tokens = String(part.speed.tokens);
        speed.dataset.since = String(part.speed.since);
        speed.dataset.backend = backendId || '';
        speed.textContent = speedText(part.speed.tokens, serverNow(backendId) - part.speed.since);
        node.append(speed);
      }
      node.append(elapsed(backendId, part.since));
      return node;
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
    /** One compact line for the Agent list: the most important part and how many more there are. */
    function line(activity, backendId) {
      const parts = activityParts(activity);
      if (!parts.length) return null;
      const node = document.createElement('div');
      node.className = 'agent-activity';
      node.append(chip(parts[0], backendId));
      if (parts.length > 1) node.append(` +${parts.length - 1}`);
      return node;
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
    return {bar, line, tick};
  }

  window.ActivityView = {isBusy, formatElapsed, activityParts, createActivityView};
})();
