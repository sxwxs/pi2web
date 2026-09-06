import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/hid-keyboard.js', import.meta.url), 'utf8');
const agent = {agentId:'agent-a', status:'idle'};

/** Nozzala codex-full framing: bare JSON requests, LF-terminated replies. */
class MockHidDevice {
  vendorId = 0x303A;
  productId = 0x8360;
  productName = 'Codex Micro';
  opened = false;
  autoReply = true;
  collections = [{usagePage:0xFF00, usage:1, inputReports:[{reportId:6}], outputReports:[{reportId:6}]}];
  requests:any[] = [];
  listener?: (event:any) => void;
  private decoder = new TextDecoder();
  private buffer = '';

  open = vi.fn(async () => { this.opened = true; });
  close = vi.fn(async () => { this.opened = false; });
  addEventListener = vi.fn((type:string, listener:(event:any) => void) => {
    if (type === 'inputreport') this.listener = listener;
  });
  removeEventListener = vi.fn((type:string, listener:(event:any) => void) => {
    if (type === 'inputreport' && this.listener === listener) this.listener = undefined;
  });
  sendReport = vi.fn(async (reportId:number, report:Uint8Array) => {
    expect(reportId).toBe(6);
    expect(report.length).toBe(63);
    expect(report[0]).toBe(2);
    this.buffer += this.decoder.decode(report.slice(2, 2 + report[1]), {stream:true});
    let request;
    try { request = JSON.parse(this.buffer); } catch { return; }
    this.buffer = '';
    this.requests.push(request);
    if (this.autoReply) this.reply(request.id);
  });

  input(text:string, chunkSize = 61) {
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize), report = new Uint8Array(63);
      report[0] = 2; report[1] = chunk.length; report.set(chunk, 2);
      this.listener?.({device:this, reportId:6, data:new DataView(report.buffer)});
    }
  }
  reply(id:number) { this.input(JSON.stringify({id, result:{ok:1}}) + '\n'); }
}

function setup(authorized = true) {
  const device = new MockHidDevice();
  const hid = {
    addEventListener:vi.fn(),
    getDevices:vi.fn(async () => authorized ? [device] : []),
    requestDevice:vi.fn(async () => [device]),
  };
  const window = {isSecureContext:true} as any;
  const navigator:{hid:typeof hid|undefined} = {hid};
  runInNewContext(source, {
    window, navigator, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    localStorage:{getItem:() => null, setItem:() => {}},
  }, {filename:'web/hid-keyboard.js'});
  const onStateChange = vi.fn(), onError = vi.fn();
  const keyboard = new window.SessionKeyboardController({onStateChange, onError});
  keyboard.bind(agent.agentId, 0, '#FF3040');
  keyboard.setAgents([agent]);
  return {keyboard, device, hid, window, navigator, onStateChange, onError};
}

