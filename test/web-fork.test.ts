import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const forkSource = source.slice(
  source.indexOf('  async function forkPoints('),
  source.indexOf('  async function revert(')
);

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
    // Selecting first: the input must hold the message once the new Session is shown.
    expect(h.order).toEqual(['select', 'input']);
  });

  it('does not fork a Session without user messages', async () => {
    const h = setup([]);
    await h.api.forkLatest(h.source);
    await h.api.showForkDialog(h.source);
    expect(h.postAgent).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('这个 Session 还没有用户消息，无法 Fork');
  });
});
