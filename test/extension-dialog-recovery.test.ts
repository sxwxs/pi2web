import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
// Exercise the real event handler and dialog renderer without booting unrelated UI.
const dialogSource = source.slice(source.indexOf('  function extensionRequest('), source.indexOf('  function stopVoiceAudio('));
const handlerSource = source.slice(source.indexOf('  function handleAgentEvent('), source.indexOf('  function renderExtensionStatus('));
const keyboardSource = source.slice(source.indexOf('  const sessionKeyboard ='), source.indexOf('  const formatTokens ='));

class Element {
  id = ''; className = ''; textContent = ''; value = ''; placeholder = '';
  scrollTop = 0; scrollHeight = 0;
  children:Element[] = [];
  onclick?:() => Promise<void>;
  append(...children:Element[]) { this.children.push(...children); }
  replaceChildren(...children:Element[]) { this.children = children; }
  descendants():Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector:string) { return this.descendants().filter(child => child.className === selector.slice(1)); }
  querySelector(selector:string) { return this.querySelectorAll(selector)[0]; }
}

function setup() {
  const messages = new Element(); messages.id = 'messages';
  const $ = (id:string) => [messages, ...messages.descendants()].find(element => element.id === id);
  const agent = {agentId:'agent-a', status:'idle'};
  const state = {agent, agents:[agent], selectedKind:'agent'};
  const post = vi.fn(async () => {});
  const addCard = vi.fn(() => { const body = new Element(); messages.append(body); return {body}; });
  const renderMessages = vi.fn(() => messages.append(new Element()));
  const sessionKeyboard = {updateAgent:vi.fn(), setAgentSnapshot:vi.fn(), handleAgentEvent:vi.fn()};
  const setAgentStatus = vi.fn(), selectAgent = vi.fn(async () => {}), navigateMobile = vi.fn();
  const {handleAgentEvent, onKey} = runInNewContext(`${keyboardSource}\n${dialogSource}\n${handlerSource}\n({handleAgentEvent, onKey:sessionKeyboard.onKey})`, {
    state, $, localStorage:{}, post, addCard, renderMessages, toast:vi.fn(),
    document:{createElement:() => new Element(), createTextNode:(text:string) => Object.assign(new Element(), {textContent:text})},
    window:{SessionKeyboardController:function(options:unknown) { return Object.assign(sessionKeyboard, options); }},
    updateKeyboardUi:vi.fn(), renderAgentList:vi.fn(), renderKeyboardBindings:vi.fn(), selectAgent, navigateMobile,
    setAgentStatus, discardStreams:vi.fn(), updateMessageHistoryControl:vi.fn(),
  }, {filename:'web/app.js'});
  return {handleAgentEvent, $, messages, post, addCard, renderMessages, state, onKey, setAgentStatus, selectAgent, navigateMobile};
}

const request = {type:'extension_ui_request', requestId:'dialog-1', kind:'select', title:'Choose an action', options:['Keep', 'Replace']};
function baseline(type:string, requests:typeof request[] = [request], sequence = 1, agentId = 'agent-a') {
  return {type, agentId, sequence, lastSequence:sequence, messages:[], state:{agentId, status:'idle', activity:{
    bashIds:[], dialogIds:requests.map(request => request.requestId), dialogRequests:requests,
  }}};
}

