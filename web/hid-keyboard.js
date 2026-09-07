(() => {
  'use strict';

  // Wire contract: Nozzala v1-codex-full 1.0.0, build 51AE6B3BF94B49FF.
  // Reference: CodexFull WebHID Console v0.1.0 (2026-08-31), DEVELOPMENT.md.
  // Host requests use {id,m,p} without a newline; replies/notifications end in LF.
  // RPCs are serialized, use IDs 0..998, and wait 50ms after each reply.
  const REPORT_ID = 6;
  const CHANNEL_JSON = 2;
  const REPORT_BYTES = 63;
  const PAYLOAD_BYTES = 61;
  const VENDOR_ID = 0x303A;
  const PRODUCT_ID = 0x8360;
  const USAGE_PAGE = 0xFF00;
  const USAGE = 1;
  const STORAGE_KEY = 'rpSessionKeyboardBindings';
  // Adjacent slots deliberately alternate across the color wheel so all six
  // remain easy to distinguish when they are lit at the same time.
  const PALETTE = ['#FF3040', '#00D9FF', '#FFE600', '#3D5AFE', '#30E070', '#D840FF'];
  const BUSY_STATUSES = new Set(['starting', 'streaming', 'stopping']);
  // codex-full firmware effects that remain meaningful on one independently
  // bound key. Spatial effects such as snake/rainbow are intentionally unused.
  const EFFECT_OFF = 0;
  const EFFECT_SOLID = 1;
  const EFFECT_BREATH = 4;
  const EFFECT_SHALLOW_BREATH = 6;
  // Idle stays continuously lit. Active work uses a slow, full-depth breath
  // so each cycle clearly falls toward dark before returning to full brightness.
  // Waiting remains a shallow breath to read as a separate third state.
  const ACTIVITY_LIGHTS = {
    llm: {effect:EFFECT_BREATH, speed:0.12},
    tool: {effect:EFFECT_BREATH, speed:0.45},
    retry: {effect:EFFECT_BREATH, speed:0.8},
    waiting: {effect:EFFECT_SHALLOW_BREATH, speed:0.1},
  };
  const BUSY_LIGHT = {effect:EFFECT_BREATH, speed:0.15};

  // Keep activity in one place; the light phase is derived, never stored twice.
  const newActivity = () => ({turn:'idle', tools:new Set(), bash:new Set(), dialogs:new Set()});
  const resetTurn = (activity, turn = 'idle') => { activity.turn = turn; activity.tools.clear(); };
  const activityPhase = activity => {
    if (!activity) return 'idle';
    if (activity.dialogs.size) return 'waiting';
    if (activity.tools.size || activity.bash.size) return 'tool';
    return activity.turn;
  };

  const normalizeColor = value => {
    const color = String(value || '').trim().toUpperCase();
    return /^#[0-9A-F]{6}$/.test(color) ? color : null;
  };

  class JsonLineAssembler {
    constructor() { this.reset(); }
    reset() { this.decoder = new TextDecoder(); this.buffer = ''; }
    feed(data) {
      this.buffer += this.decoder.decode(data, {stream:true});
      const messages = [];
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) messages.push(JSON.parse(line));
      }
      return messages;
    }
  }

  class SessionKeyboardController {
    constructor({onKey, onStateChange, onBindingsChange, onError} = {}) {
      this.onKey = onKey;
      this.onStateChange = onStateChange;
      this.onBindingsChange = onBindingsChange;
      this.onError = onError;
      this.device = null;
      this.closePromise = Promise.resolve();
      this.requestId = 0;
      this.queue = Promise.resolve();
      this.pending = new Map();
      this.assembler = new JsonLineAssembler();
      this.agents = new Map();
      this.activities = new Map();
      this.sentLights = new Map();
      this.lastPress = new Map();
      this.syncRequested = false;
      this.forceSync = false;
      this.syncPromise = null;
      this.bindings = this.loadBindings();
      this.handleInputReport = this.handleInputReport.bind(this);
      this.handleDisconnect = this.handleDisconnect.bind(this);
      navigator.hid?.addEventListener('disconnect', this.handleDisconnect);
    }

    loadBindings() {
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(parsed)) return new Map();
        return new Map(parsed.flatMap(item => {
          const slot = Number(item?.slot), agentId = String(item?.agentId || ''), color = normalizeColor(item?.color);
          return Number.isInteger(slot) && slot >= 0 && slot < 6 && agentId && color ? [[slot, {agentId, color}]] : [];
        }));
      } catch { return new Map(); }
    }

    saveBindings() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.getBindings()));
      this.onBindingsChange?.(this.getBindings());
      this.syncLights(true).catch(error => this.fail(error));
    }

    get connected() { return Boolean(this.device?.opened); }
    getBindings() { return [...this.bindings].sort(([a], [b]) => a - b).map(([slot, value]) => ({slot, ...value})); }
    getBinding(agentId) { return this.getBindings().find(binding => binding.agentId === agentId) || null; }
    getSlot(slot) { const value = this.bindings.get(Number(slot)); return value ? {slot:Number(slot), ...value} : null; }
    getFreeSlots() { return Array.from({length:6}, (_, slot) => slot).filter(slot => !this.bindings.has(slot)); }

    nextColor() {
      const used = new Set(this.getBindings().map(binding => binding.color));
      return PALETTE.find(color => !used.has(color)) || PALETTE[this.bindings.size % PALETTE.length];
    }

    bind(agentId, slot, color = this.nextColor()) {
      slot = Number(slot); color = normalizeColor(color);
      if (!agentId || !Number.isInteger(slot) || slot < 0 || slot > 5 || !color) throw Error('无效的键盘绑定');
      const occupied = this.bindings.get(slot);
      if (occupied && occupied.agentId !== agentId) throw Error(`按键 ${slot + 1} 已被其他 Session 使用`);
      for (const [boundSlot, binding] of this.bindings) if (binding.agentId === agentId) this.bindings.delete(boundSlot);
      this.bindings.set(slot, {agentId, color});
      this.saveBindings();
      return this.getSlot(slot);
    }

    autoBind(agentId) {
      const existing = this.getBinding(agentId);
      if (existing) return existing;
      const slot = this.getFreeSlots()[0];
      return slot === undefined ? null : this.bind(agentId, slot, this.nextColor());
    }

    unbind(agentId) {
      const entry = [...this.bindings].find(([, binding]) => binding.agentId === agentId);
      if (!entry) return false;
      this.bindings.delete(entry[0]);
      this.saveBindings();
      return true;
    }

    setColor(agentId, color) {
      color = normalizeColor(color);
      const entry = [...this.bindings].find(([, binding]) => binding.agentId === agentId);
      if (!entry || !color) throw Error('无效的 Session 颜色');
      entry[1].color = color;
      this.saveBindings();
      return {slot:entry[0], ...entry[1]};
    }

    setAgents(agents) {
      this.agents = new Map((agents || []).map(agent => [agent.agentId, agent]));
      for (const agentId of this.activities.keys()) this.reconcileActivity(agentId);
      this.syncLights().catch(error => this.fail(error));
    }

    updateAgent(agent) {
      if (!agent?.agentId) return;
      this.agents.set(agent.agentId, agent);
      if (agent.activity) {
        const activity = this.activities.get(agent.agentId) || newActivity();
        activity.bash = new Set(agent.activity.bashIds || []);
        activity.dialogs = new Set(agent.activity.dialogIds || []);
        this.activities.set(agent.agentId, activity);
      }
      this.reconcileActivity(agent.agentId);
      this.syncLights().catch(error => this.fail(error));
    }

    setAgentSnapshot(agent) {
      // A gap invalidates old details; restore independent work from the server.
      // Older servers omit activity and fall back to ordinary Agent status.
      this.activities.delete(agent.agentId);
      this.updateAgent(agent);
    }

    reconcileActivity(agentId) {
      const activity = this.activities.get(agentId), status = this.agents.get(agentId)?.status;
      if (!activity) return;
      if (!status || ['unloaded', 'stopped', 'error'].includes(status)) {
        this.activities.delete(agentId);
        return;
      }
      // Status describes the LLM run, not independent !bash commands or dialogs.
      if (!BUSY_STATUSES.has(status)) resetTurn(activity);
      if (activityPhase(activity) === 'idle') this.activities.delete(agentId);
    }

    handleAgentEvent(agentId, event) {
      const activity = this.activities.get(agentId) || newActivity();
      const previous = activityPhase(activity);
      switch (event.type) {
        case 'agent_start':
          resetTurn(activity, 'llm');
          break;
        case 'message_start':
          if ((event.message?.role || event.role) !== 'assistant') return;
          activity.turn = 'llm';
          break;
        case 'message_update':
          activity.turn = 'llm';
          break;
        case 'tool_execution_start':
        case 'tool_execution_update':
          activity.turn = 'llm';
          activity.tools.add(event.toolCallId || event.toolName || 'default');
          break;
        case 'tool_execution_end':
          activity.tools.delete(event.toolCallId || event.toolName || 'default');
          break;
        case 'bash_execution_start':
        case 'bash_execution_update':
          activity.bash.add(event.id || 'default');
          break;
        case 'bash_execution_end':
          activity.bash.delete(event.id || 'default');
          break;
        case 'auto_retry_start':
          resetTurn(activity, 'retry');
          break;
        case 'auto_retry_end':
          activity.turn = event.success === false ? 'idle' : 'llm';
          break;
        case 'extension_ui_request':
          activity.dialogs.add(event.requestId);
          break;
        case 'extension_ui_response':
          activity.dialogs.delete(event.requestId);
          break;
        case 'agent_end':
          resetTurn(activity, event.willRetry ? 'retry' : 'idle');
          break;
        case 'agent_settled':
          resetTurn(activity);
          break;
        default:
          return;
      }
      const phase = activityPhase(activity);
      if (phase === 'idle') this.activities.delete(agentId); else this.activities.set(agentId, activity);
      if (phase !== previous) this.syncLights().catch(error => this.fail(error));
    }

    isBusy(agentId) { return BUSY_STATUSES.has(this.agents.get(agentId)?.status); }

    collection(device) {
      return device.collections.find(item => item.usagePage === USAGE_PAGE && item.usage === USAGE &&
        item.outputReports.some(report => report.reportId === REPORT_ID) && item.inputReports.some(report => report.reportId === REPORT_ID));
    }

    async connect({request = true} = {}) {
      if (!window.isSecureContext || !navigator.hid) throw Error('WebHID 需要 Chrome/Edge，并通过 HTTPS 或 localhost 打开');
      let devices = (await navigator.hid.getDevices()).filter(device => device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID && this.collection(device));
      if (!devices.length && request) devices = await navigator.hid.requestDevice({filters:[{vendorId:VENDOR_ID, productId:PRODUCT_ID, usagePage:USAGE_PAGE, usage:USAGE}]});
      if (!devices.length) return false;
      const device = devices[0];
      // Finish the previous close and sync before reusing the same HIDDevice.
      await this.closePromise;
      await this.syncPromise?.catch(() => undefined);
      try {
        if (!device.opened) await device.open();
        if (!this.collection(device)) throw Error('键盘缺少兼容的 Vendor HID 接口');
        if (this.device && this.device !== device) await this.disconnect();
        if (this.device === device) device.removeEventListener('inputreport', this.handleInputReport);
        this.device = device;
        device.addEventListener('inputreport', this.handleInputReport);
        this.assembler.reset(); this.sentLights.clear();
        await this.syncLights(true);
        if (this.device !== device || !device.opened) throw Error('键盘已断开');
      } catch (error) {
        // disconnect() clears local state even if close() fails. Keep the
        // initialization error as the reason reported to the caller.
        if (this.device === device) await this.disconnect().catch(() => undefined);
        else if (device.opened) await device.close().catch(() => undefined);
        throw error;
      }
      this.onStateChange?.({connected:true, name:device.productName || 'Codex Micro'});
      return true;
    }

    async restoreAuthorized() {
      if (!window.isSecureContext || !navigator.hid) return false;
      try { return await this.connect({request:false}); }
      catch (error) { this.fail(error); return false; }
    }

    async disconnect() {
      if (!this.device) return this.closePromise;
      const device = this.device; this.device = null;
      device.removeEventListener('inputreport', this.handleInputReport);
      // Detach and notify before awaiting the OS: close() can fail or stall.
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('键盘已断开')); }
      this.pending.clear(); this.assembler.reset(); this.sentLights.clear();
      this.syncRequested = false; this.forceSync = false;
      const closing = device.opened ? device.close() : Promise.resolve();
      this.closePromise = closing.catch(() => undefined);
      this.onStateChange?.({connected:false, name:''});
      return closing;
    }

    handleDisconnect(event) { if (event.device === this.device) this.disconnect().catch(error => this.fail(error)); }

    handleInputReport(event) {
      if (event.device !== this.device || Number(event.reportId) !== REPORT_ID) return;
      try {
        const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        if (bytes.length < 2 || bytes[0] !== CHANNEL_JSON || bytes[1] > PAYLOAD_BYTES || bytes[1] > bytes.length - 2) throw Error('收到无效的键盘 HID 数据');
        for (const message of this.assembler.feed(bytes.slice(2, 2 + bytes[1]))) this.handleMessage(message);
      } catch (error) { this.fail(error); }
    }

    handleMessage(message) {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        const waiter = this.pending.get(String(message.id));
        if (waiter) { this.pending.delete(String(message.id)); clearTimeout(waiter.timer); waiter.resolve(message); }
        return;
      }
      if (message.m !== 'v.oai.hid' || !/^AG0[0-5]$/.test(message.p?.k) || Number(message.p?.act) !== 1) return;
      const slot = Number(message.p.k.slice(-1)), now = Date.now();
      if (now - (this.lastPress.get(slot) || 0) < 250) return;
      this.lastPress.set(slot, now);
      const binding = this.getSlot(slot);
      if (binding) this.onKey?.(binding, message);
    }

    nextId() { this.requestId = this.requestId >= 998 ? 0 : this.requestId + 1; return this.requestId; }

    reports(message) {
      const bytes = new TextEncoder().encode(message), reports = [];
      for (let offset = 0; offset < bytes.length; offset += PAYLOAD_BYTES) {
        const fragment = bytes.slice(offset, offset + PAYLOAD_BYTES), report = new Uint8Array(REPORT_BYTES);
        report[0] = CHANNEL_JSON; report[1] = fragment.length; report.set(fragment, 2); reports.push(report);
      }
      return reports;
    }

    transmit(request) {
      const device = this.device;
      const job = this.queue.then(async () => {
        if (this.device !== device || !device?.opened) throw Error('键盘未连接');
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(String(request.id)); reject(Error('键盘响应超时')); }, 5000);
          this.pending.set(String(request.id), {resolve, reject, timer});
        });
        // A timeout/disconnect can reject the reply while sendReport is still
        // pending. Observe it now; the await below still propagates the error.
        response.catch(() => undefined);
        try {
          for (const report of this.reports(JSON.stringify(request))) {
            if (this.device !== device || !device.opened) throw Error('键盘已断开');
            await device.sendReport(REPORT_ID, report);
          }
          const result = await response;
          if (result?.error) throw Error(result.error.message || '键盘拒绝了灯光设置');
          await new Promise(resolve => setTimeout(resolve, 50));
          return result;
        } catch (error) {
          const waiter = this.pending.get(String(request.id));
          if (waiter) clearTimeout(waiter.timer);
          this.pending.delete(String(request.id));
          throw error;
        }
      });
      this.queue = job.catch(() => undefined);
      return job;
    }

    lightRequest(slot, color, effect, speed = 0) {
      const enabled = effect !== EFFECT_OFF;
      return {id:this.nextId(), m:'v.oai.thstatus', p:[{id:slot, c:parseInt(color.slice(1), 16), b:enabled ? 1 : 0, e:effect, s:speed, sk:0, sa:0}]};
    }

    lightState(slot) {
      const binding = this.bindings.get(slot), active = Boolean(binding && this.agents.has(binding.agentId));
      if (!active) return {color:binding?.color || '#000000', effect:EFFECT_OFF, speed:0};
      const phase = activityPhase(this.activities.get(binding.agentId));
      let animation = ACTIVITY_LIGHTS[phase];
      if (!animation && this.agents.get(binding.agentId)?.status === 'waiting_for_user') animation = ACTIVITY_LIGHTS.waiting;
      if (!animation && this.isBusy(binding.agentId)) animation = BUSY_LIGHT;
      return {color:binding.color, effect:animation?.effect || EFFECT_SOLID, speed:animation?.speed || 0};
    }

    async syncLights(force = false) {
      if (!this.connected) return;
      this.syncRequested = true;
      this.forceSync ||= force;
      if (this.syncPromise) return this.syncPromise;
      const device = this.device;
      // Defer the first pass so synchronous updates use the latest state. Clear
      // the worker inside its own finally, even when every light is a cache hit.
      this.syncPromise = Promise.resolve().then(async () => {
        try {
          if (this.device !== device || !device.opened) throw Error('键盘已断开');
          do {
            this.syncRequested = false;
            const forcePass = this.forceSync; this.forceSync = false;
            for (let slot = 0; slot < 6; slot++) {
              const {color, effect, speed} = this.lightState(slot), signature = `${color}:${effect}:${speed}`;
              if (!forcePass && this.sentLights.get(slot) === signature) continue;
              await this.transmit(this.lightRequest(slot, color, effect, speed));
              if (this.device !== device || !device.opened) throw Error('键盘已断开');
              this.sentLights.set(slot, signature);
            }
          } while (this.syncRequested && this.connected);
        } finally { this.syncPromise = null; }
      });
      return this.syncPromise;
    }

    fail(error) { this.onError?.(error instanceof Error ? error : Error(String(error))); }
  }

  window.SessionKeyboardController = SessionKeyboardController;
})();
