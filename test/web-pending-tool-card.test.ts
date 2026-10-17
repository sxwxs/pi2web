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
  append(...children:Element[]) { this.children.push(...children); }
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

  it('keeps completed calls represented only by their result card', () => {
    const ui = setup();
    ui.renderMessages([assistant, result], ui.messages, true, true);
    const cards = toolCards(ui.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.summary-text')!.textContent).toBe('✓ bash');
    expect(ui.state.toolCards.size).toBe(0);
  });

  it('does not claim a tool is running when an older page just ends mid call', () => {
    const ui = setup();
    ui.renderMessages([assistant], ui.messages, false, false);
    expect(toolCards(ui.messages)).toHaveLength(0);
    expect(ui.state.toolCards.size).toBe(0);
  });
});
