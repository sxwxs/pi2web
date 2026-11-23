import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/shortcuts.js', import.meta.url), 'utf8');
const window: any = {};
runInNewContext(source, {window}, {filename: 'web/shortcuts.js'});
const {
  KEYMAP,
  keyName,
  compile,
  resolveKey,
  isTypingTarget,
  isNativeActivation,
  moveCursor,
  nextAttention,
  create
} = window.RemotePiShortcuts;

/** Just enough DOM for the shortcut layer: focus, [hidden] ancestors, dialogs and their choice lists. */
class FakeElement {
  id = '';
  hidden = false;
  disabled = false;
  open = false;
  value = '';
  textContent = '';
  className = '';
  isContentEditable = false;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  onclick?: () => void;
  clicks = 0;
  constructor(
    public tagName: string,
    private doc: FakeDocument
  ) {}
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (name: string) => (this.className = [...this.className.split(' ').filter(Boolean), name].join(' ')),
    remove: (name: string) =>
      (this.className = this.className
        .split(' ')
        .filter(n => n && n !== name)
        .join(' '))
  };
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  closest(selector: string) {
    if (selector !== '[hidden]') throw Error(selector);
    for (let el: FakeElement | null = this; el; el = el.parent) if (el.hidden) return el;
    return null;
  }
  contains(other: FakeElement | null) {
    for (let el = other; el; el = el.parent) if (el === this) return true;
    return false;
  }
  all(): FakeElement[] {
    return this.children.flatMap(child => [child, ...child.all()]);
  }
  querySelectorAll(selector: string) {
    return this.all().filter(el => el.classList.contains(selector.slice(1)));
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  click() {
    if (this.disabled) return;
    this.clicks++;
    this.onclick?.();
  }
  focus() {
    this.doc.activeElement = this;
  }
  blur() {
    if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {}
  scrollBy() {}
  setSelectionRange() {}
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  }
  dispatchEvent() {}
  requestSubmit = vi.fn();
}
class FakeDocument {
  body: FakeElement = new FakeElement('BODY', this);
  activeElement: FakeElement = this.body;
  handlers: Record<string, ((event: any) => void)[]> = {};
  createElement(tag: string) {
    return new FakeElement(tag.toUpperCase(), this);
  }
  getElementById(id: string) {
    return this.body.all().find(el => el.id === id) ?? null;
  }
  querySelector(selector: string) {
    if (selector !== 'dialog[open]') throw Error(selector);
    return this.body.all().find(el => el.tagName === 'DIALOG' && el.open) ?? null;
  }
  addEventListener(type: string, handler: (event: any) => void) {
    (this.handlers[type] ??= []).push(handler);
  }
  execCommand() {
    return true;
  }
}

function setup({storage = {} as Record<string, string>} = {}) {
  const doc = new FakeDocument(),
    add = (tag: string, id: string, parent = doc.body) => {
      const el = doc.createElement(tag);
      el.id = id;
      parent.append(el);
      return el;
    };
  const toolbar = add('div', 'agentToolbar');
  const buttons = Object.fromEntries(
    ['undo', 'safePause', 'controls', 'abort'].map(id => [id, add('button', id, toolbar)])
  );
  const form = add('form', 'prompt'),
    input = add('textarea', 'input', form),
    voiceInput = add('button', 'voiceInput', form),
    libraryToggle = add('button', 'libraryToggle', form);
  const terminalView = add('div', 'terminalView'),
    xterm = add('textarea', 'xterm', terminalView);
  terminalView.hidden = true;
  const messages = add('div', 'messages'),
    jumpToLatest = add('button', 'jumpToLatest'),
    openConfig = add('button', 'openConfig');
  const sessions = ['a', 'b', 'c', 'd'].map(id => ({
      key: `agent:${id}`,
      kind: 'agent',
      item: {agentId: id},
      attention: false
    })),
    selected = {key: 'agent:a' as string | null},
    visible = {count: 3};
  const host = {
    document: doc,
    window: {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      Event: class {
        constructor(public type: string) {}
      }
    },
    navigator: {clipboard: {writeText: vi.fn(async () => {})}},
    storage,
    now: vi.fn(() => 0),
    sessions: () => sessions,
    reveal: vi.fn((index: number) => {
      if (index >= visible.count) visible.count = index + 1;
    }),
    selectedKey: () => selected.key,
    open: vi.fn(),
    renderCursor: vi.fn(),
    scrollToCursor: vi.fn(),
    openSlot: vi.fn(),
    bind: vi.fn(),
    unbind: vi.fn(),
    toggleVoice: vi.fn(),
    latestOutput: vi.fn(async () => ({text: '最终答案', streaming: true})),
    focusTerminal: vi.fn(),
    toast: vi.fn()
  };
  const shortcuts = create(host);
  /** Dispatch a keydown the way the browser would reach the document; returns the event. */
  const press = (key: string, extra: Record<string, unknown> = {}) => {
    const event: any = {
      key,
      repeat: false,
      isComposing: false,
      keyCode: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra
    };
    for (const handler of doc.handlers.keydown) handler(event);
    return event;
  };
  const pointer = () => {
    for (const handler of doc.handlers.pointerdown) handler({});
  };
  const cursor = () => sessions.find(entry => shortcuts.isCursor(entry.key))?.key ?? null;
  return {
    doc,
    host,
    shortcuts,
    press,
    pointer,
    cursor,
    selected,
    sessions,
    input,
    xterm,
    terminalView,
    form,
    toolbar,
    buttons,
    voiceInput,
    libraryToggle,
    messages,
    jumpToLatest,
    openConfig,
    add,
    storage
  };
}

