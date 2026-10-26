import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
// The real card, timeline and streaming code, without booting the rest of the UI.
const timelineSource = source.slice(
  source.indexOf('  function renderCardBody('),
  source.indexOf('  function extensionRequest(')
);

/** Just enough of the DOM for the transcript code. */
class Element {
  id = '';
  className = '';
  textContent = '';
  title = '';
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parent: Element | null = null;
  listeners: Record<string, Array<() => void>> = {};
  private isOpen = false;
  get open() {
    return this.isOpen;
  }
  set open(value: boolean) {
    const changed = this.isOpen !== value;
    this.isOpen = value;
    if (changed) for (const listener of this.listeners.toggle ?? []) listener();
  }
  set innerHTML(value: string) {
    this.replaceChildren();
    this.textContent = value.replace(/<[^>]+>/g, '');
    if (value.includes('class="empty"')) this.append(Object.assign(new Element(), {className: 'empty'}));
  }
  classList = {
    toggle: (name: string, on?: boolean) => {
      const names = this.className.split(' ').filter(Boolean),
        has = names.includes(name);
      if (on ?? !has) {
        if (!has) this.className = [...names, name].join(' ');
      } else this.className = names.filter(x => x !== name).join(' ');
    },
    add: (name: string) => this.classList.toggle(name, true),
    contains: (name: string) => this.className.split(' ').includes(name)
  };
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  append(...children: (Element | string)[]) {
    for (const child of children) {
      if (typeof child === 'string') continue;
      // Appending a fragment moves its children.
      const nodes = child.className === '#fragment' ? child.children.splice(0) : [child];
      for (const node of nodes) {
        node.parent?.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = this;
        this.children.push(node);
      }
    }
  }
  prepend(child: Element) {
    const nodes = child.className === '#fragment' ? child.children.splice(0) : [child];
    for (const node of nodes) node.parent = this;
    this.children.unshift(...nodes);
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node: Element) {
    const parent = this.parent!;
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
    this.parent = null;
  }
  before(node: Element) {
    const parent = this.parent!;
    parent.children.splice(parent.children.indexOf(this), 0, node);
    node.parent = parent;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1];
  }
  get childElementCount() {
    return this.children.length;
  }
  descendants(): Element[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
  querySelectorAll(selector: string) {
    return this.descendants().filter(child =>
      selector.startsWith('#')
        ? child.id === selector.slice(1)
        : child.className.split(' ').includes(selector.slice(1))
    );
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0];
  }
}

function setup(pages: any[] = []) {
  const messages = new Element();
  const state: any = {
    selectedKind: 'agent',
    agent: {agentId: 'bk:agent-a', backendId: 'bk'},
    timeline: null,
    timelineCache: new Map(),
    itemBodies: new Map(),
    streams: new Map(),
    liveCards: [],
    bashCards: new Map(),
    optimistic: []
  };
  const requestAgent = vi.fn(async (_agentId: string, url: string) => {
    if (url.startsWith('/timeline')) return pages.shift();
    return {body: `full body of ${url.split('/').pop()}`};
  });
  const sendFocused = vi.fn(),
    // No socket unless a test says so: loading then does not wait for focus_state.
    sendFocus = vi.fn(() => false),
    restoreExtensionRequests = vi.fn(),
    renderTranscriptEvent = vi.fn();
  const api = runInNewContext(
    `${timelineSource}\n({loadTimeline, handleDetail, addCard})`,
    {
      state,
      $: () => messages,
      window: {},
      requestAgent,
      sendFocused,
      sendFocus,
      restoreExtensionRequests,
      renderTranscriptEvent,
      toast: vi.fn(),
      setTimeout,
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
      document: {
        createElement: () => new Element(),
        createDocumentFragment: () => Object.assign(new Element(), {className: '#fragment'})
      }
    },
    {filename: 'web/app.js'}
  );
  const card = (id: string) => messages.descendants().find(el => el.dataset.itemId === id)!;
  const summary = (id: string) => card(id).querySelector('.summary-text')!.textContent;
  const body = (id: string) => card(id).querySelector('.msg-content')!.textContent;
  // Timeline changes are numbered from the page's version (0 in these pages) unless a test sets one.
  let version = 0;
  const detail = (message: any) =>
    api.handleDetail({
      agentId: 'bk:agent-a',
      ...(['items', 'timeline_reset'].includes(message.type) ? {version: ++version} : {}),
      ...message
    });
  return {
    messages,
    state,
    requestAgent,
    sendFocused,
    sendFocus,
    restoreExtensionRequests,
    renderTranscriptEvent,
    card,
    summary,
    body,
    detail,
    ...api
  };
}

