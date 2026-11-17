import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const listSource = source.slice(
  source.indexOf('  let listCards = new Map();'),
  source.indexOf('  async function loadAgentContexts(')
);

/** Just enough DOM for the list: counts every content rewrite and every list rebuild. */
class Element {
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  html = '';
  writes = 0;
  rebuilds = 0;
  onclick?: () => unknown;
  oncontextmenu?: () => unknown;
  classList = {
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
    toggle: (name: string, on: boolean) => {
      const names = this.className.split(' ').filter(n => n && n !== name);
      this.className = (on ? [...names, name] : names).join(' ');
    }
  };
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.writes++;
    this.children = value.includes('class="agent-activity"')
      ? [Object.assign(new Element(), {className: 'agent-activity', hidden: true})]
      : [];
  }
  get childNodes() {
    return this.children;
  }
  querySelector(selector: string) {
    return this.children.find(child => child.className === selector.slice(1));
  }
  replaceChildren(...children: Element[]) {
    this.rebuilds++;
    this.children = children;
  }
}

function setup() {
  const agent = (id: string, at: number) => ({
    agentId: id,
    backendId: 'bk',
    status: 'idle',
    cwd: `/w/${id}`,
    lastActiveAt: new Date(at).toISOString()
  });
  const elements: Record<string, Element> = {
    agents: new Element(),
    agentListCount: new Element(),
    loadMoreAgents: new Element()
  };
  const state: any = {
    agents: [agent('bk:a', 2000), agent('bk:b', 1000)],
    terminals: [],
    backendFilter: '',
    agentVisibleCount: 10,
    contexts: new Map(),
    advice: new Map(),
    activities: new Map(),
    selectedKind: 'agent',
    agent: null,
    terminal: null
  };
  const selectAgent = vi.fn();
  const api = runInNewContext(`${listSource}\n({renderAgentList, renderListItem})`, {
    state,
    $: (id: string) => elements[id],
    document: {createElement: () => new Element()},
    esc: (value: unknown) => String(value ?? ''),
    connectedBackends: () => [{}],
    sessionKeyboard: {getBinding: () => null},
    adviceSummary: () => ['?', 'advice'],
    templateModeText: () => '',
    agentLabel: (item: any) => item.cwd,
    agentSubtitle: (item: any) => item.agentId,
    usageLevel: () => '',
    usageText: () => 'Context ?',
    costText: () => 'cost ?',
    activityView: {
      line: (activity: any) =>
        activity
          ? Object.assign(new Element(), {children: [new Element()], textContent: activity.text})
          : null
    },
    enableLongPressMenu: vi.fn(),
    showItemContextMenu: vi.fn(),
    selectAgent,
    selectTerminal: vi.fn()
  });
  const list = elements.agents,
    card = (id: string) => list.children.find(el => el.dataset.itemId === id)!;
  return {api, state, list, card, selectAgent};
}

describe('Agent list cards', () => {
  it('keeps one card per item and rewrites nothing that did not change', () => {
    const {api, list, card} = setup();
    api.renderAgentList();
    const [a, b] = list.children;
    expect([a.dataset.itemId, b.dataset.itemId]).toEqual(['bk:a', 'bk:b']);
    api.renderAgentList();
    expect(list.children).toEqual([a, b]);
    expect(list.rebuilds).toBe(1);
    expect([card('bk:a').writes, card('bk:b').writes]).toEqual([1, 1]);
  });

  it('updates only the changed card, in place, for status and activity', () => {
    const {api, state, list, card} = setup();
    api.renderAgentList();
    const a = card('bk:a'),
      slot = a.querySelector('.agent-activity')!;
    state.activities.set('bk:a', {text: 'running bash'});
    api.renderListItem('agent', 'bk:a');
    // The activity has its own slot: the card around it is not rewritten.
    expect(a.writes).toBe(1);
    expect(slot.hidden).toBe(false);
    expect(slot.children).toHaveLength(1);
    state.agents[0].status = 'streaming';
    api.renderListItem('agent', 'bk:a');
    expect(a.className.split(' ')).toEqual(['agent', 'streaming']);
    expect(a.writes).toBe(2);
    expect(card('bk:b').writes).toBe(1);
    expect(list.rebuilds).toBe(1);
  });

  it('reorders by moving the same cards, and only when the whole list is rendered', () => {
    const {api, state, list} = setup();
    api.renderAgentList();
    const [a, b] = list.children;
    state.agents[1].lastActiveAt = new Date(3000).toISOString();
    api.renderListItem('agent', 'bk:b');
    expect(list.children).toEqual([a, b]);
    api.renderAgentList();
    expect(list.children).toEqual([b, a]);
    state.selectedKind = 'agent';
    state.agent = {agentId: 'bk:a'};
    api.renderAgentList();
    expect(a.className.split(' ')).toContain('selected');
    expect(b.className.split(' ')).not.toContain('selected');
  });

  it('opens the current item when an item object is replaced by a refresh', () => {
    const {api, state, card, selectAgent} = setup();
    api.renderAgentList();
    const el = card('bk:a');
    state.agents = state.agents.map((agent: any) => ({...agent}));
    api.renderAgentList();
    expect(card('bk:a')).toBe(el);
    el.onclick!();
    expect(selectAgent).toHaveBeenCalledWith(state.agents[0]);
  });
});
