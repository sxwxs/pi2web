import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {AgentManager, MockBackend, slimEvent, type AgentEvent} from '../src/agents.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';

class ControlledBackend extends MockBackend {
  publish!: (event: AgentEvent) => void;
  override subscribe(listener: (event: AgentEvent) => void) {
    this.publish = listener;
    return super.subscribe(listener);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const partial = (text: string) => ({role: 'assistant', content: [{type: 'text', text}]});
const delta = (type: string, text: string, streamed: string) => ({
  type: 'message_update',
  message: partial(streamed),
  assistantMessageEvent: {type, contentIndex: 0, delta: text, partial: partial(streamed)}
});

describe('slimEvent', () => {
  it('keeps streamed text and tool output out of events: they reach viewers as details', () => {
    expect(slimEvent(delta('text_delta', 'lo', 'hello'))).toBeUndefined();
    expect(slimEvent({type: 'tool_execution_update', toolCallId: 't', partialResult: 'x'})).toBeUndefined();
  });

  it('whitelists lifecycle and tool fields', () => {
    expect(slimEvent({type: 'message_start', message: partial('')})).toEqual({
      type: 'message_start',
      role: 'assistant'
    });
    expect(slimEvent({type: 'turn_end', message: partial('x'), toolResults: [{}]})).toEqual({
      type: 'turn_end'
    });
    expect(slimEvent({type: 'agent_end', messages: [partial('x')], willRetry: false})).toEqual({
      type: 'agent_end',
      willRetry: false,
      aborted: undefined
    });
    expect(
      slimEvent({
        type: 'tool_execution_end',
        toolCallId: 't',
        toolName: 'bash',
        args: {},
        result: 1,
        isError: false
      })
    ).toEqual({
      type: 'tool_execution_end',
      toolCallId: 't',
      toolName: 'bash',
      parentToolCallId: undefined,
      result: 1,
      isError: false,
      durationMs: undefined
    });
  });

  it('forwards pi2web events unchanged', () => {
    const event = {type: 'bash_execution_update', id: 'b', delta: 'out'};
    expect(slimEvent(event)).toBe(event);
  });
});

async function focusedClient() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-event-slim-'));
  const workspaceDir = path.join(dir, 'workspace');
  await mkdir(workspaceDir);
  const workspaces = new WorkspaceStore(),
    workspace = workspaces.add('test', workspaceDir);
  let backend!: ControlledBackend;
  const agents = new AgentManager(workspaces, (id, cwd) => (backend = new ControlledBackend(id, cwd)));
  const server = new RemotePiServer({port: 0, dataDir: path.join(dir, 'data'), workspaces, agents});
  const {token} = await server.auth.init(),
    address = await server.start();
  const agent = await agents.create(workspace.id);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws`, [`access-token.${token}`]);
  cleanup.push(async () => {
    socket.terminate();
    await server.stop();
    await rm(dir, {recursive: true, force: true});
  });
  const frames: string[] = [];
  socket.on('message', raw => frames.push(raw.toString()));
  await new Promise(resolve => socket.once('open', resolve));
  socket.send(JSON.stringify({type: 'subscribe_all'}));
  socket.send(JSON.stringify({type: 'focus', agentId: agent.agentId}));
  await new Promise<void>(resolve => {
    const check = () => (frames.some(f => f.includes('"focus_state"')) ? resolve() : setTimeout(check, 5));
    check();
  });
  frames.length = 0;
  const recorded = () =>
    new Promise<void>(resolve => {
      const check = () => (frames.some(f => f.includes('"clearLive"')) ? resolve() : setTimeout(check, 5));
      check();
    });
  return {backend, frames, recorded};
}

describe('agent stream wire size', () => {
  it('grows linearly with the streamed response', async () => {
    const {backend, frames, recorded} = await focusedClient();
    const token = 'abcd',
      count = 5000;
    let streamed = '';
    backend.publish({type: 'message_start', message: partial('')});
    // Content blocks stream one after another: the text, then a tool call's arguments.
    for (let i = 0; i < count; i++) {
      streamed += token;
      backend.publish(delta('text_delta', token, streamed));
    }
    for (let i = 0; i < count; i++) backend.publish(delta('toolcall_delta', token, streamed));
    backend.publish({type: 'message_end', message: partial(streamed)});
    await recorded();

    const messages = frames.map(frame => JSON.parse(frame));
    expect(frames.every(frame => !frame.includes('"partial"'))).toBe(true);
    expect(
      messages
        .filter(m => m.type === 'delta')
        .map(m => m.delta)
        .join('')
    ).toBe(streamed);
    // One activity change per content block (generating, preparing_tool), not one per token.
    expect(messages.filter(m => m.event?.type === 'activity_changed')).toHaveLength(2);
    // Unslimmed, this stream used to be ~200 MB. Now the text travels once, plus framing.
    const bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
    expect(bytes).toBeLessThan(streamed.length + 5_000);
  });

  it('coalesces a paced stream into few small frames', async () => {
    const {backend, frames, recorded} = await focusedClient();
    let streamed = '';
    backend.publish({type: 'message_start', message: partial('')});
    // 100 tokens a few milliseconds apart, like a fast provider.
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      streamed += 'abcd';
      backend.publish(delta('text_delta', 'abcd', streamed));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const elapsed = Date.now() - started;
    backend.publish({type: 'message_end', message: partial(streamed)});
    await recorded();
    // At most one frame per 100 ms window, however many tokens arrive.
    const deltaFrames = frames.filter(frame => frame.includes('"delta"'));
    expect(deltaFrames.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2);
    expect(deltaFrames.length).toBeLessThan(50);
    const overhead = deltaFrames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) - streamed.length;
    expect(overhead / deltaFrames.length).toBeLessThan(120);
  });
});