describe('extension dialog recovery', () => {
  it.each(['agent_state', 'agent_snapshot'])('rebuilds answerable controls from %s without the original event', async type => {
    const ui = setup();
    ui.handleAgentEvent(baseline(type));
    const controls = ui.$('extension-request-dialog-1');
    expect(controls).toBeDefined();
    expect(ui.addCard).toHaveBeenCalledWith(request.title, '', 'dialog', true, undefined);
    expect(controls!.children.map(button => button.textContent)).toEqual(request.options);
    await controls!.children[1].onclick!();
    expect(ui.post).toHaveBeenCalledWith('/api/v1/agents/agent-a/extension-response', {requestId:request.requestId, value:'Replace'});
    expect(controls!.children[0].textContent).toBe('已响应');
  });

  it('deduplicates replay and state recovery without losing a draft, and closes requests absent from the baseline', () => {
    const ui = setup(), inputRequest = {...request, kind:'input', placeholder:'Your answer'};
    ui.handleAgentEvent({type:'agent_event', agentId:'agent-a', sequence:1, event:inputRequest});
    const controls = ui.$('extension-request-dialog-1')!;
    controls.children[0].value = 'unfinished answer';
    ui.handleAgentEvent(baseline('agent_state', [inputRequest]));
    ui.handleAgentEvent(baseline('agent_state', [inputRequest], 2));
    expect(ui.$('extension-request-dialog-1')).toBe(controls);
    expect(controls.children[0].value).toBe('unfinished answer');
    expect(ui.addCard).toHaveBeenCalledOnce();
    expect(ui.renderMessages).not.toHaveBeenCalled();
    ui.handleAgentEvent(baseline('agent_state', [], 3));
    expect(controls.children).toHaveLength(1);
    expect(controls.children[0].textContent).toBe('已结束');
    expect(ui.post).not.toHaveBeenCalled();
  });

  it('replaces obsolete dialogs on a replay gap and handles subsequent completion normally', () => {
    const ui = setup();
    ui.handleAgentEvent({type:'agent_event', agentId:'agent-a', sequence:1, event:{...request, requestId:'old'}});
    ui.handleAgentEvent(baseline('agent_snapshot', [request], 2));
    expect(ui.$('extension-request-old')).toBeUndefined();
    expect(ui.$('extension-request-dialog-1')).toBeDefined();
    ui.handleAgentEvent({type:'agent_event', agentId:'agent-a', sequence:3, event:{type:'extension_ui_response', requestId:'dialog-1'}});
    expect(ui.$('extension-request-dialog-1')!.children[0].textContent).toBe('已结束');
  });

  it('applies an unload event to status/lights and closes dialogs without replacing the transcript', () => {
    const ui = setup();
    ui.handleAgentEvent(baseline('agent_state'));
    const controls = ui.$('extension-request-dialog-1')!;
    ui.handleAgentEvent({type:'agent_event', agentId:'agent-a', sequence:2, event:{type:'agent_unloaded'}});
    expect(ui.setAgentStatus).toHaveBeenLastCalledWith('agent-a', 'unloaded');
    expect(ui.$('extension-request-dialog-1')).toBe(controls);
    expect(controls.children[0].textContent).toBe('已结束');
    expect(ui.addCard).toHaveBeenCalledOnce();
    expect(ui.renderMessages).not.toHaveBeenCalled();
  });

  it('pressing the already selected Session key preserves a dialog draft without reloading', () => {
    const ui = setup();
    ui.handleAgentEvent(baseline('agent_state', [{...request, kind:'input'}]));
    const controls = ui.$('extension-request-dialog-1')!;
    controls.children[0].value = 'unfinished answer';
    ui.onKey({agentId:'agent-a', slot:0});
    expect(ui.selectAgent).not.toHaveBeenCalled();
    expect(controls.children[0].value).toBe('unfinished answer');
    expect(ui.navigateMobile).toHaveBeenCalledWith('agent');
  });

  it('still switches back from a Terminal even if the last selected Agent matches the key', () => {
    const ui = setup();
    ui.state.selectedKind = 'terminal';
    ui.onKey({agentId:'agent-a', slot:0});
    expect(ui.selectAgent).toHaveBeenCalledExactlyOnceWith(ui.state.agent);
  });

  it('still switches to a different bound Session', () => {
    const ui = setup(), other = {agentId:'agent-b', status:'idle'};
    ui.state.agents.push(other);
    ui.onKey({agentId:'agent-b', slot:1});
    expect(ui.selectAgent).toHaveBeenCalledExactlyOnceWith(other);
  });

  it('does not render another agent’s dialogs or change existing controls for older servers', () => {
    const ui = setup();
    ui.handleAgentEvent(baseline('agent_state', [request], 1, 'agent-b'));
    expect(ui.addCard).not.toHaveBeenCalled();
    ui.handleAgentEvent({type:'agent_event', agentId:'agent-a', sequence:1, event:request});
    const controls = ui.$('extension-request-dialog-1')!;
    ui.handleAgentEvent({type:'agent_state', agentId:'agent-a', sequence:2, state:{agentId:'agent-a', status:'idle'}});
    expect(controls.children.map(button => button.textContent)).toEqual(request.options);
  });
});
