import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const composerSource = source.slice(
  source.indexOf('  function prependInput(text)'),
  source.indexOf("  $('input').onkeydown")
);
const socketSource = source.slice(
  source.indexOf('  function connectSocket(backend)'),
  source.indexOf('  function notificationUnavailableReason()')
);

function setup() {
  const input = {value: 'one message'},
    prompt: any = {},
    elements: any = {input, prompt, sendMode: {value: 'follow-up'}, messages: {querySelector: () => null}};
  const agent = {agentId: 'bk:agent-a', remoteId: 'agent-a', backendId: 'bk', status: 'idle'};
  const state: any = {
    selectedKind: 'agent',
    agent,
    agents: [agent],
    optimistic: [],
    failedSends: new Map(),
    uncertainSends: new Map()
  };
  const cards: any[] = [];
  const addCard = vi.fn((title, text, kind) => {
    const buttons: any[] = [];
    const card = {title, text, kind, buttons, details: {append: (button: any) => buttons.push(button)}};
    cards.push(card);
    return card;
  });
  const removeCard = vi.fn();
  let reject!: (error: Error) => void, resolve!: (value?: object) => void;
  const response = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const postAgent = vi.fn().mockReturnValue(response);
  const sockets: any[] = [];
  class Socket {
    sent: any[] = [];
    constructor() {
      sockets.push(this);
    }
    send(message: string) {
      this.sent.push(JSON.parse(message));
    }
    close() {}
  }
  const backend = {id: 'bk', base: 'https://host', status: 'connected', token: 'token', ws: null};
  const loadTimeline = vi.fn(),
    toast = vi.fn();
  const api = runInNewContext(`${composerSource}\n${socketSource}\n({connectSocket})`, {
    state,
    $: (id: string) => elements[id],
    postAgent,
    addCard,
    removeCard,
    toast,
    closeCommandPicker: vi.fn(),
    followLatest: vi.fn(),
    agentLabel: () => 'Agent A',
    document: {createElement: () => ({})},
    WebSocket: Socket,
    clearTimeout,
    updateHeaderStatus: vi.fn(),
    loadTimeline,
    sendFocus: vi.fn(),
    handleAgentEvent: vi.fn()
  });
  return {
    state,
    input,
    cards,
    removeCard,
    postAgent,
    reject,
    resolve,
    sockets,
    backend,
    loadTimeline,
    toast,
    submit: () => prompt.onsubmit({preventDefault: vi.fn()}),
    ...api
  };
}

describe('prompt send acknowledgement', () => {
  it('clears the composer synchronously, so a double submit does not send twice', async () => {
    const ui = setup();
    const pending = ui.submit();
    expect(ui.input.value).toBe('');
    await ui.submit();
    expect(ui.postAgent).toHaveBeenCalledOnce();
    ui.resolve();
    await pending;
    expect(ui.state.uncertainSends.size).toBe(0);
  });

  it.each([
    new TypeError('Failed to fetch'),
    Object.assign(new Error('Aborted'), {name: 'AbortError'}),
    Object.assign(new Error('Request timeout'), {status: 408}),
    Object.assign(new Error('Gateway timeout'), {status: 504})
  ])('does not restore or resend a message when delivery is unknown (%s)', async error => {
    const ui = setup();
    const pending = ui.submit();
    ui.state.agent.status = 'streaming'; // The server received the prompt before the response was lost.
    ui.reject(error);
    await pending;
    expect(ui.input.value).toBe('');
    expect(ui.state.failedSends.size).toBe(0);
    expect(ui.state.uncertainSends.get('bk:agent-a')).toEqual(['one message']);
    expect(ui.cards.at(-1)).toMatchObject({
      title: '送达状态未知',
      text: expect.stringContaining('one message')
    });
    // Returning to the foreground reconnects and reloads state; it must not submit the old text.
    ui.connectSocket(ui.backend);
    ui.sockets[0].onopen();
    expect(ui.sockets[0].sent).toEqual([{type: 'subscribe_all'}, {type: 'subscribe_drafts'}]);
    // A reconnect keeps the reader's scroll position.
    expect(ui.loadTimeline).toHaveBeenCalledExactlyOnceWith(ui.state.agent, false);
    await ui.submit();
    expect(ui.postAgent).toHaveBeenCalledOnce();
  });

  it('leaves a newly typed draft untouched when an older acknowledgement is lost', async () => {
    const ui = setup();
    const pending = ui.submit();
    ui.input.value = 'new draft';
    ui.reject(new TypeError('Failed to fetch'));
    await pending;
    expect(ui.input.value).toBe('new draft');
    expect(ui.state.uncertainSends.get('bk:agent-a')).toEqual(['one message']);
  });

  it('keeps uncertain text with its original Agent when the selection changes', async () => {
    const ui = setup();
    const pending = ui.submit();
    ui.state.agent = {agentId: 'bk:agent-b'};
    ui.input.value = 'other draft';
    ui.reject(new TypeError('Failed to fetch'));
    await pending;
    expect(ui.input.value).toBe('other draft');
    expect(ui.state.failedSends.size).toBe(0);
    expect(ui.state.uncertainSends.get('bk:agent-a')).toEqual(['one message']);
    expect(ui.cards.some(card => card.title === '送达状态未知')).toBe(false);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('送达状态未知'));
  });

  it('lets the user dismiss a reviewed notice without putting its text back in the composer', async () => {
    const ui = setup();
    const pending = ui.submit();
    ui.reject(new TypeError('Failed to fetch'));
    await pending;
    const notice = ui.cards.at(-1);
    notice.buttons[0].onclick();
    expect(ui.state.uncertainSends.size).toBe(0);
    expect(ui.input.value).toBe('');
    expect(ui.removeCard).toHaveBeenCalledExactlyOnceWith(notice);
    expect(ui.postAgent).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 429])('restores a message explicitly rejected with HTTP %i', async status => {
    const ui = setup();
    const pending = ui.submit();
    ui.reject(Object.assign(new Error('Rejected'), {status}));
    await pending;
    expect(ui.input.value).toBe('one message');
    expect(ui.state.uncertainSends.size).toBe(0);
    expect(ui.cards.at(-1)).toMatchObject({title: '发送失败', text: 'Rejected'});
  });

  it('keeps explicitly rejected text with the original Agent, not a different composer', async () => {
    const ui = setup();
    const pending = ui.submit();
    ui.state.agent = {agentId: 'bk:agent-b'};
    ui.input.value = 'other draft';
    ui.reject(Object.assign(new Error('Rejected'), {status: 400}));
    await pending;
    expect(ui.input.value).toBe('other draft');
    expect(ui.state.failedSends.get('bk:agent-a')).toBe('one message');
    expect(ui.state.uncertainSends.size).toBe(0);
  });
});
