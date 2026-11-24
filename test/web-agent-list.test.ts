import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read = (file: string) => readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
const appSource = read('app.js');
const listSource = appSource.slice(
  appSource.indexOf('  let listCards = new Map();'),
  appSource.indexOf('  async function loadAgentContexts(')
);

/** Just enough DOM for the list and its activity line; counts every element created and every move. */
const dom = {created: 0, moves: 0};
const matchOne = (el: Element, selector: string) =>
  selector.startsWith('.')
    ? el.className.split(' ').includes(selector.slice(1))
    : selector === '[data-since]'
      ? 'since' in el.dataset
      : el.tagName === selector.toUpperCase();
class Element {
  className = '';
  hidden = false;
  title = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parent: Element | null = null;
  text = '';
  props: Record<string, string> = {};
  style = {
    width: '',
    getPropertyValue: (name: string) => this.props[name] ?? '',
    setProperty: (name: string, value: string) => (this.props[name] = value)
  };
  onclick?: () => unknown;
  oncontextmenu?: () => unknown;
  constructor(public tagName = 'DIV') {
    dom.created++;
  }
  get textContent(): string {
    return this.text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }
  set innerHTML(html: string) {
    this.children = [];
    const stack: Element[] = [this];
    for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
      if (text) stack.at(-1)!.text += text.replace('&gt;', '>');
      else if (close) stack.pop();
      else {
        const el = new Element(tag.toUpperCase());
        el.className = /class="([^"]*)"/.exec(attrs)?.[1] ?? '';
        el.hidden = /\bhidden\b/.test(attrs);
        stack.at(-1)!.append(el);
        stack.push(el);
      }
    }
  }
  classList = {
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
    toggle: (name: string, on: boolean) => {
      const names = this.className.split(' ').filter(n => n && n !== name);
      this.className = (on ? [...names, name] : names).join(' ');
    },
    contains: (name: string) => this.className.split(' ').includes(name)
  };
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  append(...nodes: Element[]) {
    for (const node of nodes) this.insertBefore(node, null, false);
  }
  insertBefore(node: Element, before: Element | null, move = true) {
    if (move) dom.moves++;
    node.remove();
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    node.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(selector: string): Element[] {
    const parts = selector.split(' ');
    return this.children
      .flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(el => {
        if (selector === '*') return true;
        if (!matchOne(el, parts.at(-1)!)) return false;
        let parent = el.parent;
        for (const part of parts.slice(0, -1).reverse()) {
          while (parent && !matchOne(parent, part)) parent = parent.parent;
          if (!parent) return false;
          parent = parent.parent;
        }
        return true;
      });
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
const document = {createElement: (tag: string) => new Element(tag.toUpperCase())};
const window: any = {};
runInNewContext(read('activity-view.js'), {window, document});

function setup() {
  const agent = (id: string, at: number) => ({
    agentId: id,
    backendId: 'bk',
    status: 'idle',
    cwd: `/w/${id}`,
    sessionName: `Agent ${id}`,
    lastActiveAt: new Date(at).toISOString()
  });
  const elements: Record<string, Element> = {
    agents: new Element(),
    agentListCount: new Element(),
    loadMoreAgents: new Element(),
    clearSessionFilter: new Element()
  };
  const state: any = {
    agents: [agent('a', 3000), agent('b', 2000), agent('c', 1000)],
    terminals: [],
    backendFilter: '',
    sessionFilter: '',
    agentVisibleCount: 10,
    contexts: new Map(),
    advice: new Map(),
    activities: new Map(),
    selectedKind: 'agent',
    agent: null,
    terminal: null
  };
  const bindings = new Map<string, {slot: number; color: string}>();
  const selectAgent = vi.fn();
  const highlight = {key: ''};
  const api = runInNewContext(`${listSource}\n({renderAgentList, renderListItem, sessionEntries})`, {
    state,
    shortcuts: {isCursor: (key: string) => key === highlight.key},
    $: (id: string) => elements[id],
    document,
    connectedBackends: () => [{}],
    sessionKeyboard: {getBinding: (id: string) => bindings.get(id) ?? null},
    adviceSummary: () => ['💬', 'reply'],
    templateModeText: () => '',
    agentLabel: (item: any) => item.sessionName,
    agentSubtitle: (item: any) => item.cwd,
    usageLevel: (usage: any) => (usage?.percent > 90 ? 'usage-danger' : ''),
    usageText: (usage: any) => `${usage?.percent ?? '?'}%`,
    costText: () => 'cost',
    activityView: window.ActivityView.createActivityView(() => 20_000),
    enableLongPressMenu: vi.fn(),
    showItemContextMenu: vi.fn(),
    selectAgent,
    selectTerminal: vi.fn()
  });
  const list = elements.agents,
    card = (id: string) => list.children.find(el => el.dataset.itemId === id)!,
    ids = () => list.children.map(el => el.dataset.itemId);
  const settled = () => {
    const before = {...dom};
    return () => ({created: dom.created - before.created, moves: dom.moves - before.moves});
  };
  return {api, state, elements, list, card, ids, bindings, selectAgent, settled, highlight};
}

describe('Agent list cards', () => {
  it('builds a card once; any later change only sets text, classes and visibility', () => {
    const h = setup();
    h.api.renderAgentList();
    const a = h.card('a'),
      elements = a.querySelectorAll('*'),
      changes = h.settled();

    h.state.agents[0].status = 'streaming';
    h.state.agents[0].sessionName = 'Renamed';
    h.state.contexts.set('a', {percent: 95});
    h.state.advice.set('a', {state: 'ready', outcome: 'needs_reply'});
    h.bindings.set('a', {slot: 2, color: '#FF0000'});
    h.api.renderAgentList();
    h.state.activities.set('a', {
      run: {startedAt: 1},
      phase: {kind: 'generating', since: 10_000},
      metrics: {turnStartedAt: 9_000, streamStartedAt: 10_000, estimatedTokens: 50, chars: 200}
    });
    h.api.renderListItem('agent', 'a');
    const line = a.querySelector('.agent-activity')!;
    expect(line.hidden).toBe(false);
    expect(line.querySelector('.activity-speed')!.hidden).toBe(false);
    h.state.activities.set('a', {
      run: {startedAt: 1},
      phase: {
        kind: 'running_tools',
        since: 12_000,
        tools: [
          {toolName: 'bash', summary: 'npm test', since: 12_000},
          {toolName: 'read', since: 13_000}
        ]
      }
    });
    h.api.renderListItem('agent', 'a');

    expect(changes()).toEqual({created: 0, moves: 0});
    expect(a.querySelectorAll('*')).toEqual(elements);
    expect(a.className.split(' ')).toEqual(['agent', 'streaming']);
    expect(a.querySelector('b')!.textContent).toBe('Renamed');
    expect(a.querySelector('.state-badge')!.textContent).toBe('streaming');
    expect(a.querySelector('.agent-context')!.className).toBe('agent-context usage-danger');
    expect(a.querySelector('.advice-mark')!.hidden).toBe(false);
    expect(a.querySelector('.key-binding')!.textContent).toBe('K3');
    expect(line.querySelector('.activity-text')!.textContent).toBe('🔧 bash: npm test');
    expect(line.querySelector('.activity-speed')!.hidden).toBe(true);
    expect(line.textContent).toContain('+1');

    h.state.activities.delete('a');
    h.api.renderListItem('agent', 'a');
    expect(line.hidden).toBe(true);
    // A hidden line no longer ticks.
    expect(line.querySelectorAll('[data-since]')).toEqual([]);
    expect(changes()).toEqual({created: 0, moves: 0});
  });

  it('reorders by moving only the cards that are out of place', () => {
    const h = setup();
    h.api.renderAgentList();
    const [a, b, c] = h.list.children,
      changes = h.settled();
    h.api.renderAgentList();
    expect(changes()).toEqual({created: 0, moves: 0});

    h.state.agents[2].lastActiveAt = new Date(4000).toISOString();
    // A change to one item never reorders the list.
    h.api.renderListItem('agent', 'c');
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    h.api.renderAgentList();
    expect(h.list.children).toEqual([c, a, b]);
    expect(changes()).toEqual({created: 0, moves: 1});
  });

  it('keeps cards while filtering or paging hides them, and drops them with their item', () => {
    const h = setup();
    h.api.renderAgentList();
    const c = h.card('c'),
      changes = h.settled();
    h.state.agentVisibleCount = 2;
    h.api.renderAgentList();
    expect(h.ids()).toEqual(['a', 'b']);
    h.state.agentVisibleCount = 10;
    h.api.renderAgentList();
    expect(h.card('c')).toBe(c);
    expect(changes().created).toBe(0);

    h.state.agents = h.state.agents.filter((agent: any) => agent.agentId !== 'c');
    h.api.renderAgentList();
    h.state.agents.push({agentId: 'c', backendId: 'bk', status: 'idle', cwd: '/w/c', sessionName: 'Agent c'});
    h.api.renderAgentList();
    expect(h.card('c')).not.toBe(c);
  });

  it('opens the current item after a refresh replaced the item objects', () => {
    const h = setup();
    h.api.renderAgentList();
    const el = h.card('a');
    h.state.agents = h.state.agents.map((agent: any) => ({...agent}));
    h.api.renderAgentList();
    expect(h.card('a')).toBe(el);
    el.onclick!();
    expect(h.selectAgent).toHaveBeenCalledWith(h.state.agents[0]);
    h.state.agent = h.state.agents[0];
    h.api.renderAgentList();
    expect(el.className.split(' ')).toContain('selected');
  });
  it('lists sessions for the shortcuts in display order, before paging, and marks the highlighted card', () => {
    const h = setup();
    h.state.agentVisibleCount = 2;
    h.state.terminals = [
      {
        terminalId: 't',
        backendId: 'other',
        status: 'running',
        cwd: '/w',
        lastActiveAt: new Date(2500).toISOString()
      }
    ];
    expect(h.api.sessionEntries().map((entry: any) => entry.item.agentId ?? entry.item.terminalId)).toEqual([
      'a',
      't',
      'b',
      'c'
    ]);
    h.state.backendFilter = 'bk';
    expect(h.api.sessionEntries().map((entry: any) => entry.item.agentId)).toEqual(['a', 'b', 'c']);
    h.api.renderAgentList();
    const b = h.card('b'),
      changes = h.settled();
    h.highlight.key = 'agent:b';
    h.api.renderListItem('agent', 'b');
    expect(b.className.split(' ')).toContain('cursor');
    h.highlight.key = '';
    h.api.renderListItem('agent', 'b');
    expect(b.className.split(' ')).not.toContain('cursor');
    expect(changes()).toEqual({created: 0, moves: 0});
  });

  it('filters all loaded sessions by title and path before paging, reusing cards and showing counts', () => {
    const h = setup();
    h.state.agentVisibleCount = 1;
    h.state.agents[2].cwd = 'C:\\src\\pi2web\\voice';
    h.state.agents[2].sessionName = 'Voice Debug';
    h.state.terminals = [
      {
        terminalId: 't1',
        backendId: 'bk',
        status: 'running',
        title: 'Build Shell',
        cwd: '/srv/pi2web/tools',
        lastActiveAt: new Date(500).toISOString()
      }
    ];
    h.api.renderAgentList();
    expect(h.ids()).toEqual(['a']);
    expect(h.elements.clearSessionFilter.hidden).toBe(true);

    // Matches past the first page, case-insensitive, slash-normalized, and multi-token across title + path.
    h.state.sessionFilter = 'src/pi2web debug';
    h.api.renderAgentList();
    expect(h.ids()).toEqual(['c']);
    expect(h.elements.agentListCount.textContent).toBe('匹配 1 / 1（共 4）');
    expect(h.elements.clearSessionFilter.hidden).toBe(false);
    expect(h.api.sessionEntries({applyFilter: false})).toHaveLength(4);

    // Matches terminals by title or path too, and reuses existing cards when the filter clears.
    const cCard = h.card('c');
    h.state.sessionFilter = 'shell tools';
    h.api.renderAgentList();
    expect(h.ids()).toEqual(['t1']);

    // Empty match shows a placeholder without dropping cached cards.
    h.state.sessionFilter = 'nonexistent';
    h.api.renderAgentList();
    expect(h.list.children).toHaveLength(1);
    expect(h.list.children[0].className).toBe('agent-empty');
    expect(h.elements.agentListCount.textContent).toBe('匹配 0 / 0（共 4）');

    h.state.sessionFilter = 'voice';
    const changes = h.settled();
    h.api.renderAgentList();
    expect(h.card('c')).toBe(cCard);
    expect(changes().created).toBe(0);
  });
});
