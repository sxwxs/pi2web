(() => {
  'use strict';
  const PAUSE_MS = 2000;

  /** A single dictation's correction preview. Model replies never write to the composer by themselves. */
  class VoiceCorrection {
    constructor({$, getAgent, getBackend, request, toast, onAccept}) {
      Object.assign(this, {$, getAgent, getBackend, request, toast, onAccept});
      this.session = null;
      $('voiceCorrectionAccept').onclick = () => this.accept();
      $('voiceCorrectionKeep').onclick = () => this.clear();
      $('voiceCorrectionRetry').onclick = () => void this.correct(true);
      $('voiceCorrectionText').oninput = () => this.render();
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
        recording: true,
        status: 'waiting',
        requestText: null,
        controller: null,
        timer: null
      };
    }
    clear(backendId) {
      const s = this.session;
      if (backendId && s && s.backendId !== backendId && s.agentBackendId !== backendId) return;
      clearTimeout(s?.timer);
      s?.controller?.abort();
      this.session = null;
      this.$('voiceCorrectionPanel').hidden = true;
    }
    configure(backend) {
      if (this.session?.backendId === backend.id) this.clear();
    }
    observe(owner, text) {
      const s = this.session;
      if (!s || s.owner !== owner || s.original === text) return;
      clearTimeout(s.timer);
      s.controller?.abort();
      s.controller = null;
      s.original = text;
      s.requestText = null;
      s.status = 'waiting';
      this.$('voiceCorrectionOriginal').value = text;
      this.$('voiceCorrectionText').value = text;
      this.render();
      if (text.trim()) s.timer = setTimeout(() => void this.correct(), PAUSE_MS);
    }
    end(owner, text) {
      const s = this.session;
      if (!s || s.owner !== owner) return;
      this.observe(owner, text);
      clearTimeout(s.timer);
      s.recording = false;
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
      this.render();
      try {
        const result = await this.request(s.backendId, '/api/v1/voice-correction', {
          method: 'POST',
          body: JSON.stringify({text}),
          signal: controller.signal
        });
        if (controller.signal.aborted || this.session !== s || s.controller !== controller) return;
        if (typeof result.corrected !== 'string' || !result.corrected.trim())
          throw Error('模型没有返回修正文字');
        this.$('voiceCorrectionText').value = result.corrected;
        s.status = 'ready';
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
        s.input.value.slice(s.at, s.at + s.original.length) === s.original
      );
    }
    render() {
      const s = this.session,
        $ = this.$;
      $('voiceCorrectionPanel').hidden = !s?.original || this.getAgent()?.agentId !== s?.agentId;
      if (!s) return;
      const busy = s.status === 'analyzing',
        matches = this.matches(s);
      $('voiceCorrectionText').readOnly = s.recording || busy;
      $('voiceCorrectionAccept').disabled = s.recording || busy || !$('voiceCorrectionText').value.trim();
      $('voiceCorrectionAccept').textContent = matches ? '采用修正' : '追加修正';
      $('voiceCorrectionAccept').title = matches
        ? '仅替换本次识别的文字，不发送'
        : '原位置已修改；追加到输入框，不覆盖现有文字';
      $('voiceCorrectionRetry').disabled = busy || !s.original.trim();
      $('voiceCorrectionStatus').textContent =
        (busy
          ? '正在调用模型纠错…'
          : s.status === 'ready'
            ? '修正完成，可编辑后采用。'
            : s.status === 'error'
              ? `纠错失败：${s.error}；原文已保留，可重试或手动修改。`
              : '等待停顿后自动纠错…') +
        (s.recording
          ? ' 录音中仅预览，停止后可编辑、采用。'
          : !matches
            ? ' 输入框已修改，采用时将追加而不覆盖。'
            : ' 不会自动发送。');
    }
    accept() {
      const s = this.session,
        text = this.$('voiceCorrectionText').value;
      if (
        !s ||
        s.recording ||
        s.status === 'analyzing' ||
        !text.trim() ||
        this.getAgent()?.agentId !== s.agentId
      )
        return;
      // Recheck on click: programmatic edits can bypass the input event.
      if (this.matches(s)) s.input.setRangeText(text, s.at, s.at + s.original.length, 'end');
      else {
        s.input.value += (s.input.value && !/\s$/.test(s.input.value) ? ' ' : '') + text;
        s.input.setSelectionRange(s.input.value.length, s.input.value.length);
      }
      s.input.focus();
      this.clear();
      this.onAccept();
      this.toast('修正文字已写入输入框，尚未发送');
    }
  }
  window.RemotePiVoiceCorrection = {VoiceCorrection};
})();