const page = (items: any[], extra = {}) => ({
  sessionId: 's1',
  version: 0,
  items,
  total: items.length,
  start: 0,
  hasMore: false,
  ...extra
});
const user = {id: 'e1', kind: 'user', size: 2, body: 'hi'};
const running = {
  id: 'e2.0',
  kind: 'tool',
  title: 'bash',
  summary: 'npm test',
  status: 'pending',
  toolCallId: 'call-1',
  size: 26,
  body: '{"command": "npm test"}'
};
const big = {
  id: 'e3.0',
  kind: 'tool',
  title: 'read',
  summary: 'a.ts',
  status: 'ok',
  size: 9000,
  durationMs: 900
};

describe('timeline rendering', () => {
  it('shows summaries, groups activity, and loads a large body once when expanded', async () => {
    const ui = setup([page([user, big])]);
    await ui.loadTimeline(ui.state.agent);
    expect(ui.body('e1')).toBe('hi');
    expect(ui.summary('e3.0')).toBe('✓ read · a.ts');
    expect(ui.card('e3.0').querySelector('.tool-duration')!.textContent).toBe('900 ms');
    expect(ui.body('e3.0')).toBe('展开以加载（8.8K 字符）');
    expect(ui.messages.querySelector('.activity-group')!.querySelector('.activity-count')!.textContent).toBe(
      '1 项'
    );
    ui.card('e3.0').open = true;
    await vi.waitFor(() => expect(ui.body('e3.0')).toBe('full body of e3.0'));
    expect(ui.requestAgent).toHaveBeenLastCalledWith('bk:agent-a', '/sessions/s1/items/e3.0');
    // Collapsing and expanding again, even after reloading the page, needs no request.
    ui.card('e3.0').open = false;
    ui.card('e3.0').open = true;
    expect(ui.requestAgent).toHaveBeenCalledTimes(2);
  });

  it('streams output of an expanded running tool and replaces the card when it finishes', async () => {
    const ui = setup([page([running])]);
    await ui.loadTimeline(ui.state.agent);
    expect(ui.summary('e2.0')).toBe('⏳ bash · npm test · 执行中');
    ui.card('e2.0').open = true;
    expect(ui.sendFocused).toHaveBeenCalledWith({type: 'watch', toolCallId: 'call-1'});
    ui.detail({type: 'tool_output', toolCallId: 'call-1', output: 'PASS 3'});
    expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 输出 —\nPASS 3');
    ui.detail({
      type: 'items',
      sessionId: 's1',
      items: [],
      updated: [{...running, status: 'ok', size: 9000, body: undefined, toolCallId: undefined, rev: 'r1'}]
    });
    const replaced = ui.card('e2.0');
    expect(ui.summary('e2.0')).toBe('✓ bash · npm test');
    expect(replaced.open).toBe(true);
    await vi.waitFor(() => expect(ui.body('e2.0')).toBe('full body of e2.0?rev=r1'));
    expect(ui.requestAgent).toHaveBeenLastCalledWith('bk:agent-a', '/sessions/s1/items/e2.0?rev=r1');
    // The collapsed group's summary follows the finished card.
    expect(ui.messages.querySelector('.activity-group')!.querySelector('.summary-text')!.textContent).toBe(
      '✓ bash · npm test'
    );
    expect(ui.messages.querySelectorAll('.tool')).toHaveLength(1);
  });

  it('replaces streamed text with the recorded items and drops optimistic prompts', async () => {
    const ui = setup([page([user])]);
    await ui.loadTimeline(ui.state.agent);
    ui.state.optimistic.push(ui.addCard(null, 'next question', 'user'));
    ui.detail({
      type: 'items',
      sessionId: 's1',
      items: [{id: 'e4', kind: 'user', size: 13, body: 'next question'}]
    });
    ui.detail({type: 'delta', kind: 'thinking', delta: 'pondering'});
    ui.detail({type: 'delta', kind: 'text', delta: 'Hel'});
    ui.detail({type: 'delta', kind: 'text', delta: 'lo'});
    const texts = () => ui.messages.querySelectorAll('.msg-content').map(el => el.textContent);
    await vi.waitFor(() => expect(texts()).toEqual(['hi', 'next question', 'pondering', 'Hello']));
    ui.detail({
      type: 'items',
      sessionId: 's1',
      clearLive: true,
      items: [
        {id: 'e5.0', kind: 'thinking', size: 9, body: 'pondering'},
        {id: 'e5.1', kind: 'assistant', size: 5, body: 'Hello'}
      ]
    });
    expect(ui.state.timeline.items.map((item: any) => item.id)).toEqual(['e1', 'e4', 'e5.0', 'e5.1']);
    expect(ui.messages.children.map(el => el.dataset.itemId)).toEqual(['e1', 'e4', 'e5.0', 'e5.1']);
  });

  it('applies details that arrive while loading after the page, in order', async () => {
    let release!: (value: unknown) => void;
    const ui = setup();
    ui.requestAgent.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
    const loading = ui.loadTimeline(ui.state.agent);
    const dialog = {type: 'extension_ui_request', requestId: 'q', kind: 'confirm', title: 'Go?'};
    ui.detail({type: 'focus_state', live: {text: 'Wor', thinking: ''}, dialogRequests: [dialog]});
    ui.detail({type: 'delta', kind: 'text', delta: 'king'});
    release(page([user]));
    await loading;
    await vi.waitFor(() =>
      expect(ui.messages.querySelectorAll('.msg-content').map(el => el.textContent)).toEqual([
        'hi',
        'Working'
      ])
    );
    // Dialog controls are rebuilt once the transcript they live in is shown.
    expect(ui.restoreExtensionRequests).toHaveBeenCalledExactlyOnceWith('bk:agent-a', {
      dialogRequests: [dialog]
    });
  });

  it('reloads when the session changed and shows the cached copy at once when coming back', async () => {
    const ui = setup([page([user]), page([{...user, id: 'f1', body: 'other'}], {sessionId: 's2'})]);
    await ui.loadTimeline(ui.state.agent);
    ui.detail({type: 'items', sessionId: 's2', items: []});
    await vi.waitFor(() => expect(ui.state.timeline.sessionId).toBe('s2'));
    expect(ui.body('f1')).toBe('other');
    let release!: (value: unknown) => void;
    ui.requestAgent.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
    const loading = ui.loadTimeline(ui.state.agent);
    expect(ui.body('f1')).toBe('other'); // Before the server answered.
    release(page([{...user, id: 'f1', body: 'other'}], {sessionId: 's2'}));
    await loading;
    expect(ui.body('f1')).toBe('other');
  });

  it('pages back through older items', async () => {
    const ui = setup([
      page([user], {start: 1, total: 2, hasMore: true}),
      page([{...user, id: 'e0', body: 'first'}])
    ]);
    await ui.loadTimeline(ui.state.agent);
    const button = ui.messages.querySelector('#loadOlderMessages')!;
    expect(button.textContent).toBe('加载更早的对话（还有 1 项）');
    await (button as any).onclick();
    await vi.waitFor(() => expect(ui.messages.children.map(el => el.dataset.itemId)).toEqual(['e0', 'e1']));
    expect(ui.requestAgent).toHaveBeenLastCalledWith('bk:agent-a', '/timeline?limit=50&before=e1');
  });

  it('skips updates to history that is not loaded instead of appending them', async () => {
    const ui = setup([page([user], {start: 60, total: 61, hasMore: true})]);
    await ui.loadTimeline(ui.state.agent);
    ui.detail({
      type: 'items',
      sessionId: 's1',
      items: [],
      updated: [{...running, id: 'old.0', status: 'ok'}]
    });
    expect(ui.messages.children.map(el => el.dataset.itemId).filter(Boolean)).toEqual(['e1']);
    expect(ui.state.timeline.items.map((item: any) => item.id)).toEqual(['e1']);
  });

  it('shows an emptied timeline instead of the cached conversation', async () => {
    const ui = setup([page([user]), page([])]);
    await ui.loadTimeline(ui.state.agent);
    await ui.loadTimeline(ui.state.agent);
    expect(ui.state.timeline.items).toEqual([]);
    expect(ui.messages.querySelector('.empty')).toBeDefined();
    expect(ui.messages.descendants().some(el => el.dataset.itemId)).toBe(false);
  });

  it('holds transcript events (dialogs, shell output) that arrive while loading until the page is shown', async () => {
    let release!: (value: unknown) => void;
    const ui = setup();
    ui.requestAgent.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
    const loading = ui.loadTimeline(ui.state.agent);
    const dialog = {
      type: 'agent_event',
      agentId: 'bk:agent-a',
      event: {type: 'extension_ui_request', requestId: 'q'}
    };
    ui.detail({type: 'focus_state', live: null});
    ui.handleDetail(dialog);
    expect(ui.renderTranscriptEvent).not.toHaveBeenCalled();
    release(page([user]));
    await loading;
    expect(ui.renderTranscriptEvent).toHaveBeenCalledExactlyOnceWith(dialog);
    // Rendered after the focus baseline, in arrival order.
    expect(ui.restoreExtensionRequests.mock.invocationCallOrder[0]).toBeLessThan(
      ui.renderTranscriptEvent.mock.invocationCallOrder[0]
    );
  });

  it('reads the page only after the server confirmed the focus', async () => {
    const ui = setup([page([user])]);
    ui.sendFocus.mockReturnValue(true);
    const loading = ui.loadTimeline(ui.state.agent);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ui.requestAgent).not.toHaveBeenCalled();
    ui.detail({type: 'focus_state', version: 0, live: null});
    await loading;
    expect(ui.requestAgent).toHaveBeenCalledOnce();
    expect(ui.body('e1')).toBe('hi');
  });

  it('applies only timeline changes after the page, and still drops their streamed text', async () => {
    let release!: (value: unknown) => void;
    const ui = setup();
    ui.requestAgent.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
    const loading = ui.loadTimeline(ui.state.agent);
    ui.detail({type: 'focus_state', live: {text: 'Hello', thinking: ''}});
    // Recorded before the page was read: the page has it, so it must not be appended again.
    ui.detail({
      type: 'items',
      version: 7,
      sessionId: 's1',
      clearLive: true,
      items: [{id: 'e2', kind: 'assistant', size: 5, body: 'Hello'}]
    });
    ui.detail({
      type: 'items',
      version: 8,
      sessionId: 's1',
      items: [{id: 'e3', kind: 'user', size: 4, body: 'next'}]
    });
    release(page([user, {id: 'e2', kind: 'assistant', size: 5, body: 'Hello'}], {version: 7}));
    await loading;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ui.messages.children.map(el => el.dataset.itemId)).toEqual(['e1', 'e2', 'e3']);
    expect(ui.state.timeline.version).toBe(8);
  });

  it('reloads after a gap in timeline changes', async () => {
    const ui = setup([
      page([user]),
      page([user, {id: 'e5', kind: 'user', size: 1, body: 'x'}], {version: 5})
    ]);
    await ui.loadTimeline(ui.state.agent);
    ui.detail({
      type: 'items',
      version: 3,
      sessionId: 's1',
      items: [{id: 'e4', kind: 'user', size: 1, body: 'y'}]
    });
    await vi.waitFor(() => expect(ui.state.timeline.version).toBe(5));
    expect(ui.messages.children.map(el => el.dataset.itemId)).toEqual(['e1', 'e5']);
  });

  it('extends a watched tool output with appended parts', async () => {
    const ui = setup([page([running])]);
    await ui.loadTimeline(ui.state.agent);
    ui.card('e2.0').open = true;
    ui.detail({type: 'tool_output', toolCallId: 'call-1', output: 'one'});
    ui.detail({type: 'tool_output', toolCallId: 'call-1', append: ' two'});
    expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 输出 —\none two');
    ui.detail({type: 'tool_output', toolCallId: 'call-1', output: 'tail only'});
    expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 输出 —\ntail only');
  });
});
