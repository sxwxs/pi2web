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

describe('slimEvent', () => {
  it('strips partial messages from streaming deltas', () => {
    expect(
      slimEvent({
        type: 'message_update',
        message: partial('hello'),
        assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: 'lo', partial: partial('hello')}
      })
    ).toEqual({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'lo'}});
  });

  it('drops assistant stream sub-events clients do not render', () => {
    for (const type of [
      'start',
      'text_start',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'done'
    ])
      expect(
        slimEvent({
          type: 'message_update',
          message: partial('x'),
          assistantMessageEvent: {type, partial: partial('x')}
        })
      ).toBeUndefined();
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
        type: 'tool_execution_update',
        toolCallId: 't',
        toolName: 'bash',
        args: {command: 'ls'},
        partialResult: 1
      })
    ).toEqual({
      type: 'tool_execution_update',
      toolCallId: 't',
      toolName: 'bash',
      parentToolCallId: undefined,
      partialResult: 1
    });
  });

  it('forwards pi2web events unchanged', () => {
    const event = {type: 'bash_execution_update', id: 'b', delta: 'out'};
    expect(slimEvent(event)).toBe(event);
  });
});

describe('agent event wire size', () => {
  it('grows linearly with the streamed response', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-event-slim-'));
    const workspaceDir = path.join(dir, 'workspace');
    await mkdir(workspaceDir);
    const workspaces = new WorkspaceStore(),
      workspace = workspaces.add('test', workspaceDir);
    let backend!: ControlledBackend;
    const agents = new AgentManager(workspaces, (id, cwd) => (backend = new ControlledBackend(id, cwd)));
    const server = new RemotePiServer({port: 0, dataDir: path.join(dir, 'data'), workspaces, agents});
    let socket: WebSocket | undefined;
    cleanup.push(async () => {
      socket?.terminate();
      await server.stop();
      await rm(dir, {recursive: true, force: true});
    });
    const {token} = await server.auth.init(),
      address = await server.start();
    const agent = await agents.create(workspace.id);

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws`, [`access-token.${token}`]);
    let bytes = 0,
      activityChanges = 0,
      text = '';
    const ended = new Promise<void>(resolve =>
      socket!.on('message', raw => {
        bytes += (raw as Buffer).length;
        const message = JSON.parse(raw.toString());
        expect(raw.toString()).not.toContain('"partial"');
        if (message.type === 'agent_event' && message.event.type === 'activity_changed') activityChanges++;
        if (message.type === 'agent_event' && message.event.type === 'message_update')
          text += message.event.assistantMessageEvent.delta;
        if (message.type === 'agent_event' && message.event.type === 'message_end') resolve();
      })
    );
    await new Promise(resolve => socket!.once('open', resolve));
    const subscribed = new Promise(resolve =>
      socket!.on('message', raw => JSON.parse(raw.toString()).type === 'agent_state' && resolve(undefined))
    );
    socket.send(JSON.stringify({type: 'subscribe', agentId: agent.agentId, fromNow: true}));
    await subscribed;
    bytes = 0;

    const token4 = 'abcd',
      count = 5000;
    let streamed = '';
    // Content blocks stream one after another: the text, then a tool call's arguments.
    for (let i = 0; i < count; i++) {
      streamed += token4;
      backend.publish({
        type: 'message_update',
        message: partial(streamed),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: token4,
          partial: partial(streamed)
        }
      });
    }
    for (let i = 0; i < count; i++)
      backend.publish({
        type: 'message_update',
        message: partial(streamed),
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 1,
          delta: token4,
          partial: partial(streamed)
        }
      });
    backend.publish({type: 'message_end', message: partial(streamed)});
    await ended;

    expect(text).toBe(streamed);
    // One activity change per content block (generating, preparing_tool), not one per token.
    expect(activityChanges).toBe(2);
    // Unslimmed, this stream is ~200 MB. Slimmed: one copy for message_end plus framing overhead.
    expect(bytes).toBeLessThan(streamed.length * 3 + 10_000);
  });
});
