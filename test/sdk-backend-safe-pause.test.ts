import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Type} from 'typebox';
import {fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import {SdkBackend} from '../src/sdk-backend.js';
import type {AgentEvent} from '../src/agents.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Options = {retryDelayMs?: number; extension?: ExtensionFactory};

/**
 * A real Pi session (auto-retry on) driven by a scripted model, with one tool whose completion
 * the test controls. Every test checks the safe pause promise: once a pause is requested at a
 * point the model is not working, the model is not asked again.
 */
async function createSession({retryDelayMs = 1, extension}: Options = {}) {
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
  const work = {
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
  const settingsManager = SettingsManager.inMemory({
    retry: {enabled: true, maxRetries: 3, baseDelayMs: retryDelayMs}
  } as any);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extension ? [{name: 'test-extension', factory: extension}] : []
  } as any);
  await resourceLoader.reload();
  const {session} = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    resourceLoader,
    tools: ['work'],
    customTools: [work]
  });
  const backend = await SdkBackend.fromSession(session, 'agent-a', dir);
  cleanups.push(() => backend.dispose());
  const events: AgentEvent[] = [];
  backend.subscribe(event => events.push(event));
  const pauseStates = () => events.filter(e => e.type === 'safe_pause').map(e => e.state);
  const settled = () => events.filter(e => e.type === 'agent_settled');
  return {backend, session, faux, events, pauseStates, settled, toolStarted, release};
}

const toolTurn = (step: number) =>
  fauxAssistantMessage(fauxToolCall('work', {step}), {stopReason: 'toolUse'});
const retryableError = () =>
  fauxAssistantMessage(fauxText(''), {stopReason: 'error', errorMessage: '503 service unavailable'});
/** The model context Pi would continue from. */
const lastContextRole = (session: any) => session.agent.state.messages.at(-1)?.role;

