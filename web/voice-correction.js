(() => {
  'use strict';
  const PAUSE_MS = 2000;
  // A textarea stores line breaks as LF, so text compared with its value must too.
  const textareaLines = text => text.replace(/\r\n?/g, '\n');
  // Past this many edits the two texts share little, so a character diff is slow and unreadable.
  const MAX_DIFF_EDITS = 1000;

  /** Shortest edit script between two character arrays (Myers), or null beyond `limit` edits. */
  function editScript(a, b, limit) {
    const n = a.length,
      m = b.length,
      bound = Math.min(n + m, limit),
      offset = bound + 1,
      v = new Int32Array(2 * bound + 3),
      trace = [];
    for (let d = 0; d <= bound; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
            ? v[offset + k + 1]
            : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) return backtrack(a, b, trace);
      }
    }
    return null;
  }
  function backtrack(a, b, trace) {
    const ops = [];
    let x = a.length,
      y = b.length;
    for (let d = trace.length - 1; d >= 0; d--) {
      const v = trace[d],
        at = k => v[k + d + 1],
        k = x - y,
        previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1,
        previousX = at(previousK),
        previousY = previousX - previousK;
      while (x > previousX && y > previousY) {
        y--;
        ops.push(['=', a[--x]]);
      }
      if (d > 0) ops.push(x === previousX ? ['+', b[--y]] : ['-', a[--x]]);
    }
    return ops.reverse();
  }

  /**
   * Character diff from `before` to `after` as runs of ['=' | '-' | '+', text]. Each change lists
   * everything removed before everything added, so a rewritten phrase reads as old, then new.
   */
  function diffChars(before, after) {
    const a = Array.from(before),
      b = Array.from(after);
    let start = 0,
      endA = a.length,
      endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const middleA = a.slice(start, endA),
      middleB = b.slice(start, endB),
      middle = editScript(middleA, middleB, MAX_DIFF_EDITS) || [
        ...middleA.map(char => ['-', char]),
        ...middleB.map(char => ['+', char])
      ];
    const runs = [];
    let removed = '',
      added = '';
    const flush = () => {
      if (removed) runs.push(['-', removed]);
      if (added) runs.push(['+', added]);
      removed = added = '';
    };
    const keep = text => {
      flush();
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last?.[0] === '=') last[1] += text;
      else runs.push(['=', text]);
    };
    keep(a.slice(0, start).join(''));
    for (const [op, char] of middle) {
      if (op === '=') keep(char);
      else if (op === '-') removed += char;
      else added += char;
    }
    keep(a.slice(endA).join(''));
    flush();
    return runs;
  }

  /**
   * A single dictation's correction. Once dictation has stopped, a correction replaces the dictated
   * text in the composer, but only while that spot still holds exactly the text put there by
   * dictation or by this panel: whatever the user typed there wins. Nothing is ever sent. The composer
   * is shared by all Agents, so the correction follows it across Agent switches; the context it reads
   * is still the Agent's where dictation started.
   * `onWrite({start, end, text})` reports every composer edit, since it fires no input event.
   */
  class VoiceCorrection {
    constructor({$, getAgent, getBackend, getContext, request, toast, onWrite}) {
      Object.assign(this, {$, getAgent, getBackend, getContext, request, toast, onWrite});
      this.session = null;
      $('voiceCorrectionToggle').onclick = () => this.toggle();
      $('voiceCorrectionClose').onclick = () => this.clear();
      $('voiceCorrectionRetry').onclick = () => void this.correct(true);
    }
    begin(owner) {
      this.clear();
      const backend = this.getBackend(owner.transcribeBackendId);
      if (!backend?.statusInfo?.voiceCorrection?.enabled) return;
      this.session = {
        owner,
        agentId: owner.agentId,
        agentBackendId: this.getAgent()?.backendId,
        backendId: backend.id,
        input: owner.input,
        at: owner.at,
        prefix: owner.input.value.slice(0, owner.at),
        original: '',
        // What this session last put at `at`: the dictated text, or the correction once applied.
        current: '',
        corrected: null,
        recording: true,
        status: 'waiting',
        requestText: null,
        controller: null,
        timer: null,
        // Re-renders the waiting time while a request is pending.
        tick: null
      };
    }
    clear(backendId) {
      const s = this.session;
      if (backendId && s && s.backendId !== backendId && s.agentBackendId !== backendId) return;
      clearTimeout(s?.timer);
      clearTimeout(s?.tick);
      s?.controller?.abort();
      this.session = null;
      this.$('voiceCorrectionPanel').hidden = true;
    }
    configure(backend) {
      if (this.session?.backendId === backend.id) this.clear();
    }
    observe(owner, written) {
      const s = this.session,
        text = textareaLines(written);
      if (!s || s.owner !== owner || s.original === text) return;
      clearTimeout(s.timer);
      s.controller?.abort();
      s.controller = null;
      s.original = s.current = text;
      s.corrected = null;
      s.requestText = null;
      s.status = 'waiting';
      this.render();
      if (text.trim()) s.timer = setTimeout(() => void this.correct(), PAUSE_MS);
    }
    end(owner, text) {
      const s = this.session;
      if (!s || s.owner !== owner) return;
      this.observe(owner, text);
      clearTimeout(s.timer);
      s.recording = false;
      // A correction that finished during recording could not touch the composer yet.
      if (s.status === 'ready') this.replace(s, s.corrected);
      this.render();
      void this.correct();
    }
    async correct(force = false) {
      const s = this.session;
      if (!s || !s.original.trim()) return;
      clearTimeout(s.timer);
      // Stopping checks the latest transcript, but needn't repeat a completed or pending identical request.
      if (!force && s.requestText === s.original && ['analyzing', 'ready'].includes(s.status)) return;
      s.controller?.abort();
      const controller = new AbortController(),
        text = s.original;
      s.controller = controller;
      s.requestText = text;
      s.status = 'analyzing';
      s.startedAt = Date.now();
      s.contextRequested = !!this.getBackend(s.backendId)?.statusInfo?.voiceCorrection?.includeContext;
      s.contextUsed = false;
      s.contextWarning = '';
      this.render();
      try {
        let context;
        if (s.contextRequested && this.getContext) {
          try {
            const result = await this.getContext(s.agentId, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
            });
            context = result.context;
          } catch {
            if (controller.signal.aborted || this.session !== s || s.controller !== controller) return;
            s.contextWarning = ' 上下文读取失败，已使用无上下文纠错。';
          }
        }
        if (controller.signal.aborted || this.session !== s || s.controller !== controller) return;
        const result = await this.request(s.backendId, '/api/v1/voice-correction', {
          method: 'POST',
          body: JSON.stringify({text, ...(context ? {context} : {})}),
          signal: controller.signal
        });
        if (controller.signal.aborted || this.session !== s || s.controller !== controller) return;
        if (typeof result.corrected !== 'string' || !result.corrected.trim())
          throw Error('模型没有返回修正文字');
        s.corrected = textareaLines(result.corrected);
        s.contextUsed = result.contextUsed === true;
        s.status = 'ready';
        if (!s.recording) this.replace(s, s.corrected);
      } catch (error) {
        if (controller.signal.aborted || this.session !== s || s.controller !== controller) return;
        s.status = 'error';
        s.error = error.message;
      }
      this.render();
    }
    matches(s) {
      return (
        s.input.value.slice(0, s.at) === s.prefix &&
        s.input.value.slice(s.at, s.at + s.current.length) === s.current
      );
    }
    /** Puts `text` where this session's text is. False when the user has changed that spot. */
    replace(s, text) {
      if (text === s.current) return true;
      if (!this.matches(s)) return false;
      const input = s.input,
        start = s.at,
        end = s.at + s.current.length,
        delta = text.length - s.current.length;
      // Leave the caret where the user put it rather than jumping to the replaced text.
      const shift = position =>
        position <= start ? position : position >= end ? position + delta : start + text.length;
      const selectionStart = shift(input.selectionStart),
        selectionEnd = shift(input.selectionEnd);
      input.setRangeText(text, start, end);
      input.setSelectionRange(selectionStart, selectionEnd);
      s.current = text;
      this.onWrite({start, end, text});
      return true;
    }
    /** Switches the dictated spot between the correction and the original. Never focuses the composer. */
    toggle() {
      const s = this.session;
      if (!s || s.recording || s.status === 'analyzing' || s.corrected === null) return;
      // Recheck on click: programmatic edits can bypass the input event.
      if (this.matches(s)) this.replace(s, s.current === s.corrected ? s.original : s.corrected);
      // An edited correction cannot be restored, but any other correction can still be appended.
      else if (s.current !== s.corrected) {
        const input = s.input,
          end = input.value.length,
          text = (input.value && !/\s$/.test(input.value) ? ' ' : '') + s.corrected;
        input.value += text;
        input.setSelectionRange(input.value.length, input.value.length);
        this.clear();
        this.onWrite({start: end, end, text});
        this.toast('修正文字已追加到输入框，尚未发送');
        return;
      }
      this.render();
    }
    renderDiff(s) {
      const box = this.$('voiceCorrectionDiff');
      if (s.diffOriginal === s.original && s.diffCorrected === s.corrected) return;
      s.diffOriginal = s.original;
      s.diffCorrected = s.corrected;
      const runs = s.corrected === null ? [['=', s.original]] : diffChars(s.original, s.corrected);
      box.replaceChildren(
        ...runs.map(([op, text]) => {
          if (op === '=') return text;
          const node = document.createElement(op === '-' ? 'del' : 'ins');
          node.textContent = text;
          return node;
        })
      );
    }
    render() {
      const s = this.session,
        $ = this.$;
      $('voiceCorrectionPanel').hidden = !s?.original;
      if (!s) return;
      this.renderDiff(s);
      const busy = s.status === 'analyzing',
        waited = busy ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
        matches = this.matches(s),
        changed = s.corrected !== null && s.corrected !== s.original,
        applied = changed && s.current === s.corrected,
        toggle = $('voiceCorrectionToggle');
      toggle.disabled = s.recording || busy || !changed || (applied && !matches);
      toggle.textContent = applied ? '恢复原文' : matches ? '采用修正' : '追加修正';
      toggle.title = applied
        ? matches
          ? '把本次识别的文字换回原始识别结果，不发送'
          : '输入框中的这段文字已修改，无法恢复原文'
        : matches
          ? '用修正替换本次识别的文字，不发送'
          : '原位置已修改；追加到输入框，不覆盖现有文字';
      $('voiceCorrectionRetry').disabled = busy || !s.original.trim();
      const context = s.contextUsed ? ' 已结合截断的用户/AI消息。' : ' 未使用会话上下文。';
      $('voiceCorrectionStatus').textContent =
        (busy
          ? `正在调用模型纠错…${waited ? `（${waited} 秒）` : ''}`
          : s.status === 'error'
            ? `纠错失败：${s.error}；${applied ? '输入框保留之前的修正' : '原文已保留'}，可重试或手动修改。`
            : s.status !== 'ready'
              ? '等待停顿后自动纠错…'
              : !changed
                ? `模型认为无需修正。${context}`
                : s.recording
                  ? `修正预览。${context}`
                  : applied
                    ? `${matches ? '修正已写入输入框，可恢复原文。' : '修正已写入输入框，之后又被修改。'}${context}`
                    : `修正完成，输入框中仍是原文。${context}`) +
        (s.contextWarning || '') +
        (s.recording
          ? ' 录音中仅预览，停止后自动写入输入框。'
          : changed && !applied && !matches
            ? ' 输入框已修改，采用时将追加而不覆盖。'
            : ' 不会自动发送。');
      clearTimeout(s.tick);
      if (busy) s.tick = setTimeout(() => this.session === s && this.render(), 1000);
    }
  }
  window.RemotePiVoiceCorrection = {VoiceCorrection, diffChars};
})();
