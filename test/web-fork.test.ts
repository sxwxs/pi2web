import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const forkSource = source.slice(
  source.indexOf('  async function forkPoints('),
  source.indexOf('  async function revert(')
);
const navigateSource = source.slice(
  source.indexOf('  async function navigateAgent('),
  source.indexOf('  const performanceTime =')
);
const revertSource = source.slice(
  source.indexOf('  async function revert('),
  source.indexOf('  async function modelControls(')
);
/** Opening a Session finishes after its summary request; the user may select another one meanwhile. */
const opening = (order: string[]) =>
  vi.fn(async () => {
    order.push('select');
    await new Promise(resolve => setTimeout(resolve, 0));
    order.push('loaded');
  });

/** GET /fork-points: the current branch's user messages, newest first. */
const points = [
  {entryId: 'u2', preview: 'second', timestamp: Date.UTC(2026, 0, 2)},
  {entryId: 'u1', preview: ''}
];

function node(): any {
  return {
    children: [] as any[],
    classList: {add() {}, remove() {}},
    append(...children: any[]) {
      this.children.push(...children);
    },
    querySelectorAll(this: any) {
      return this.children;
    }
  };
}

function setup(data: object[] = points) {
  const source = {agentId: 'bk:source', backendId: 'bk'},
    forked = {agentId: 'bk:fork', backendId: 'bk'};
  const requestAgent = vi.fn(async () => data);
  const postAgent = vi.fn(async () => ({agent: {agentId: 'fork'}, selectedText: 'second'}));
  const order: string[] = [];
  const selectAgent = opening(order);
  const prependInput = vi.fn(() => order.push('input'));
  const toast = vi.fn();
  let dialog: any;
  let choose = (_list: any) => {};
  const modal = vi.fn(async (_title: string, build: (body: any) => () => unknown) => {
    dialog = node();
    const value = build(dialog);
    choose(dialog.children[1]);
    return value();
  });
  const api = runInNewContext(`${forkSource}\n({forkLatest, showForkDialog})`, {
    requestAgent,
    postAgent,
    selectAgent,
    prependInput,
    toast,
    modal,
    stampNewItem: vi.fn(() => forked),
    autoBindNewSession: vi.fn(() => null),
    refreshAgents: vi.fn(async () => {}),
    document: {createElement: node},
    esc: (text: string) => text
  });
  return {
    api,
    source,
    forked,
    requestAgent,
    postAgent,
    selectAgent,
    prependInput,
    toast,
    order,
    dialog: () => dialog,
    onChoose: (fn: (list: any) => void) => (choose = fn)
  };
}

describe('fork from the Session context menu', () => {
  it('lists the fork points, preselects the newest and forks it unless another one is picked', async () => {
    const h = setup();
    await h.api.showForkDialog(h.source);
    expect(h.requestAgent).toHaveBeenCalledWith('bk:source', '/fork-points');
    const list = h.dialog().children[1];
    expect(list.children.map((button: any) => button.className)).toEqual(['choice selected', 'choice']);
    expect(list.children[0].innerHTML).toMatch(/^second<small>.+ · 最新<\/small>$/);
    expect(list.children[1].innerHTML).toBe('(无文字内容)<small></small>');
    expect(h.postAgent).toHaveBeenLastCalledWith('bk:source', '/fork', {entryId: 'u2'});

    h.onChoose(list => list.children[1].onclick());
    await h.api.showForkDialog(h.source);
    expect(h.postAgent).toHaveBeenLastCalledWith('bk:source', '/fork', {entryId: 'u1'});
  });

  it('forks the newest user message directly, opens the new Session and puts the message back', async () => {
    const h = setup();
    await h.api.forkLatest(h.source);
    expect(h.postAgent).toHaveBeenCalledWith('bk:source', '/fork', {entryId: 'u2'});
    expect(h.selectAgent).toHaveBeenCalledWith(h.forked);
    expect(h.prependInput).toHaveBeenCalledWith('second');
    // The message lands while the fork is the selected Session, not after it finished loading.
    expect(h.order).toEqual(['select', 'input', 'loaded']);
  });

  it('does not fork a Session without user messages', async () => {
    const h = setup([]);
    await h.api.forkLatest(h.source);
    await h.api.showForkDialog(h.source);
    expect(h.postAgent).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('这个 Session 还没有用户消息，无法 Fork');
  });
});

describe('Undo', () => {
  it('fills the composer while the Agent is still the selected one', async () => {
    const order: string[] = [],
      input = {
        set value(text: string) {
          order.push(`input ${text}`);
        }
      };
    const {navigateAgent} = runInNewContext(
      `${navigateSource}
({navigateAgent})`,
      {
        state: {agent: {agentId: 'bk:a'}},
        cancelVoiceRecording: vi.fn(),
        postAgent: vi.fn(async () => ({editorText: 'edit me'})),
        selectAgent: opening(order),
        $: () => input,
        toast: vi.fn()
      }
    );
    await navigateAgent('entry');
    expect(order).toEqual(['select', 'input edit me', 'loaded']);
  });

  /**
   * Current branch m → u1 → a1 → u2 → a2; u3 → a3 were abandoned from a1, so they are newer in the file.
   * Confirming the dialog right away returns what it preselected.
   */
  function undo(focused: string | null, leafId: string | null = 'a2') {
    const entry = (id: string, parentId: string | null, role?: string) =>
      role
        ? {type: 'message', id, parentId, message: {role, content: id}}
        : {type: 'model_change', id, parentId};
    const session = {
      leafId,
      entries: [
        entry('m', null),
        entry('u1', 'm', 'user'),
        entry('a1', 'u1', 'assistant'),
        entry('u2', 'a1', 'user'),
        entry('a2', 'u2', 'assistant'),
        entry('u3', 'a1', 'user'),
        entry('a3', 'u3', 'assistant')
      ]
    };
    const navigateAgent = vi.fn(async () => {});
    const {revert} = runInNewContext(`${revertSource}\n({revert})`, {
      state: {agent: {agentId: 'bk:a'}},
      requestAgent: vi.fn(async () => session),
      shortcuts: {focusedItemId: () => focused},
      entryOf: (itemId: string) => itemId.slice(0, itemId.lastIndexOf('.')),
      modal: vi.fn(async (_title: string, build: (body: any) => () => unknown) => build(node())()),
      document: {createElement: node},
      textContent: (content: string) => content,
      esc: (text: string) => text,
      navigateAgent,
      toast: vi.fn()
    });
    return revert().then(() => navigateAgent);
  }

  it('preselects your message of the focused round, else the last round of the current branch', async () => {
    expect(await undo(null)).toHaveBeenCalledWith('u2');
    expect(await undo('u1')).toHaveBeenCalledWith('u1');
    // Found up the session tree from the focused block's entry, also when that message is not loaded;
    // `a1.0` is a part (text, thinking, a tool call) of the Agent message a1.
    expect(await undo('a1.0')).toHaveBeenCalledWith('u1');
    expect(await undo('a2')).toHaveBeenCalledWith('u2');
    // Never a message of an abandoned branch, even though it is newer in the file.
    expect(await undo('u3')).toHaveBeenCalledWith('u2');
    expect(await undo('a3.1')).toHaveBeenCalledWith('u2');
    // An empty current branch (Pi's resetLeaf) has nothing to take back.
    expect(await undo(null, null)).not.toHaveBeenCalled();
  });
});
