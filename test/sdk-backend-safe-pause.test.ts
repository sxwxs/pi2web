import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Type} from 'typebox';
import {fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import {SdkBackend} from '../src/sdk-backend.js';
import type {AgentEvent} from '../src/agents.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real Pi session driven by a scripted model and one tool whose completion the test controls. */
async function createSession() {
  const dir = mkdtempSync(join(tmpdir(), 'pi2web-pause-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false
  });
  modelRuntime.registerNativeProvider(faux.provider);
  let release!: () => void;
  let started!: () => void;
  const toolStarted = new Promise<void>(resolve => (started = resolve));
  const gate = new Promise<void>(resolve => (release = resolve));
  const work: ToolDefinition = {
    name: 'work',
    label: 'Work',
    description: 'Do one step of work',
    parameters: Type.Object({step: Type.Number()}),
    async execute(_id: string, params: {step: number}) {
      started();
      await gate;
      return {content: [{type: 'text', text: `step ${params.step} done`}], details: {}};
    }
  } as unknown as ToolDefinition;
  const {session} = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({retry: {enabled: false}} as any),
    tools: ['work'],
    customTools: [work]
  });
  const backend = await SdkBackend.fromSession(session, 'agent-a', dir);
  cleanups.push(() => backend.dispose());
  const events: AgentEvent[] = [];
  backend.subscribe(event => events.push(event));
  return {backend, session, faux, events, toolStarted, release};
}

const lastMessage = (session: any) => session.agent.state.messages.at(-1);

describe('SDK backend safe pause', () => {
  it('stops after the running tools and before the next model request', async () => {
    const {backend, session, faux, events, toolStarted, release} = await createSession();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('work', {step: 1}), {stopReason: 'toolUse'}),
      fauxAssistantMessage(fauxToolCall('work', {step: 2}), {stopReason: 'toolUse'}),
      fauxAssistantMessage(fauxText('all done'))
    ]);
    const run = backend.prompt('start');
    await toolStarted;
    await backend.requestPause();
    release();
    await run;

    expect(faux.state.callCount).toBe(1);
    expect(session.isStreaming).toBe(false);
    expect(lastMessage(session)).toMatchObject({role: 'toolResult', toolName: 'work'});
    // The tool result is in the session file, so the stopped transcript survives a restart.
    const persisted = session.sessionManager.getBranch().filter((entry: any) => entry.type === 'message');
    expect(persisted.at(-1)).toMatchObject({message: {role: 'toolResult'}});
    expect(events.filter(e => e.type === 'safe_pause').map(e => e.state)).toEqual(['requested', 'paused']);
    expect(events.find(e => e.type === 'agent_settled')).toMatchObject({paused: true});

    // A new prompt carries on from the paused transcript.
    await backend.prompt('go on');
    expect(faux.state.callCount).toBe(3);
    expect(lastMessage(session)).toMatchObject({role: 'assistant', stopReason: 'stop'});
  });

  it('holds queued input for the next prompt instead of running it', async () => {
    const {backend, session, faux, events, toolStarted, release} = await createSession();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('work', {step: 1}), {stopReason: 'toolUse'}),
      fauxAssistantMessage(fauxText('done'))
    ]);
    const run = backend.prompt('start');
    await toolStarted;
    await backend.steer('also check the tests');
    await backend.requestPause();
    release();
    await run;

    expect(faux.state.callCount).toBe(1);
    expect(await backend.getQueue()).toEqual({steering: ['also check the tests'], followUp: []});
    expect(events.filter(e => e.type === 'queue_update').at(-1)).toMatchObject({
      steering: ['also check the tests']
    });

    await backend.prompt('continue');
    expect(await backend.getQueue()).toEqual({steering: [], followUp: []});
    const users = session.agent.state.messages
      .filter((message: any) => message.role === 'user')
      .map((message: any) => message.content[0].text);
    expect(users).toEqual(['start', 'continue', 'also check the tests']);
  });

  it('reports a run that ends on its own before reaching a safe point', async () => {
    const {backend, faux, events, toolStarted, release} = await createSession();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('work', {step: 1}), {stopReason: 'toolUse'}),
      fauxAssistantMessage(fauxText('done'))
    ]);
    const run = backend.prompt('start');
    await toolStarted;
    await backend.requestPause();
    await backend.cancelPause();
    release();
    await run;
    expect(faux.state.callCount).toBe(2);
    expect(events.filter(e => e.type === 'safe_pause').map(e => e.state)).toEqual(['requested', 'cancelled']);
  });

  it('does not pause a final answer', async () => {
    const {backend, faux, events} = await createSession();
    let requested!: Promise<void>;
    faux.setResponses([
      () => {
        requested = backend.requestPause();
        return fauxAssistantMessage(fauxText('done'));
      }
    ]);
    await backend.prompt('start');
    await requested;
    expect(events.filter(e => e.type === 'safe_pause').map(e => e.state)).toEqual(['requested', 'finished']);
    expect(events.find(e => e.type === 'agent_settled')).not.toHaveProperty('paused');
  });

  it('rejects a pause while idle', async () => {
    const {backend} = await createSession();
    await expect(backend.requestPause()).rejects.toMatchObject({code: 'AGENT_NOT_RUNNING'});
  });
});