describe('SDK backend safe pause', () => {
  it('gate A: stops after the running tools, before the next turn', async () => {
    const {backend, session, faux, pauseStates, settled, toolStarted, release} = await createSession();
    faux.setResponses([toolTurn(1), toolTurn(2), fauxAssistantMessage(fauxText('all done'))]);
    const run = backend.prompt('start');
    await toolStarted;
    await backend.requestPause();
    release();
    await run;

    expect(faux.state.callCount).toBe(1);
    expect(session.isStreaming).toBe(false);
    expect(lastContextRole(session)).toBe('toolResult');
    // The tool result is in the session file, so the stopped transcript survives a restart.
    const persisted = session.sessionManager.getBranch().filter((entry: any) => entry.type === 'message');
    expect(persisted.at(-1)).toMatchObject({message: {role: 'toolResult'}});
    expect(pauseStates()).toEqual(['requested', 'reached', 'paused']);
    expect(settled()).toEqual([expect.objectContaining({paused: true})]);

    // A new prompt carries on from the paused transcript.
    await backend.prompt('go on');
    expect(faux.state.callCount).toBe(3);
    expect(session.agent.state.messages.at(-1)).toMatchObject({role: 'assistant', stopReason: 'stop'});
  });

  it('gate B: keeps queued input queued instead of running it, and delivers it with the next prompt', async () => {
    const {backend, session, faux, pauseStates, toolStarted, release} = await createSession();
    faux.setResponses([toolTurn(1), fauxAssistantMessage(fauxText('done')), fauxText('unused') as any]);
    const run = backend.prompt('start');
    await toolStarted;
    await backend.steer('also check the tests');
    await backend.requestPause();
    release();
    await run;

    expect(faux.state.callCount).toBe(1);
    expect(pauseStates()).toEqual(['requested', 'reached', 'paused']);
    expect(await backend.getQueue()).toEqual({steering: ['also check the tests'], followUp: []});

    await backend.prompt('continue');
    expect(await backend.getQueue()).toEqual({steering: [], followUp: []});
    const users = session.agent.state.messages
      .filter((message: any) => message.role === 'user')
      .map((message: any) => message.content[0].text);
    expect(users).toEqual(['start', 'continue', 'also check the tests']);
  });

  it('gate B: withholds an auto-retry scheduled after the pause was requested', async () => {
    const {backend, session, faux, pauseStates, settled} = await createSession();
    faux.setResponses([
      // The pause arrives while this request is in flight; the request then fails and Pi schedules a retry.
      async () => {
        await backend.requestPause();
        return retryableError();
      },
      fauxAssistantMessage(fauxText('retried'))
    ]);
    await backend.prompt('start');

    expect(faux.state.callCount).toBe(1);
    expect(pauseStates()).toEqual(['requested', 'reached', 'paused']);
    expect(settled()).toEqual([expect.objectContaining({paused: true})]);
    // Pi drops the failed attempt from the model context, so the session carries on from the prompt.
    expect(lastContextRole(session)).toBe('user');
  });

  it('cancels a retry backoff that is already waiting', async () => {
    // A one-minute backoff: the test only finishes in time if the pause cancels it.
    const {backend, faux, events, pauseStates} = await createSession({retryDelayMs: 60_000});
    faux.setResponses([retryableError(), fauxAssistantMessage(fauxText('retried'))]);
    const run = backend.prompt('start');
    await new Promise<void>(resolve => {
      const check = () =>
        events.some(e => e.type === 'auto_retry_start') ? resolve() : setTimeout(check, 1);
      check();
    });
    await backend.requestPause();
    await run;

    expect(faux.state.callCount).toBe(1);
    expect(pauseStates()).toEqual(['requested', 'reached', 'paused']);
  });

  it('gate B: withholds a continuation an extension asks for before the run settles', async () => {
    let requested!: Promise<void>;
    let nudged = false;
    const {backend, faux, pauseStates} = await createSession({
      extension: pi => {
        // Like a "keep going" nudge: append a message the model should answer, then ask to continue once.
        pi.on('agent_before_settle', event => {
          if (nudged) return undefined;
          nudged = true;
          return {
            entries: [
              ...event.entries,
              {type: 'custom_message', customType: 'nudge', content: 'keep going', display: true}
            ],
            continue: true
          };
        });
      }
    });
    faux.setResponses([
      () => {
        requested = backend.requestPause();
        return fauxAssistantMessage(fauxText('done'));
      },
      fauxAssistantMessage(fauxText('extension continuation'))
    ]);
    await backend.prompt('start');
    await requested;

    expect(faux.state.callCount).toBe(1);
    expect(pauseStates()).toEqual(['requested', 'reached', 'paused']);
  });

  it('can be withdrawn until it is reached, not after', async () => {
    const first = await createSession();
    first.faux.setResponses([toolTurn(1), fauxAssistantMessage(fauxText('done'))]);
    let run = first.backend.prompt('start');
    await first.toolStarted;
    await first.backend.requestPause();
    await first.backend.cancelPause();
    first.release();
    await run;
    expect(first.faux.state.callCount).toBe(2);
    expect(first.pauseStates()).toEqual(['requested', 'cancelled']);

    const second = await createSession();
    second.faux.setResponses([toolTurn(1), fauxAssistantMessage(fauxText('done'))]);
    let cancelled: Promise<void> | undefined;
    second.backend.subscribe(event => {
      if (event.type === 'safe_pause' && event.state === 'reached') cancelled = second.backend.cancelPause();
    });
    run = second.backend.prompt('start');
    await second.toolStarted;
    await second.backend.requestPause();
    second.release();
    await run;
    await expect(cancelled).rejects.toMatchObject({code: 'PAUSE_ALREADY_REACHED'});
    expect(second.faux.state.callCount).toBe(1);
    expect(second.pauseStates()).toEqual(['requested', 'reached', 'paused']);
  });

  it('reports a run that ends on its own before reaching a safe point', async () => {
    const {backend, faux, pauseStates, settled} = await createSession();
    let requested!: Promise<void>;
    faux.setResponses([
      () => {
        requested = backend.requestPause();
        return fauxAssistantMessage(fauxText('done'));
      }
    ]);
    await backend.prompt('start');
    await requested;
    expect(pauseStates()).toEqual(['requested', 'finished']);
    expect(settled()[0]).not.toHaveProperty('paused');
  });

  it('rejects a pause while idle', async () => {
    const {backend} = await createSession();
    await expect(backend.requestPause()).rejects.toMatchObject({code: 'AGENT_NOT_RUNNING'});
  });
});
