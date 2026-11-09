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
  hidden = false;
  scrollHeight = 0;
  clientHeight = 0;
  private top = 0;
  // Like a browser, the scroll position stays within the content.
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }
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

function setup(olderPages: any[] = []) {
  const messages = new Element(),
    jump = Object.assign(new Element(), {hidden: true, textContent: '↓ 最新'}); // As in index.html.
  const state: any = {
    followOutput: true,
    messagesScrollTop: 0,
    selectedKind: 'agent',
    agent: {agentId: 'bk:agent-a', backendId: 'bk'},
    timeline: null,
    timelineCache: new Map(),
    itemBodies: new Map(),
    activities: new Map(),
    streams: new Map(),
    liveCards: [],
    bashCards: new Map(),
    optimistic: [],
    uncertainSends: new Map()
  };
  const requestAgent = vi.fn(async (_agentId: string, url: string) => {
    if (url.startsWith('/timeline')) return olderPages.shift();
    return {body: `full body of ${url.split('/').pop()}`};
  });
  const sendFocused = vi.fn(),
    sendFocus = vi.fn(() => true),
    restoreExtensionRequests = vi.fn(),
    renderTranscriptEvent = vi.fn(),
    showUncertainSend = vi.fn();
  const api = runInNewContext(
    `${timelineSource}\n({loadTimeline, handleDetail, addCard, refreshToolCards, followLatest, onMessagesScroll})`,
    {
      state,
      $: (id: string) => (id === 'jumpToLatest' ? jump : messages),
      window: {},
      requestAgent,
      sendFocused,
      sendFocus,
      restoreExtensionRequests,
      renderTranscriptEvent,
      showUncertainSend,
      toast: vi.fn(),
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
  const ids = () => messages.children.map(el => el.dataset.itemId).filter(Boolean);
  const detail = (message: any) => api.handleDetail({agentId: 'bk:agent-a', sessionId: 's1', ...message});
  /** Select the Agent and deliver the snapshot the server answers `focus` with. */
  const open = (items: any[], extra: any = {}) => {
    api.loadTimeline(state.agent);
    detail({
      type: 'focus_state',
      page: {items, total: items.length, start: 0, hasMore: false},
      live: null,
      ...extra
    });
  };
  const running = (toolCallId: string) =>
    state.activities.set('bk:agent-a', {
      run: {startedAt: 1},
      phase: {kind: 'running_tools', since: 1, tools: [{toolCallId, toolName: 'bash', since: 1}]}
    });
  return {
    messages,
    jump,
    state,
    requestAgent,
    sendFocused,
    sendFocus,
    restoreExtensionRequests,
    showUncertainSend,
    card,
    summary,
    body,
    ids,
    detail,
    open,
    running,
    ...api
  };
}

const user = {id: 'e1', kind: 'user', size: 2, body: 'hi'};
const call = {
  id: 'e2.0',
  kind: 'tool_call',
  title: 'bash',
  summary: 'npm test',
  toolCallId: 'c1',
  size: 23,
  body: '{"command": "npm test"}'
};
const result = {
  id: 'e3',
  kind: 'tool_result',
  title: 'bash',
  status: 'ok',
  toolCallId: 'c1',
  size: 9000,
  durationMs: 900
};

describe('timeline rendering', () => {
  it('shows the snapshot, groups activity, and loads a large body once when expanded', async () => {
    const ui = setup();
    ui.open([user, call, result]);
    expect(ui.body('e1')).toBe('hi');
    // The call and its result are one card.
    expect(ui.summary('e2.0')).toBe('✓ bash · npm test');
    expect(ui.card('e2.0').querySelector('.tool-duration')!.textContent).toBe('900 ms');
    expect(ui.messages.querySelector('.activity-group')!.querySelector('.activity-count')!.textContent).toBe(
      '1 项'
    );
    ui.card('e2.0').open = true;
    await vi.waitFor(() =>
      expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 结果 —\nfull body of e3')
    );
    expect(ui.requestAgent).toHaveBeenCalledExactlyOnceWith('bk:agent-a', '/sessions/s1/items/e3');
    ui.card('e2.0').open = false;
    ui.card('e2.0').open = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ui.requestAgent).toHaveBeenCalledOnce();
  });

  it('shows a call as running from the activity, watches it while expanded, and completes it with its result', async () => {
    const ui = setup();
    ui.running('c1');
    ui.open([call]);
    expect(ui.summary('e2.0')).toBe('⏳ bash · npm test · 执行中');
    ui.card('e2.0').open = true;
    expect(ui.sendFocused).toHaveBeenCalledWith({type: 'watch', toolCallId: 'c1'});
    ui.detail({type: 'tool_output', toolCallId: 'c1', output: 'PASS 3'});
    expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 输出 —\nPASS 3');
    ui.state.activities.set('bk:agent-a', {run: {startedAt: 1}, phase: {kind: 'waiting_llm', since: 2}});
    ui.detail({type: 'items', items: [{...result, size: 2, body: 'ok'}]});
    expect(ui.summary('e2.0')).toBe('✓ bash · npm test');
    expect(ui.sendFocused).toHaveBeenLastCalledWith({type: 'unwatch', toolCallId: 'c1'});
    await vi.waitFor(() => expect(ui.body('e2.0')).toBe('{"command": "npm test"}\n\n— 结果 —\nok'));
    // The collapsed group's summary follows the finished card.
    expect(ui.messages.querySelector('.activity-group')!.querySelector('.summary-text')!.textContent).toBe(
      '✓ bash · npm test'
    );
  });

  it('tells calls waiting in the run going on from ones that never finished', () => {
    const ui = setup();
    const old = {...call, id: 'e0.0', toolCallId: 'c0'};
    ui.state.activities.set('bk:agent-a', {run: {startedAt: 1}, phase: {kind: 'waiting_llm', since: 1}});
    ui.open([old, user, call]);
    expect(ui.summary('e0.0')).toBe('⊘ bash · npm test · 未完成');
    expect(ui.summary('e2.0')).toBe('⋯ bash · npm test · 等待执行');
    // The run ends without a result: the call did not finish.
    ui.state.activities.delete('bk:agent-a');
    ui.refreshToolCards('bk:agent-a');
    expect(ui.summary('e2.0')).toBe('⊘ bash · npm test · 未完成');
  });

  it('replaces streamed text with the recorded items and drops optimistic prompts', async () => {
    const ui = setup();
    ui.open([user]);
    ui.state.optimistic.push(ui.addCard(null, 'next question', 'user'));
    ui.detail({type: 'items', items: [{id: 'e4', kind: 'user', size: 13, body: 'next question'}]});
    ui.detail({type: 'delta', kind: 'thinking', delta: 'pondering'});
    ui.detail({type: 'delta', kind: 'text', delta: 'Hel'});
    ui.detail({type: 'delta', kind: 'text', delta: 'lo'});
    const texts = () => ui.messages.querySelectorAll('.msg-content').map(el => el.textContent);
    await vi.waitFor(() => expect(texts()).toEqual(['hi', 'next question', 'pondering', 'Hello']));
    ui.detail({
      type: 'items',
      clearLive: true,
      items: [
        {id: 'e5.0', kind: 'thinking', size: 9, body: 'pondering'},
        {id: 'e5.1', kind: 'assistant', size: 5, body: 'Hello'}
      ]
    });
    expect(ui.ids()).toEqual(['e1', 'e4', 'e5.0', 'e5.1']);
  });

  it('shows the cached copy at once, then the snapshot, ignoring what arrives before it', () => {
    const ui = setup();
    ui.open([user]);
    ui.state.timeline = null;
    ui.loadTimeline(ui.state.agent);
    expect(ui.ids()).toEqual(['e1']); // Cached, before the server answered.
    ui.detail({type: 'items', items: [{id: 'old', kind: 'user', size: 1, body: 'x'}]});
    expect(ui.ids()).toEqual(['e1']);
    ui.detail({
      type: 'focus_state',
      page: {items: [], total: 0, start: 0, hasMore: false},
      live: {text: 'Work', thinking: ''},
      dialogRequests: [{requestId: 'q'}]
    });
    expect(ui.ids()).toEqual([]);
    expect(ui.restoreExtensionRequests).toHaveBeenCalledWith('bk:agent-a', {
      dialogRequests: [{requestId: 'q'}]
    });
  });

  it.each([true, false])(
    'keeps delivery notices through offline Agent switches and reconnect (cached: %s)',
    cached => {
      const ui = setup();
      const agent = ui.state.agent;
      ui.showUncertainSend.mockImplementation((_agentId, text) =>
        ui.addCard('送达状态未知', text, 'error', true)
      );
      ui.state.uncertainSends.set(agent.agentId, ['check delivery']);
      ui.open([user]);
      expect(ui.messages.querySelectorAll('.error')).toHaveLength(1);

      ui.sendFocus.mockReturnValue(false); // No snapshot can arrive while offline.
      ui.state.agent = {agentId: 'bk:agent-b', backendId: 'bk'};
      ui.loadTimeline(ui.state.agent);
      expect(ui.messages.querySelectorAll('.error')).toHaveLength(0);
      if (!cached) ui.state.timelineCache.delete(agent.agentId);
      ui.state.agent = agent;
      ui.showUncertainSend.mockClear();
      ui.loadTimeline(agent);
      expect(ui.state.timeline.ready).toBe(false);
      expect(ui.showUncertainSend).toHaveBeenCalledExactlyOnceWith(agent.agentId, 'check delivery');
      expect(ui.messages.querySelectorAll('.error')).toHaveLength(1);
      expect(ui.messages.querySelector('.error')!.querySelector('.msg-content')!.textContent).toBe(
        'check delivery'
      );

      ui.showUncertainSend.mockClear();
      ui.detail({
        type: 'focus_state',
        page: {items: [user], total: 1, start: 0, hasMore: false},
        live: null
      });
      expect(ui.showUncertainSend).toHaveBeenCalledExactlyOnceWith(agent.agentId, 'check delivery');
      expect(ui.messages.querySelectorAll('.error')).toHaveLength(1); // Snapshot replaces, not duplicates.
      expect(ui.requestAgent).not.toHaveBeenCalled();
      expect(ui.sendFocused).not.toHaveBeenCalled();
      expect(ui.state.uncertainSends.get(agent.agentId)).toEqual(['check delivery']);
    }
  );

  it('takes a new snapshot when the branch changes', () => {
    const ui = setup();
    ui.open([user]);
    ui.sendFocus.mockClear();
    ui.detail({type: 'timeline_reset'});
    expect(ui.sendFocus).toHaveBeenCalledWith(true);
    // Until the new snapshot, appended items are already in it.
    ui.detail({type: 'items', items: [{id: 'e9', kind: 'user', size: 1, body: 'x'}]});
    expect(ui.ids()).toEqual(['e1']);
  });

  it('pages back through older items', async () => {
    const ui = setup([
      {sessionId: 's1', items: [{...user, id: 'e0', body: 'first'}], total: 2, start: 0, hasMore: false}
    ]);
    ui.open([user], {page: {items: [user], total: 2, start: 1, hasMore: true}});
    const button = ui.messages.querySelector('#loadOlderMessages')!;
    expect(button.textContent).toBe('加载更早的对话（还有 1 项）');
    await (button as any).onclick();
    await vi.waitFor(() => expect(ui.ids()).toEqual(['e0', 'e1']));
    expect(ui.requestAgent).toHaveBeenLastCalledWith('bk:agent-a', '/timeline?limit=50&before=e1');
  });
});

describe('following the newest output', () => {
  /** A transcript taller than its view, opened at its end. */
  const opened = () => {
    const ui = setup();
    ui.messages.clientHeight = 400;
    ui.messages.scrollHeight = 1000;
    ui.open([user]);
    ui.onMessagesScroll();
    // The reader scrolls; the browser then reports it.
    const scrollTo = (top: number) => {
      ui.messages.scrollTop = top;
      ui.onMessagesScroll();
    };
    const grow = (height = 300) => (ui.messages.scrollHeight += height);
    const streamed = async (delta: string) => {
      grow();
      ui.detail({type: 'delta', kind: 'text', delta});
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    return {...ui, scrollTo, grow, streamed};
  };

  it('keeps to the end while streaming and shows no jump button', async () => {
    const ui = opened();
    expect(ui.messages.scrollTop).toBe(600);
    await ui.streamed('Hel');
    expect(ui.messages.scrollTop).toBe(900);
    expect(ui.jump.hidden).toBe(true);
  });

  it('stops following as soon as the reader scrolls up, even a little, and marks new output', async () => {
    const ui = opened();
    ui.scrollTo(590); // Within the slack, but moving up.
    expect(ui.state.followOutput).toBe(false);
    expect(ui.jump.hidden).toBe(false);
    expect(ui.jump.textContent).toBe('↓ 最新');
    await ui.streamed('Hel');
    ui.grow();
    ui.detail({type: 'items', items: [{id: 'e4', kind: 'user', size: 1, body: 'x'}]});
    ui.addCard('note', 'n');
    expect(ui.messages.scrollTop).toBe(590);
    expect(ui.jump.textContent).toBe('↓ 有新输出');
    expect(ui.jump.classList.contains('has-new')).toBe(true);
  });

  it('follows again when the reader scrolls back near the end', async () => {
    const ui = opened();
    ui.scrollTo(200);
    await ui.streamed('Hel'); // The end is now at 900.
    ui.scrollTo(870);
    expect(ui.state.followOutput).toBe(true);
    expect(ui.jump.hidden).toBe(true);
    expect(ui.jump.classList.contains('has-new')).toBe(false);
    await ui.streamed('lo');
    expect(ui.messages.scrollTop).toBe(1200);
  });

  it('jumps to the end and follows again from the button', async () => {
    const ui = opened();
    ui.scrollTo(100);
    await ui.streamed('Hel');
    ui.followLatest(true);
    expect(ui.messages.scrollTop).toBe(900);
    expect(ui.jump.hidden).toBe(true);
    await ui.streamed('lo');
    expect(ui.messages.scrollTop).toBe(1200);
  });

  it('keeps a scrolled-up reader in place through a new snapshot, but not through a switch', () => {
    const ui = opened();
    ui.scrollTo(100);
    ui.detail({type: 'timeline_reset'});
    ui.detail({type: 'focus_state', page: {items: [user], total: 1, start: 0, hasMore: false}, live: null});
    expect(ui.messages.scrollTop).toBe(100);
    expect(ui.jump.classList.contains('has-new')).toBe(false);
    ui.loadTimeline(ui.state.agent);
    expect(ui.state.followOutput).toBe(true);
    expect(ui.messages.scrollTop).toBe(600);
  });
});