async function connectKeyboard(keyboard:any) {
  const connected = expect(keyboard.connect()).resolves.toBe(true);
  await vi.runAllTimersAsync();
  await connected;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('WebHID connection lifecycle', () => {
  it('opens an authorized device and announces success only after all six replies', async () => {
    const {keyboard, device, hid, onStateChange} = setup();
    device.autoReply = false;
    const connected = expect(keyboard.connect()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(device.open).toHaveBeenCalledOnce();
    expect(hid.requestDevice).not.toHaveBeenCalled();
    expect(device.addEventListener).toHaveBeenCalledWith('inputreport', keyboard.handleInputReport);
    expect(hid.addEventListener).toHaveBeenCalledWith('disconnect', keyboard.handleDisconnect);
    for (let slot = 0; slot < 6; slot++) {
      expect(onStateChange).not.toHaveBeenCalled();
      expect(device.requests).toHaveLength(slot + 1);
      expect(device.requests[slot].p[0].id).toBe(slot);
      device.reply(device.requests[slot].id);
      await vi.advanceTimersByTimeAsync(50);
    }
    await connected;
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:true, name:'Codex Micro'});
    expect(keyboard.pending.size).toBe(0);
    expect(keyboard.sentLights.size).toBe(6);
  });

  it('requests a device with all four filters when none is authorized', async () => {
    const {keyboard, hid} = setup(false);
    await connectKeyboard(keyboard);
    expect(hid.requestDevice).toHaveBeenCalledWith({filters:[{vendorId:0x303A, productId:0x8360, usagePage:0xFF00, usage:1}]});
  });

  it('does not open a picker during silent restore or publish success after cancellation', async () => {
    const {keyboard, device, hid, onStateChange} = setup(false);
    expect(await keyboard.restoreAuthorized()).toBe(false);
    expect(hid.requestDevice).not.toHaveBeenCalled();
    hid.requestDevice.mockResolvedValue([]);
    expect(await keyboard.connect()).toBe(false);
    expect(device.open).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it.each(['missing WebHID', 'insecure context'])('silently skips automatic restore in an unsupported environment: %s', async reason => {
    const {keyboard, hid, window, navigator, onError, onStateChange} = setup();
    if (reason === 'missing WebHID') navigator.hid = undefined;
    else window.isSecureContext = false;
    expect(await keyboard.restoreAuthorized()).toBe(false);
    expect(hid.getDevices).not.toHaveBeenCalled();
    expect(hid.requestDevice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    // Explicit connection attempts must still explain why they cannot work.
    await expect(keyboard.connect()).rejects.toThrow('WebHID');
  });

  it('still reports genuine device failures during authorized restore', async () => {
    const {keyboard, device, onError} = setup();
    device.open.mockRejectedValueOnce(Error('device unavailable'));
    expect(await keyboard.restoreAuthorized()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('device unavailable');
  });

  it('closes an incompatible device returned by the picker', async () => {
    const {keyboard, device, onStateChange} = setup(false);
    device.collections[0].outputReports = [];
    await expect(keyboard.connect()).rejects.toThrow('Vendor HID');
    expect(device.close).toHaveBeenCalledOnce();
    expect(keyboard.device).toBeNull();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('rolls back a failed initial send and permits a clean retry', async () => {
    const {keyboard, device, onStateChange} = setup();
    device.sendReport.mockRejectedValueOnce(Error('send failed'));
    const failed = expect(keyboard.connect()).rejects.toThrow('send failed');
    await vi.runAllTimersAsync();
    await failed;
    expect(keyboard.connected).toBe(false);
    expect(device.close).toHaveBeenCalledOnce();
    expect(device.listener).toBeUndefined();
    expect(keyboard.pending.size).toBe(0);
    expect(keyboard.sentLights.size).toBe(0);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
    await connectKeyboard(keyboard);
    expect(device.open).toHaveBeenCalledTimes(2);
    expect(device.requests).toHaveLength(6);
    expect(onStateChange).toHaveBeenLastCalledWith({connected:true, name:'Codex Micro'});
  });

  it('rolls back when the initial reply times out', async () => {
    const {keyboard, device, onStateChange} = setup();
    device.autoReply = false;
    const failed = expect(keyboard.connect()).rejects.toThrow('键盘响应超时');
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(keyboard.device).toBeNull();
    expect(device.opened).toBe(false);
    expect(device.listener).toBeUndefined();
    expect(keyboard.pending.size).toBe(0);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original initialization error if cleanup also fails', async () => {
    const {keyboard, device, onStateChange} = setup();
    device.sendReport.mockRejectedValueOnce(Error('send failed'));
    device.close.mockRejectedValueOnce(Error('close failed'));
    const failed = expect(keyboard.connect()).rejects.toThrow('send failed');
    await vi.runAllTimersAsync();
    await failed;
    expect(keyboard.device).toBeNull();
    expect(device.listener).toBeUndefined();
    expect(keyboard.pending.size).toBe(0);
    expect(onStateChange).toHaveBeenLastCalledWith({connected:false, name:''});
  });

  it('cleans pending RPCs, caches and UI even if close rejects', async () => {
    const {keyboard, device, onStateChange} = setup();
    await connectKeyboard(keyboard);
    device.autoReply = false;
    const request = keyboard.lightRequest(0, '#FFFFFF', 1);
    const stopped = expect(keyboard.transmit(request)).rejects.toThrow('键盘已断开');
    await vi.advanceTimersByTimeAsync(0);
    keyboard.assembler.buffer = '{"partial":';
    device.close.mockRejectedValueOnce(Error('close failed'));
    await expect(keyboard.disconnect()).rejects.toThrow('close failed');
    expect(keyboard.connected).toBe(false);
    expect(keyboard.pending.size).toBe(0);
    expect(keyboard.assembler.buffer).toBe('');
    expect(keyboard.sentLights.size).toBe(0);
    expect(device.listener).toBeUndefined();
    expect(onStateChange).toHaveBeenLastCalledWith({connected:false, name:''});
    await stopped;
    device.reply(request.id); // A late reply must not reach the detached controller.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rolls back when firmware returns an RPC error', async () => {
    const {keyboard, device, onStateChange} = setup();
    device.autoReply = false;
    const failed = expect(keyboard.connect()).rejects.toThrow('firmware refused');
    await vi.advanceTimersByTimeAsync(0);
    device.input(JSON.stringify({id:device.requests[0].id, error:{message:'firmware refused'}}) + '\n');
    await vi.runAllTimersAsync();
    await failed;
    expect(device.opened).toBe(false);
    expect(keyboard.pending.size).toBe(0);
    expect(keyboard.sentLights.size).toBe(0);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
  });

  it('closes the candidate if switching away from the previous device fails', async () => {
    const {keyboard, device, hid, onStateChange} = setup();
    await connectKeyboard(keyboard);
    onStateChange.mockClear();
    const candidate = new MockHidDevice();
    hid.getDevices.mockResolvedValueOnce([candidate]);
    device.close.mockRejectedValueOnce(Error('previous close failed'));
    const failed = expect(keyboard.connect()).rejects.toThrow('previous close failed');
    await vi.runAllTimersAsync();
    await failed;
    expect(keyboard.device).toBeNull();
    expect(device.listener).toBeUndefined();
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.opened).toBe(false);
    expect(candidate.listener).toBeUndefined();
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
  });

  it('does not repopulate caches or announce success after disconnecting in the final cooldown', async () => {
    const {keyboard, device, onStateChange} = setup();
    device.autoReply = false;
    const stopped = expect(keyboard.connect()).rejects.toThrow('键盘已断开');
    await vi.advanceTimersByTimeAsync(0);
    for (let slot = 0; slot < 5; slot++) {
      device.reply(device.requests[slot].id);
      await vi.advanceTimersByTimeAsync(50);
    }
    device.reply(device.requests[5].id);
    await vi.advanceTimersByTimeAsync(0);
    expect(keyboard.pending.size).toBe(0);
    await keyboard.disconnect();
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    expect(keyboard.sentLights.size).toBe(0);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
  });

  it('does not announce success or send more fragments after disconnecting during a send', async () => {
    const {keyboard, device, onStateChange} = setup();
    let finishSend!:() => void;
    device.sendReport.mockImplementationOnce(() => new Promise<void>(resolve => { finishSend = resolve; }));
    const stopped = expect(keyboard.connect()).rejects.toThrow('键盘已断开');
    await vi.advanceTimersByTimeAsync(0);
    await keyboard.disconnect();
    // Allow a microtask turn while the response has been rejected but sendReport
    // has not settled yet: this must not produce an unhandled rejection.
    await vi.advanceTimersByTimeAsync(0);
    finishSend();
    await vi.runAllTimersAsync();
    await stopped;
    expect(device.sendReport).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({connected:false, name:''});
    expect(keyboard.sentLights.size).toBe(0);
  });
});

describe('light synchronization scheduling', () => {
  it('does not drop a snapshot correction after an unchanged cached pass', async () => {
    const {keyboard, device} = setup();
    keyboard.handleAgentEvent(agent.agentId, {type:'extension_ui_request', requestId:'old-dialog'});
    await connectKeyboard(keyboard);
    device.requests.length = 0;
    // This sequence previously ended the no-op worker, then joined its resolved
    // promise and lost the snapshot's request to send the idle light.
    keyboard.updateAgent(agent);
    keyboard.setAgentSnapshot(agent);
    await vi.runAllTimersAsync();
    expect(device.requests.map(request => request.p[0])).toEqual([
      {id:0, c:0xFF3040, b:1, e:1, s:0, sk:0, sa:0},
    ]);
    expect(keyboard.sentLights.get(0)).toBe('#FF3040:1:0');
    expect(keyboard.syncPromise).toBeNull();
    expect(keyboard.syncRequested).toBe(false);
  });

  it('coalesces synchronous changes before building a report', async () => {
    const {keyboard, device} = setup();
    await connectKeyboard(keyboard);
    device.requests.length = 0;
    keyboard.handleAgentEvent(agent.agentId, {type:'tool_execution_start', toolCallId:'tool'});
    keyboard.handleAgentEvent(agent.agentId, {type:'agent_settled'});
    await vi.runAllTimersAsync();
    expect(device.requests).toEqual([]);
    expect(keyboard.syncPromise).toBeNull();
  });

  it('sends a correction when state changes while a reply is pending', async () => {
    const {keyboard, device} = setup();
    await connectKeyboard(keyboard);
    device.requests.length = 0;
    device.autoReply = false;
    keyboard.handleAgentEvent(agent.agentId, {type:'tool_execution_start', toolCallId:'tool'});
    await vi.advanceTimersByTimeAsync(0);
    expect(device.requests[0].p[0].e).toBe(4);
    keyboard.setAgentSnapshot(agent);
    device.autoReply = true;
    device.reply(device.requests[0].id);
    await vi.runAllTimersAsync();
    expect(device.requests.map(request => request.p[0].e)).toEqual([4, 1]);
    expect(keyboard.sentLights.get(0)).toBe('#FF3040:1:0');
  });

  it('releases a failed worker so the next sync can retry', async () => {
    const {keyboard, device, onError} = setup();
    await connectKeyboard(keyboard);
    device.requests.length = 0;
    device.sendReport.mockRejectedValueOnce(Error('temporary send failure'));
    keyboard.handleAgentEvent(agent.agentId, {type:'tool_execution_start', toolCallId:'tool'});
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledOnce();
    expect(keyboard.syncPromise).toBeNull();
    const retry = keyboard.syncLights();
    await vi.runAllTimersAsync();
    await retry;
    expect(device.requests.map(request => request.p[0].e)).toEqual([4]);
  });
});

describe('Nozzala codex-full wire contract', () => {
  it('sends compact thstatus requests with an ID and no trailing newline', async () => {
    const {keyboard, device} = setup();
    await connectKeyboard(keyboard);
    device.sendReport.mockClear();
    keyboard.requestId = 41;
    const request = keyboard.lightRequest(3, '#FF00FF', 4, 0.45);
    expect(request).toEqual({id:42, m:'v.oai.thstatus', p:[{id:3, c:0xFF00FF, b:1, e:4, s:0.45, sk:0, sa:0}]});
    const sent = keyboard.transmit(request);
    await vi.runAllTimersAsync();
    expect(await sent).toEqual({id:42, result:{ok:1}});
    const reports = device.sendReport.mock.calls.map(([, report]) => report);
    expect(reports).toHaveLength(2);
    expect(reports[0][1]).toBe(61);
    const bytes = Buffer.concat(reports.map(report => Buffer.from(report.slice(2, 2 + report[1]))));
    expect(bytes.toString()).toBe(JSON.stringify(request));
    expect(bytes.at(-1)).toBe('}'.charCodeAt(0));
    expect(reports.every(report => report.slice(2 + report[1]).every(byte => byte === 0))).toBe(true);
    keyboard.requestId = 998;
    expect(keyboard.nextId()).toBe(0);
  });

  it.each([60, 61, 62, 122, 123])('fragments %i bytes without adding a delimiter', length => {
    const {keyboard} = setup();
    const message = 'x'.repeat(length), reports:Uint8Array[] = keyboard.reports(message);
    expect(reports).toHaveLength(Math.ceil(length / 61));
    expect(Buffer.concat(Array.from(reports, report => Buffer.from(report.slice(2, 2 + report[1])))).toString()).toBe(message);
  });

  it('waits for a matching LF-terminated reply and the 50ms cooldown before the next RPC', async () => {
    const {keyboard, device} = setup();
    await connectKeyboard(keyboard);
    device.autoReply = false;
    device.requests.length = 0;
    const first = keyboard.lightRequest(0, '#FF0000', 1), second = keyboard.lightRequest(1, '#00FF00', 1);
    const firstReply = keyboard.transmit(first), secondReply = keyboard.transmit(second);
    await vi.advanceTimersByTimeAsync(0);
    device.reply(900); // An unrelated reply must not unblock the queue.
    const response = {id:first.id, result:{message:'中文回复🙂'}};
    device.input(JSON.stringify(response), 1); // Split inside UTF-8 sequences, but omit LF.
    await vi.advanceTimersByTimeAsync(100);
    expect(device.requests).toHaveLength(1);
    expect(keyboard.pending.size).toBe(1);
    device.input('\n');
    await vi.advanceTimersByTimeAsync(49);
    expect(device.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(device.requests).toHaveLength(2);
    device.reply(second.id);
    await vi.runAllTimersAsync();
    expect(await firstReply).toEqual(response);
    expect(await secondReply).toEqual({id:second.id, result:{ok:1}});
  });
});