describe('keymap', () => {
  it('names keys the way the keymap writes them and leaves browser shortcuts alone', () => {
    expect(keyName({key: 'j'})).toBe('j');
    expect(keyName({key: 'G', shiftKey: true})).toBe('G');
    expect(keyName({key: ' '})).toBe('Space');
    expect(keyName({key: 'Enter', ctrlKey: true})).toBe('Ctrl+Enter');
    expect(keyName({key: 'Enter', metaKey: true})).toBe('Ctrl+Enter');
    expect(keyName({key: 'c', ctrlKey: true})).toBeNull();
    expect(keyName({key: 'r', metaKey: true})).toBeNull();
    expect(keyName({key: 'j', altKey: true})).toBeNull();
    expect(keyName({key: 'Shift', shiftKey: true})).toBeNull();
    expect(keyName({key: 'Process'})).toBeNull();
  });

  it('binds every key once', () => {
    const keys = KEYMAP.flatMap((entry: any) => entry.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves sequences, and a key that breaks one counts on its own', () => {
    const compiled = compile(KEYMAP);
    expect(resolveKey(compiled, '', 'g')).toEqual({pending: 'g'});
    expect(resolveKey(compiled, 'g', 'g').entry.action).toBe('top');
    expect(resolveKey(compiled, 'g', 'j').entry.action).toBe('down');
    expect(resolveKey(compiled, '', 'G').entry.action).toBe('bottom');
    expect(resolveKey(compiled, '', '3')).toMatchObject({key: '3', entry: {action: 'slot'}});
    expect(resolveKey(compiled, '', 'z')).toBeNull();
    expect(resolveKey(compiled, 'g', 'z')).toBeNull();
  });

  it('moves the cursor within the list and finds sessions waiting for the user, wrapping', () => {
    expect(moveCursor(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(moveCursor(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveCursor(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(moveCursor(['a', 'b', 'c'], null, -1)).toBe('a');
    expect(moveCursor([], 'a', 1)).toBeNull();
    const entries = ['a', 'b', 'c', 'd'].map(key => ({key, attention: key === 'a' || key === 'c'}));
    expect(nextAttention(entries, 'a', 1)).toBe(2);
    expect(nextAttention(entries, 'c', 1)).toBe(0);
    expect(nextAttention(entries, 'a', -1)).toBe(2);
    expect(nextAttention(entries, null, 1)).toBe(0);
    expect(nextAttention(entries, null, -1)).toBe(2);
    expect(
      nextAttention(
        entries.map(entry => ({...entry, attention: false})),
        'a',
        1
      )
    ).toBe(-1);
  });

  it('treats fields and the Terminal as typing, and keeps Space/Enter for buttons reached with Tab', () => {
    expect(isTypingTarget({tagName: 'TEXTAREA'})).toBe(true);
    expect(isTypingTarget({tagName: 'SELECT'})).toBe(true);
    expect(isTypingTarget({tagName: 'DIV', isContentEditable: true})).toBe(true);
    expect(isTypingTarget({tagName: 'BUTTON'})).toBe(false);
    const button = {tagName: 'BUTTON'};
    expect(isNativeActivation(button, 'Space', true)).toBe(true);
    expect(isNativeActivation(button, 'Enter', true)).toBe(true);
    expect(isNativeActivation(button, 'Space', false)).toBe(false);
    expect(isNativeActivation(button, 'j', true)).toBe(false);
    expect(isNativeActivation({tagName: 'DIV'}, 'Space', true)).toBe(false);
  });
});

describe('shortcuts on the page', () => {
  it('highlights with j/k from the open session, loads more at the end, and opens with Enter', () => {
    const h = setup();
    expect(h.press('j').defaultPrevented).toBe(true);
    expect(h.cursor()).toBe('agent:b');
    h.press('j');
    h.press('j');
    expect(h.cursor()).toBe('agent:d');
    expect(h.host.reveal).toHaveBeenLastCalledWith(3);
    h.press('k');
    expect(h.cursor()).toBe('agent:c');
    h.press('Enter');
    expect(h.host.open).toHaveBeenCalledWith(h.sessions[2]);
    // The app reports the selection; the highlight then rests on it, hidden.
    h.shortcuts.noteSelection('agent:c');
    expect(h.cursor()).toBeNull();
    h.press('Enter');
    expect(h.host.open).toHaveBeenCalledTimes(1);
  });

  it('jumps back to the previous session and to sessions waiting for the user', () => {
    const h = setup();
    h.shortcuts.noteSelection('agent:a');
    h.shortcuts.noteSelection('agent:d');
    h.press('`');
    expect(h.host.open).toHaveBeenCalledWith(h.sessions[0]);
    h.press('n');
    expect(h.host.toast).toHaveBeenCalledWith('没有等你处理的 Session');
    h.sessions[1].attention = true;
    h.press('n');
    expect(h.cursor()).toBe('agent:b');
  });

  it('binds and clears the key of the highlighted session, else of the open one', () => {
    const h = setup();
    h.press('x');
    expect(h.host.unbind).toHaveBeenLastCalledWith(h.sessions[0]);
    h.press('j');
    h.press('x');
    expect(h.host.unbind).toHaveBeenLastCalledWith(h.sessions[1]);
    h.press('b');
    expect(h.host.bind).toHaveBeenLastCalledWith(h.sessions[1]);
    h.press('4');
    expect(h.host.openSlot).toHaveBeenLastCalledWith(3);
  });

  it('leaves typing alone; Esc leaves a field unless a picker or the Terminal takes it', () => {
    const h = setup();
    h.input.focus();
    expect(h.press('j').defaultPrevented).toBe(false);
    expect(h.cursor()).toBeNull();
    expect(h.shortcuts.inNormalMode()).toBe(false);
    // An open picker handles (and prevents) its own Esc first.
    h.press('Escape', {defaultPrevented: true});
    expect(h.doc.activeElement).toBe(h.input);
    h.press('Escape');
    expect(h.doc.activeElement).toBe(h.doc.body);
    expect(h.shortcuts.inNormalMode()).toBe(true);
    h.xterm.focus();
    h.press('Escape');
    expect(h.doc.activeElement).toBe(h.xterm);
    h.press('j', {isComposing: true});
    expect(h.cursor()).toBeNull();
  });

  it('i enters the composer, or the Terminal when one is shown', () => {
    const h = setup();
    h.press('i');
    expect(h.doc.activeElement).toBe(h.input);
    h.doc.activeElement = h.doc.body;
    h.terminalView.hidden = false;
    h.form.hidden = true;
    h.press('i');
    expect(h.host.focusTerminal).toHaveBeenCalled();
  });

  it('Space toggles dictation and takes the focus from a clicked button, but not from one reached with Tab', () => {
    const h = setup();
    // Chrome makes a clicked button :focus-visible at the first key, so only how the focus came counts.
    h.pointer();
    h.buttons.abort.focus();
    h.press(' ');
    expect(h.host.toggleVoice).toHaveBeenCalledTimes(1);
    expect(h.doc.activeElement).toBe(h.doc.body);
    // Held keys do not toggle again.
    h.press(' ', {repeat: true});
    expect(h.host.toggleVoice).toHaveBeenCalledTimes(1);
    h.press('Tab');
    h.buttons.abort.focus();
    expect(h.press(' ').defaultPrevented).toBe(false);
    expect(h.press('Enter').defaultPrevented).toBe(false);
    expect(h.host.toggleVoice).toHaveBeenCalledTimes(1);
    // Clicking again, e.g. a dialog's button whose closing returns the focus here, hands keys back.
    h.pointer();
    h.buttons.abort.focus();
    h.press(' ');
    expect(h.host.toggleVoice).toHaveBeenCalledTimes(2);
    h.voiceInput.disabled = true;
    h.press(' ');
    expect(h.host.toggleVoice).toHaveBeenCalledTimes(2);
    expect(h.host.toast).toHaveBeenLastCalledWith('语音输入正在处理，请稍候');
  });

  it('sends with s or Ctrl+Enter only when there is text', () => {
    const h = setup();
    h.press('s');
    expect(h.form.requestSubmit).not.toHaveBeenCalled();
    expect(h.host.toast).toHaveBeenLastCalledWith('输入框为空');
    h.input.value = 'hello';
    h.press('s');
    h.press('Enter', {ctrlKey: true});
    expect(h.form.requestSubmit).toHaveBeenCalledTimes(2);
  });

  it('presses the existing buttons, and only where the open view has them', () => {
    const h = setup();
    h.press('r');
    h.press('p');
    h.press('m');
    h.press('t');
    h.press(',');
    expect(
      [h.buttons.undo, h.buttons.safePause, h.buttons.controls, h.libraryToggle, h.openConfig].map(
        b => b.clicks
      )
    ).toEqual([1, 1, 1, 1, 1]);
    h.toolbar.hidden = true;
    h.press('r');
    expect(h.buttons.undo.clicks).toBe(1);
    expect(h.host.toast).toHaveBeenLastCalledWith('Undo：请先打开一个 Agent');
  });

  it('aborts only on a second Q within 1.5 s', () => {
    const h = setup();
    h.host.now.mockReturnValue(1000);
    h.press('Q');
    expect(h.buttons.abort.clicks).toBe(0);
    expect(h.host.toast).toHaveBeenLastCalledWith('再按一次 Q 中止当前运行');
    h.host.now.mockReturnValue(3000);
    h.press('Q');
    expect(h.buttons.abort.clicks).toBe(0);
    h.host.now.mockReturnValue(3500);
    h.press('Q');
    expect(h.buttons.abort.clicks).toBe(1);
  });

  it('does not carry an armed Abort over to another session', () => {
    const h = setup();
    h.press('Q');
    h.shortcuts.noteSelection('agent:b');
    h.press('Q');
    expect(h.buttons.abort.clicks).toBe(0);
    expect(h.host.toast).toHaveBeenLastCalledWith('再按一次 Q 中止当前运行');
    h.press('Q');
    expect(h.buttons.abort.clicks).toBe(1);
  });

  it('copies the latest finished output and says when newer text is still streaming', async () => {
    const h = setup();
    h.press('y');
    await vi.waitFor(() => expect(h.host.toast).toHaveBeenCalled());
    expect(h.host.navigator.clipboard.writeText).toHaveBeenCalledWith('最终答案');
    expect(h.host.toast).toHaveBeenLastCalledWith('已复制最新一段输出（4 字）；正在生成的内容不包含在内');
    h.host.latestOutput.mockResolvedValueOnce(null);
    h.press('y');
    await vi.waitFor(() => expect(h.host.toast).toHaveBeenLastCalledWith('已加载的消息里没有 Agent 输出'));
  });

  it('in a dialog only moves through its message list', () => {
    const h = setup();
    const dialog = h.add('dialog', 'modal'),
      list = h.doc.createElement('div');
    list.className = 'modal-list';
    dialog.append(list);
    const choices = [0, 1, 2].map(index => {
      const choice = h.doc.createElement('button');
      choice.className = index === 1 ? 'choice selected' : 'choice';
      choice.onclick = () => {
        choices.forEach(other => other.classList.remove('selected'));
        choice.classList.add('selected');
      };
      list.append(choice);
      return choice;
    });
    dialog.open = true;
    h.press('j');
    expect(choices[2].classList.contains('selected')).toBe(true);
    h.press('j');
    expect(choices[2].classList.contains('selected')).toBe(true);
    h.press('ArrowUp');
    h.press('k');
    expect(choices[0].classList.contains('selected')).toBe(true);
    h.press('x');
    h.press(' ');
    expect(h.host.unbind).not.toHaveBeenCalled();
    expect(h.host.toggleVoice).not.toHaveBeenCalled();
  });

  it('gg and G scroll the transcript', () => {
    const h = setup();
    (h.messages as any).scrollTop = 500;
    h.press('g');
    expect((h.messages as any).scrollTop).toBe(500);
    h.press('g');
    expect((h.messages as any).scrollTop).toBe(0);
    h.press('G');
    expect(h.jumpToLatest.clicks).toBe(1);
  });

  it('can be switched off in the settings', () => {
    const h = setup({storage: {rpShortcuts: 'off'}});
    expect(h.press('j').defaultPrevented).toBe(false);
    expect(h.cursor()).toBeNull();
    expect(h.shortcuts.inNormalMode()).toBe(false);
  });
});
