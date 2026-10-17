import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
// Exercise the real transcript renderer and tool-card plumbing without booting the rest of the UI.
const renderSource = source.slice(source.indexOf('  function textContent('), source.indexOf('  function updateMessageHistoryControl('));

class Element {
  className = ''; textContent = ''; innerHTML = ''; open = false; scrollTop = 0; scrollHeight = 0;
  children:Element[] = [];
  classList = {
    toggle:(name:string, on?:boolean) => { const has = this.className.split(' ').includes(name); if (on ?? !has) { if (!has) this.className = `${this.className} ${name}`.trim(); } else this.className = this.className.split(' ').filter(x => x !== name).join(' '); },
    contains:(name:string) => this.className.split(' ').includes(name),
  };
  parent:Element|null = null;
  append(...children:Element[]) { for (const child of children) child.parent = this; this.children.push(...children); }
  /** Minimal ChildNode.before(): used to put the tool duration in front of the timestamp. */
  before(...nodes:Element[]) { const parent = this.parent; if (!parent) return; const at = parent.children.indexOf(this); for (const node of nodes) node.parent = parent; parent.children.splice(at < 0 ? parent.children.length : at, 0, ...nodes); }
  get lastElementChild() { return this.children[this.children.length - 1]; }
  get childElementCount() { return this.children.length; }
  descendants():Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector:string) { return this.descendants().filter(child => child.className.split(' ').includes(selector.slice(1))); }
  querySelector(selector:string) { return this.querySelectorAll(selector)[0]; }
}

function setup() {
  const messages = new Element();
  const state = {toolCards:new Map()};
  const context:Record<string, unknown> = {
    state, $:() => messages, window:{}, localStorage:{},
    document:{createElement:() => new Element()},
  };
  const {renderMessages, upsertToolCard} = runInNewContext(`${renderSource}\n({renderMessages, upsertToolCard})`, context, {filename:'web/app.js'});
  return {messages, state, renderMessages, upsertToolCard};
}

const call = {type:'toolCall', id:'toolu_1', name:'bash', arguments:{command:'python archive.py'}};
const assistant = {role:'assistant', timestamp:1, content:[{type:'thinking', thinking:'downloading'}, call]};
const result = {role:'toolResult', timestamp:2, toolCallId:'toolu_1', toolName:'bash', content:[{type:'text', text:'1671 files'}]};

function toolCards(messages:Element) { return messages.querySelectorAll('.activity-items').flatMap(group => group.children); }

describe('in-flight tool calls in the transcript', () => {
  it('shows a running card for a tool call that has no result yet', () => {
    const ui = setup();
    ui.renderMessages([assistant], ui.messages, true, true);
    const [card] = toolCards(ui.messages);
    expect(card.querySelector('.summary-text')!.textContent).toBe('⏳ bash · 执行中');
    expect(card.querySelector('.msg-content')!.textContent).toContain('python archive.py');
    expect(ui.messages.querySelector('.activity-group')!.querySelector('.summary-text')!.textContent).toBe('⏳ bash · 执行中');
  });

  it('lets the later live event finish that same card instead of duplicating it', () => {
    const ui = setup();
    ui.renderMessages([assistant], ui.messages, true, true);
    ui.upsertToolCard({type:'tool_execution_end', toolCallId:'toolu_1', toolName:'bash', result:{content:[{type:'text', text:'1671 files'}]}}, 3);
    const cards = toolCards(ui.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.summary-text')!.textContent).toBe('✓ bash');
    expect(cards[0].querySelector('.msg-content')!.textContent).toContain('1671 files');
    expect(ui.state.toolCards.size).toBe(0);
  });

  it('reuses the restored card when the start event is replayed after rendering', () => {
    const ui = setup();
    ui.renderMessages([assistant], ui.messages, true, true);
    ui.upsertToolCard({type:'tool_execution_start', toolCallId:'toolu_1', toolName:'bash', args:call.arguments}, 2);
    ui.upsertToolCard({type:'tool_execution_end', toolCallId:'toolu_1', toolName:'bash', result:{content:[{type:'text', text:'1671 files'}]}}, 3);
    const cards = toolCards(ui.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.summary-text')!.textContent).toBe('✓ bash');
    expect(ui.state.toolCards.size).toBe(0);
  });

  it('keeps completed calls represented only by their result card', () => {
    const ui = setup();
    ui.renderMessages([assistant, result], ui.messages, true, true);
    const cards = toolCards(ui.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.summary-text')!.textContent).toBe('✓ bash');
    expect(ui.state.toolCards.size).toBe(0);
  });

  it('shows the recorded execution time of a finished call', () => {
    const ui = setup();
    ui.upsertToolCard({type:'tool_execution_start', toolCallId:'toolu_1', toolName:'bash', args:call.arguments}, 1);
    ui.upsertToolCard({type:'tool_execution_end', toolCallId:'toolu_1', toolName:'bash', result:{content:[]}, durationMs:12_400}, 2);
    expect(toolCards(ui.messages)[0].querySelector('.tool-duration')!.textContent).toBe('12.4 s');
  });

  it('nests calls a tool made itself inside their caller', () => {
    const ui = setup();
    ui.upsertToolCard({type:'tool_execution_start', toolCallId:'call_parent', toolName:'codemode', args:{}}, 1);
    ui.upsertToolCard({type:'tool_execution_start', toolCallId:'call_child', toolName:'read', args:{path:'a.ts'}, parentToolCallId:'call_parent'}, 2);
    ui.upsertToolCard({type:'tool_execution_end', toolCallId:'call_child', toolName:'read', result:{content:[{type:'text', text:'file body'}]}, parentToolCallId:'call_parent'}, 3);
    // The caller's own output and result replace its body, which must not take the nested calls with it.
    ui.upsertToolCard({type:'tool_execution_update', toolCallId:'call_parent', toolName:'codemode', partialResult:{content:[{type:'text', text:'running'}]}}, 4);
    ui.upsertToolCard({type:'tool_execution_end', toolCallId:'call_parent', toolName:'codemode', result:{content:[{type:'text', text:'done'}]}}, 5);
    const cards = toolCards(ui.messages);
    expect(cards).toHaveLength(1); // The nested call does not become its own activity entry.
    const nested = cards[0].querySelector('.nested-tools')!.children;
    expect(nested).toHaveLength(1);
    expect(nested[0].querySelector('.summary-text')!.textContent).toBe('✓ read');
    expect(nested[0].querySelector('.msg-content')!.textContent).toContain('file body');
  });

  it('does not claim a tool is running when an older page just ends mid call', () => {
    const ui = setup();
    ui.renderMessages([assistant], ui.messages, false, false);
    expect(toolCards(ui.messages)).toHaveLength(0);
    expect(ui.state.toolCards.size).toBe(0);
  });
});
