import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const forkSource = source.slice(
  source.indexOf('  async function forkPoints('),
  source.indexOf('  async function revert(')
);

const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  timestamp?: string
) => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: {role, content}
});
/** u1 → a1 → u2 → a2 is the current branch; u3 was abandoned by an Undo back to a1. */
const session = {
  leafId: 'a2',
  entries: [
    {type: 'model_change', id: 'm0', parentId: null},
    message('u1', 'm0', 'user', 'first'),
    message('a1', 'u1', 'assistant', [{type: 'text', text: 'one'}]),
    message('u3', 'a1', 'user', 'abandoned'),
    message('u2', 'a1', 'user', [{type: 'text', text: 'second'}], '2026-01-02T03:04:05.000Z'),
    message('a2', 'u2', 'assistant', [{type: 'text', text: 'two'}])
  ]
};

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

function setup(data: object = session) {
  const source = {agentId: 'bk:source', backendId: 'bk'},
    forked = {agentId: 'bk:fork', backendId: 'bk'};
  const requestAgent = vi.fn(async () => data);
  const postAgent = vi.fn(async () => ({agent: {agentId: 'fork'}, selectedText: 'second'}));
  const order: string[] = [];
  const selectAgent = vi.fn(async () => {
    order.push('select');
  });
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
  const api = runInNewContext(`${forkSource}\n({forkPoints, forkLatest, showForkDialog})`, {
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
    esc: (text: string) => text,
    textContent: (content: unknown) =>
      typeof content === 'string' ? content : (content as any[]).map(part => part.text).join('\n')
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
  it('offers the current branch user messages only, newest first', async () => {
    const h = setup();
    const points = await h.api.forkPoints(h.source);
    expect(points.map((entry: any) => entry.id)).toEqual(['u2', 'u1']);
    expect(h.requestAgent).toHaveBeenCalledWith('bk:source', '/session');
  });

  it('preselects the newest user message and forks it unless another one is picked', async () => {
    const h = setup();
    await h.api.showForkDialog(h.source);
    const list = h.dialog().children[1];
    expect(list.children.map((button: any) => button.className)).toEqual(['choice selected', 'choice']);
    expect(list.children[0].innerHTML).toContain('最新');
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
    // Selecting first: the input must hold the message once the new Session is shown.
    expect(h.order).toEqual(['select', 'input']);
  });

  it('does not fork a Session without user messages', async () => {
    const h = setup({leafId: 'm0', entries: [{type: 'model_change', id: 'm0', parentId: null}]});
    await h.api.forkLatest(h.source);
    await h.api.showForkDialog(h.source);
    expect(h.postAgent).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('这个 Session 还没有用户消息，无法 Fork');
  });
});
