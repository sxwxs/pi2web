import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {SdkBackend} from '../src/sdk-backend.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** A persisted Pi session with two turns, wrapped by the SDK adapter. No model is called. */
async function twoTurnSession() {
  const dir = mkdtempSync(join(tmpdir(), 'pi2web-fork-'));
  dirs.push(dir);
  const manager = SessionManager.create(dir, dir);
  const text = (value: string) => [{type: 'text', text: value}];
  const first = manager.appendMessage({role: 'user', content: 'first', timestamp: 1} as any);
  manager.appendMessage({role: 'assistant', content: text('one'), timestamp: 2} as any);
  const second = manager.appendMessage({role: 'user', content: text('second'), timestamp: 3} as any);
  manager.appendMessage({role: 'assistant', content: text('two'), timestamp: 4} as any);
  const session = {
    sessionManager: manager,
    get sessionFile() {
      return manager.getSessionFile();
    },
    // Safe pause wraps the agent's finishTurn hook and continue().
    agent: {continue: async () => {}},
    subscribe: () => () => {},
    bindExtensions: async () => {}
  };
  const backend = await SdkBackend.fromSession(session as any, 'agent-a', dir);
  return {backend, manager, dir, first, second, sourceFile: manager.getSessionFile()!};
}

const contents = (manager: SessionManager) => manager.getBranch().map((entry: any) => entry.message?.content);

describe('SDK backend fork', () => {
  it('writes the branch before the user message to a new file and leaves the source session alone', async () => {
    const {backend, manager, dir, second, sourceFile} = await twoTurnSession();
    const before = contents(manager);

    const result = await backend.fork(second);

    expect(result.selectedText).toBe('second');
    expect(result.sessionFile).toBeTruthy();
    expect(result.sessionFile).not.toBe(sourceFile);
    // The source Agent keeps writing its own file and still shows its full conversation.
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(contents(manager)).toEqual(before);
    const forked = SessionManager.open(result.sessionFile!, dir);
    expect(contents(forked)).toEqual(['first', [{type: 'text', text: 'one'}]]);
    expect(forked.getHeader()?.parentSession).toBe(sourceFile);
    expect(contents(SessionManager.open(sourceFile, dir))).toEqual(before);
  });

  it('only forks before user messages', async () => {
    const {backend, manager} = await twoTurnSession();
    const reply = manager.getBranch().find((entry: any) => entry.message?.role === 'assistant')!;
    await expect(backend.fork(reply.id)).rejects.toMatchObject({code: 'SESSION_ENTRY_NOT_FOUND'});
  });
});
