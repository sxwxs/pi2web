(() => {
  'use strict';

  /**
   * Vim-style keyboard shortcuts of the main page.
   *
   * Shortcuts work in Normal mode, i.e. while the focus is not in something you type into: the
   * composer, any other field or select, or the Terminal. Esc leaves a field, `i` enters the composer.
   * Normal mode has two sides, each with a highlight of its own: the session list (j/k move the cursor,
   * Enter opens its session) and the open Agent's transcript (j/k move between blocks, Enter folds or
   * unfolds one). Opening a session goes to its transcript; h and l switch sides.
   *
   * KEYMAP is the single source of truth: dispatch and the `?` help both read it. The app is reached
   * only through the `host` passed to create(); actions that already have a button press that button,
   * so a shortcut does exactly what a click does.
   */

  // `keys`: KeyboardEvent.key names as produced by keyName(); a space separates the keys of a sequence.
  // `pane`: the side the key works on ('list' or 'transcript'); without it, both.
  // `repeat`: whether holding the key repeats the action.
  const KEYMAP = [
    {
      group: 'Session',
      pane: 'list',
      keys: ['j'],
      action: 'down',
      repeat: true,
      text: '高亮下一个 Session（到底自动加载更多）'
    },
    {group: 'Session', pane: 'list', keys: ['k'], action: 'up', repeat: true, text: '高亮上一个 Session'},
    {
      group: 'Session',
      pane: 'list',
      keys: ['Enter', 'o'],
      action: 'open',
      text: '打开高亮的 Session，焦点进入它的对话（最新的 block）'
    },
    {group: 'Session', keys: ['h'], action: 'left', text: '焦点回到 Session 列表，高亮当前 Session'},
    {group: 'Session', keys: ['n'], action: 'nextAttention', text: '高亮下一个等你处理的 Session'},
    {group: 'Session', keys: ['N'], action: 'previousAttention', text: '高亮上一个等你处理的 Session'},
    {group: 'Session', keys: ['`'], action: 'previous', text: '切回上一个打开的 Session'},
    {
      group: 'Session',
      keys: ['1', '2', '3', '4', '5', '6'],
      action: 'slot',
      text: '打开六键键盘 K1–K6 绑定的 Session'
    },
    {group: 'Session', keys: ['b'], action: 'bind', text: '把高亮（没有高亮时为当前）Session 绑定到键盘按键'},
    {group: 'Session', keys: ['x'], action: 'unbind', text: '清除高亮（没有高亮时为当前）Session 的键盘按键'},
    {group: '对话', keys: ['l'], action: 'right', text: '焦点进入右侧对话，回到上次的 block'},
    {group: '对话', pane: 'transcript', keys: ['j'], action: 'blockDown', repeat: true, text: '下一个 block'},
    {
      group: '对话',
      pane: 'transcript',
      keys: ['k'],
      action: 'blockUp',
      repeat: true,
      text: '上一个 block（到顶自动加载更早的对话）'
    },
    {
      group: '对话',
      pane: 'transcript',
      keys: ['Enter', 'o'],
      action: 'toggleBlock',
      text: '展开 / 折叠焦点 block'
    },
    {
      group: '对话',
      keys: ['e'],
      action: 'toggleBlock',
      text: '展开 / 折叠焦点 block，在列表里也能用（默认最新的）'
    },
    {
      group: '对话',
      pane: 'transcript',
      keys: ['y'],
      action: 'copyBlock',
      text: '复制焦点 block（消息为 Markdown 原文，工具为参数和结果）'
    },
    {
      group: '对话',
      keys: ['r'],
      action: 'undo',
      text: 'Undo：预选焦点所在这一轮你的消息（在列表里为最近一轮），Enter 即撤回'
    },
    {group: '输入', keys: ['Space'], action: 'voice', text: '开始 / 停止语音输入'},
    {
      group: '输入',
      keys: ['s', 'Ctrl+Enter'],
      action: 'send',
      text: '发送输入框内容（按当前 Prompt / Steer / Follow-up）'
    },
    {group: '输入', keys: ['i'], action: 'insert', text: '进入输入框；Terminal 视图下进入 Terminal'},
    {group: '输入', keys: ['/'], action: 'command', text: '输入框为空时输入 /，打开命令列表'},
    {group: '输入', keys: ['@'], action: 'mention', text: '在输入框末尾输入 @，引用文件'},
    {group: '输入', keys: ['t'], action: 'library', text: '打开提示词模板 / 历史'},
    {
      group: 'Agent',
      pane: 'list',
      keys: ['y'],
      action: 'copy',
      text: '复制最新一段 Agent 输出（Markdown 原文）'
    },
    {group: 'Agent', keys: ['p'], action: 'pause', text: '安全暂停 / 取消暂停'},
    {group: 'Agent', keys: ['Q'], action: 'abort', text: 'Abort 当前运行（1.5 秒内连按两次）'},
    {group: 'Agent', keys: ['m'], action: 'model', text: '模型设置'},
    {group: '消息', keys: ['d'], action: 'pageDown', repeat: true, text: '向下滚动半页'},
    {group: '消息', keys: ['u'], action: 'pageUp', repeat: true, text: '向上滚动半页'},
    {group: '消息', keys: ['G'], action: 'bottom', text: '跳到最新输出并继续跟随，焦点移到最新的 block'},
    {group: '消息', keys: ['g g'], action: 'top', text: '跳到已加载消息的顶部，焦点移到第一个 block'},
    {group: '其他', keys: ['?'], action: 'help', text: '显示 / 关闭快捷键说明'},
    {group: '其他', keys: [','], action: 'config', text: '打开配置'},
    {group: '其他', keys: ['Escape'], action: 'escape', text: '取消高亮、关闭菜单和未完成的按键序列'}
  ];
  /** Keys that work outside Normal mode. Handled below; listed here for the help. */
  const CONTEXT_KEYS = [
    {
      group: '输入框、Terminal 与对话框',
      keys: ['Escape'],
      text: '输入框内：先关闭弹出的选择器，再按一次离开输入框'
    },
    {
      group: '输入框、Terminal 与对话框',
      keys: ['Ctrl+]'],
      text: '离开 Terminal（Esc 留给 Terminal 里的程序）'
    },
    {group: '输入框、Terminal 与对话框', keys: ['j', 'k'], text: 'Undo / Fork 对话框：选择消息，Enter 确认'}
  ];
  const KEY_LABELS = {Space: 'Space', Escape: 'Esc', 'Ctrl+Enter': 'Ctrl/⌘+Enter', 'g g': 'gg'};
  const PANE_LABELS = {list: '列表', transcript: '对话'};
  const keyLabel = key => KEY_LABELS[key] || key;
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'OS']);
  const SEQUENCE_TIMEOUT = 1000;
  const ABORT_WINDOW = 1500;

  /** The keymap name of a keydown, or null for keys shortcuts never take (other Ctrl/⌘/Alt combinations). */
  function keyName(event) {
    const key = event.key;
    if (!key || MODIFIERS.has(key) || ['Unidentified', 'Dead', 'Process'].includes(key)) return null;
    if (event.altKey) return null;
    if (event.ctrlKey || event.metaKey) return key === 'Enter' ? 'Ctrl+Enter' : null;
    return key === ' ' ? 'Space' : key;
  }

  /** `bindings`: keys → the entries bound to them, at most one per side. */
  function compile(keymap) {
    const bindings = new Map(),
      prefixes = new Set();
    for (const entry of keymap)
      for (const keys of entry.keys) {
        if (!bindings.has(keys)) bindings.set(keys, []);
        bindings.get(keys).push(entry);
        const parts = keys.split(' ');
        for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join(' '));
      }
    return {bindings, prefixes};
  }
  /**
   * One key, possibly continuing a sequence: `{entry, key}` once a binding is complete, `{pending}`
   * while a sequence goes on, null for an unbound key. A key that breaks a sequence counts on its own.
   * `pane` is the side with the focus: 'list' or 'transcript'.
   */
  function resolveKey(compiled, pending, name, pane = 'list') {
    const sequence = pending ? `${pending} ${name}` : name,
      entry = compiled.bindings.get(sequence)?.find(item => !item.pane || item.pane === pane);
    if (entry) return {entry, key: name};
    if (compiled.prefixes.has(sequence)) return {pending: sequence};
    return pending ? resolveKey(compiled, '', name, pane) : null;
  }

  /** Whether keys typed with this element focused are text (or Terminal input), not shortcuts. */
  function isTypingTarget(el) {
    if (!el) return false;
    return !!el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }
  /**
   * Space and Enter activate a focused button. A button reached with Tab keeps that; one focused by a
   * mouse click does not, or Space right after clicking Abort would abort again. `tabbed` says how the
   * focus last moved. (Not :focus-visible: Chrome turns that on for a clicked button at the first key.)
   */
  function isNativeActivation(el, name, tabbed) {
    return (
      tabbed &&
      (name === 'Space' || name === 'Enter') &&
      !!el &&
      ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)
    );
  }

  /** The key `delta` steps from `from` in `keys`, stopping at either end; from nothing it is the first. */
  function moveCursor(keys, from, delta) {
    if (!keys.length) return null;
    const index = keys.indexOf(from);
    if (index < 0) return keys[0];
    return keys[Math.max(0, Math.min(keys.length - 1, index + delta))];
  }
  /** Index of the next entry (step 1) or previous one (step -1) that needs attention, wrapping; -1 if none. */
  function nextAttention(entries, from, step) {
    const count = entries.length,
      index = entries.findIndex(entry => entry.key === from),
      start = index >= 0 ? index : step > 0 ? -1 : 0;
    for (let i = 1; i <= count; i++) {
      const at = (((start + step * i) % count) + count) % count;
      if (entries[at].attention) return at;
    }
    return -1;
  }

  async function copyText(text, doc, nav) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // No Clipboard API outside a secure context (e.g. http on the LAN): fall back to a selection.
    }
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = doc.execCommand('copy');
    } catch {}
    area.remove();
    return copied;
  }

  /**
   * Install the shortcuts. `host` is the app side:
   *   sessions()            listed sessions in list order: [{key, kind, item, attention}]
   *   reveal(index)         make sure the list shows the entry at `index` (load more)
   *   selectedKey()         key of the open session, or null
   *   open(entry)           open a session (the app then calls noteSelection)
   *   renderCursor(keys)    re-render these list cards; scrollToCursor(key) brings one into view
   *   openSlot(slot)        open the session bound to keyboard key `slot` (0-5)
   *   bind(entry), unbind(entry)   keyboard key binding of a session
   *   toggleVoice()         start / stop dictation
   *   latestOutput()        newest finished Agent text in the loaded transcript → {text, streaming} | null
   *   blocks()              the transcript's blocks in page order: its cards, and those of open activity groups
   *   following()           whether the transcript follows new output
   *   blockText(block)      the text `y` copies from a block; rejects with the reason it has none
   *   focusTerminal()       focus the open Terminal
   *   toast(text)
   * The app calls transcriptChanged() whenever the transcript changes, and focusBlock() on a click in it.
   */
  function create(host) {
    const doc = host.document || document,
      win = host.window || window,
      nav = host.navigator || navigator,
      storage = host.storage || localStorage,
      $ = id => doc.getElementById(id),
      compiled = compile(KEYMAP);
    let enabled = storage.rpShortcuts !== 'off',
      pending = '',
      pendingTimer = null,
      cursor = null,
      cursorVisible = false,
      current = null,
      previous = null,
      abortArmedUntil = 0,
      tabbed = false,
      help = null,
      // The side with the focus, and the transcript's focused block. `blockFollow`: the block was the newest
      // when the user put the focus there, so it moves on to newer blocks while the transcript follows output.
      pane = 'list',
      block = null,
      blockFollow = true;
    const now = host.now || (() => Date.now());

    const chip = doc.createElement('div');
    chip.id = 'shortcutMode';
    chip.className = 'shortcut-mode';
    chip.hidden = true;
    chip.setAttribute('aria-hidden', 'true');
    doc.body.append(chip);

    const inTerminal = el => !!el && !!$('terminalView')?.contains(el);
    const agentView = () => !!$('prompt') && !$('prompt').hidden;
    const terminalView = () => !!$('terminalView') && !$('terminalView').hidden;
    const openDialog = () => doc.querySelector('dialog[open]');
    /** The transcript side exists only while an Agent is shown; otherwise keys go to the list. */
    const activePane = () => (pane === 'transcript' && agentView() ? 'transcript' : 'list');

    function updateMode() {
      let text = '',
        mode = '';
      if (enabled && !openDialog()) {
        const active = doc.activeElement;
        if (isTypingTarget(active))
          [mode, text] = inTerminal(active)
            ? ['terminal', 'TERMINAL · Ctrl+] 离开']
            : ['insert', 'INSERT · Esc 离开'];
        else
          [mode, text] = [
            'normal',
            `NORMAL · ${PANE_LABELS[activePane()]} · ${pending ? `${pending}…` : '? 快捷键'}`
          ];
      }
      // Runs on every change of the transcript, i.e. per frame while text streams in.
      if (chip.textContent !== text) chip.textContent = text;
      chip.dataset.mode = mode;
      chip.hidden = !text;
    }
    const scheduleMode = () => win.setTimeout(updateMode, 0);

    function setPending(sequence) {
      win.clearTimeout(pendingTimer);
      pending = sequence;
      if (sequence)
        pendingTimer = win.setTimeout(() => {
          pending = '';
          updateMode();
        }, SEQUENCE_TIMEOUT);
    }

    /** A visible list cursor means the focus is on the list. */
    function setCursor(key, visible = true) {
      const before = cursorVisible ? cursor : null;
      cursor = key;
      cursorVisible = visible && !!key;
      if (cursorVisible && pane !== 'list') {
        pane = 'list';
        paintBlock();
      }
      const after = cursorVisible ? cursor : null,
        changed = [...new Set([before, after].filter(Boolean))];
      if (changed.length) host.renderCursor(changed);
      if (after) host.scrollToCursor?.(after);
    }
    /** The session list-level actions (bind, unbind) apply to: the highlight, else the open session. */
    function targetEntry() {
      const key = cursorVisible ? cursor : host.selectedKey();
      return key ? host.sessions().find(entry => entry.key === key) || null : null;
    }
    function move(delta) {
      const keys = host.sessions().map(entry => entry.key);
      if (!keys.length) return host.toast('没有 Session');
      const from = cursorVisible && keys.includes(cursor) ? cursor : host.selectedKey(),
        key = moveCursor(keys, from, delta);
      host.reveal(keys.indexOf(key));
      setCursor(key);
    }
    function moveToAttention(step) {
      const entries = host.sessions(),
        index = nextAttention(entries, cursorVisible ? cursor : host.selectedKey(), step);
      if (index < 0) return host.toast('没有等你处理的 Session');
      host.reveal(index);
      setCursor(entries[index].key);
    }
    function openCursor() {
      if (!cursorVisible) return;
      const entry = host.sessions().find(item => item.key === cursor);
      if (!entry) {
        setCursor(null, false);
        return host.toast('高亮的 Session 已不在列表中');
      }
      return host.open(entry);
    }
    function openPrevious() {
      const entry = previous && host.sessions().find(item => item.key === previous);
      if (!entry) return host.toast(previous ? '上一个 Session 已不在列表中' : '还没有上一个 Session');
      return host.open(entry);
    }
    function focusList() {
      pane = 'list';
      paintBlock();
      const keys = host.sessions().map(entry => entry.key);
      setCursor(keys.includes(cursor) ? cursor : host.selectedKey(), true);
    }
    function focusTranscript() {
      if (!agentView())
        return host.toast(
          terminalView() ? 'Terminal 没有对话；按 i 进入 Terminal' : '右侧还没有打开的 Agent'
        );
      pane = 'transcript';
      setCursor(cursor, false);
      syncBlock();
    }

    // ---- The transcript's focused block.
    const blocks = () => host.blocks?.() || [];
    function paintBlock() {
      if (!block) return;
      if (enabled && activePane() === 'transcript') block.classList.add('block-cursor');
      else block.classList.remove('block-cursor');
    }
    function setBlock(el, follow = blockFollow) {
      if (el !== block) {
        block?.classList.remove('block-cursor');
        block = el;
      }
      blockFollow = follow;
      paintBlock();
    }
    /**
     * The focused block in the transcript as it is now: the newest while it follows the output, else the
     * same card or one re-rendered for the same item, else (it is gone) the newest. Null without blocks.
     */
    function syncBlock() {
      const list = blocks(),
        newest = list.at(-1) || null,
        id = block?.dataset?.itemId,
        same = list.includes(block) ? block : (id && list.find(el => el.dataset.itemId === id)) || null;
      if (!same) setBlock(newest, true);
      else setBlock(blockFollow && host.following?.() ? newest : same);
      return block;
    }
    /** Keep a block in view; one taller than the transcript shows its start. */
    function revealBlock(el) {
      const box = $('messages'),
        tall = !!box && el.offsetHeight > box.clientHeight;
      el.scrollIntoView?.({block: tall ? 'start' : 'nearest'});
    }
    function moveBlock(delta) {
      const list = blocks(),
        index = list.indexOf(syncBlock());
      if (!list.length) return host.toast('对话里还没有内容');
      if (index === 0 && delta < 0) {
        // At the top of what is loaded: load older items above; the focus stays and k goes on into them.
        const older = $('loadOlderMessages');
        if (older && !older.disabled) {
          older.click();
          host.toast('正在加载更早的对话…');
        }
        return;
      }
      const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
      setBlock(next, next === list.at(-1));
      revealBlock(next);
    }
    function toggleBlock() {
      if (!requireAgentView('展开')) return;
      const el = syncBlock();
      if (!el) return host.toast('对话里还没有内容');
      el.open = !el.open;
      // Expanded, a long block shows its start; collapsed, the reader is not left past its end.
      el.scrollIntoView?.({block: 'nearest'});
    }
    async function copyBlock() {
      const el = syncBlock();
      if (!el) return host.toast('对话里还没有内容');
      const text = await host.blockText(el);
      if (!text) return host.toast('焦点 block 没有文字');
      if (!(await copyText(text, doc, nav))) return host.toast('复制失败：浏览器不允许写入剪贴板');
      host.toast(`已复制焦点 block（${text.length} 字）`);
    }

    /** Press an existing button, if the current view has it. */
    function press(id, what) {
      const button = $(id);
      if (!button || button.closest('[hidden]')) return host.toast(`${what}：请先打开一个 Agent`);
      if (button.disabled) return host.toast(`${what}当前不可用`);
      button.click();
    }
    function requireAgentView(what) {
      if (agentView()) return true;
      host.toast(`${what}：请先打开一个 Agent`);
      return false;
    }
    /** Focus the composer with the caret at the end, then type `text` there as if typed. */
    function typeIntoComposer(text = '') {
      const input = $('input');
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      if (!text) return;
      input.setRangeText(text, end, end, 'end');
      input.dispatchEvent(new win.Event('input', {bubbles: true}));
    }
    function scrollMessages(direction) {
      const box = $('messages');
      if (!box || box.hidden) return;
      box.scrollBy({top: (direction * box.clientHeight) / 2});
    }
    async function copy() {
      if (!requireAgentView('复制')) return;
      const output = await host.latestOutput();
      if (!output?.text) return host.toast('已加载的消息里没有 Agent 输出');
      const copied = await copyText(output.text, doc, nav);
      if (!copied) return host.toast('复制失败：浏览器不允许写入剪贴板');
      host.toast(
        `已复制最新一段输出（${output.text.length} 字）` +
          (output.streaming ? '；正在生成的内容不包含在内' : '')
      );
    }
    function toggleHelp() {
      if (!help) help = buildHelp();
      if (help.open) help.close();
      else help.showModal();
    }
    function buildHelp() {
      const dialog = doc.createElement('dialog');
      dialog.id = 'shortcutHelp';
      dialog.className = 'shortcut-help';
      const form = doc.createElement('form');
      form.method = 'dialog';
      const title = doc.createElement('h2');
      title.textContent = '键盘快捷键';
      const note = doc.createElement('p');
      note.className = 'muted';
      note.textContent =
        '焦点不在输入框、Terminal 或对话框里时生效（左下角显示 NORMAL）。左侧 Session 列表和右侧对话各有焦点，' +
        'h / l 切换；标「列表」「对话」的键只在焦点所在的一侧生效。可在「配置 → 输入」中关闭。';
      const groups = doc.createElement('div');
      groups.className = 'shortcut-groups';
      const byGroup = new Map();
      for (const entry of [...KEYMAP, ...CONTEXT_KEYS]) {
        if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
        byGroup.get(entry.group).push(entry);
      }
      for (const [name, entries] of byGroup) {
        const section = doc.createElement('section'),
          heading = doc.createElement('h3'),
          list = doc.createElement('dl');
        heading.textContent = name;
        for (const entry of entries) {
          const keys = doc.createElement('dt'),
            text = doc.createElement('dd');
          for (const key of entry.keys) {
            const kbd = doc.createElement('kbd');
            kbd.textContent = keyLabel(key);
            keys.append(kbd);
          }
          if (entry.pane) {
            const side = doc.createElement('small');
            side.className = 'muted';
            side.textContent = PANE_LABELS[entry.pane];
            keys.append(side);
          }
          text.textContent = entry.text;
          list.append(keys, text);
        }
        section.append(heading, list);
        groups.append(section);
      }
      const actions = doc.createElement('div');
      actions.className = 'dialog-actions';
      const close = doc.createElement('button');
      close.textContent = '关闭';
      actions.append(close);
      form.append(title, note, groups, actions);
      dialog.append(form);
      doc.body.append(dialog);
      return dialog;
    }

    const actions = {
      down: () => move(1),
      up: () => move(-1),
      open: openCursor,
      left: focusList,
      right: focusTranscript,
      blockDown: () => moveBlock(1),
      blockUp: () => moveBlock(-1),
      toggleBlock,
      copyBlock,
      nextAttention: () => moveToAttention(1),
      previousAttention: () => moveToAttention(-1),
      previous: openPrevious,
      slot: key => host.openSlot(Number(key) - 1),
      bind: () => {
        const entry = targetEntry();
        return entry ? host.bind(entry) : host.toast('请先用 j/k 高亮一个 Session');
      },
      unbind: () => {
        const entry = targetEntry();
        return entry ? host.unbind(entry) : host.toast('请先用 j/k 高亮一个 Session');
      },
      voice: () => {
        if (!requireAgentView('语音输入')) return;
        if ($('voiceInput')?.disabled) return host.toast('语音输入正在处理，请稍候');
        return host.toggleVoice();
      },
      send: () => {
        if (!requireAgentView('发送')) return;
        if (!$('input').value.trim()) return host.toast('输入框为空');
        $('prompt').requestSubmit();
      },
      insert: () => {
        if (terminalView()) return host.focusTerminal();
        if (requireAgentView('输入')) typeIntoComposer();
      },
      command: () => {
        if (!requireAgentView('命令')) return;
        const input = $('input');
        if (input.value.trim()) {
          typeIntoComposer();
          return host.toast('命令只能写在输入框开头');
        }
        input.value = '';
        typeIntoComposer('/');
      },
      mention: () => {
        if (!requireAgentView('引用文件')) return;
        const value = $('input').value;
        typeIntoComposer(`${value && !/\s$/.test(value) ? ' ' : ''}@`);
      },
      library: () => requireAgentView('模板') && $('libraryToggle').click(),
      undo: () => press('undo', 'Undo'),
      copy,
      pause: () => press('safePause', '安全暂停'),
      abort: () => {
        const button = $('abort');
        if (!button || button.closest('[hidden]')) return host.toast('Abort：请先打开一个 Agent');
        if (now() < abortArmedUntil) {
          abortArmedUntil = 0;
          return press('abort', 'Abort');
        }
        abortArmedUntil = now() + ABORT_WINDOW;
        host.toast('再按一次 Q 中止当前运行');
      },
      model: () => press('controls', '模型设置'),
      pageDown: () => scrollMessages(1),
      pageUp: () => scrollMessages(-1),
      bottom: () => {
        if ($('messages')?.hidden) return;
        $('jumpToLatest')?.click();
        setBlock(blocks().at(-1) || null, true);
      },
      top: () => {
        const box = $('messages');
        if (!box || box.hidden) return;
        box.scrollTop = 0;
        const list = blocks();
        setBlock(list[0] || null, list.length <= 1);
      },
      help: toggleHelp,
      config: () => $('openConfig')?.click(),
      escape: () => {
        for (const id of ['contextMenu', 'agentContextMenu']) if ($(id)) $(id).hidden = true;
        abortArmedUntil = 0;
        setCursor(cursor, false);
      }
    };
    function run(action, key) {
      try {
        const result = actions[action](key);
        if (result && typeof result.catch === 'function') result.catch(error => host.toast(error.message));
      } catch (error) {
        host.toast(error.message);
      }
    }

    /** In an open dialog only its message list takes keys: j/k (and ↑/↓) choose, Enter confirms. */
    function dialogKey(event, dialog) {
      if (dialog === help && event.key === '?') {
        event.preventDefault();
        return help.close();
      }
      if (isTypingTarget(doc.activeElement) || event.ctrlKey || event.metaKey || event.altKey) return;
      const step = {j: 1, ArrowDown: 1, k: -1, ArrowUp: -1}[event.key];
      const choices = step
        ? [...(dialog.querySelector('.modal-list')?.querySelectorAll('.choice') || [])]
        : [];
      if (!choices.length) return;
      event.preventDefault();
      const index = choices.findIndex(choice => choice.classList.contains('selected')),
        next = choices[index < 0 ? 0 : Math.max(0, Math.min(choices.length - 1, index + step))];
      next.click();
      next.scrollIntoView?.({block: 'nearest'});
    }

    function onKeyDown(event) {
      if (!enabled || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const dialog = openDialog();
      if (dialog) return dialogKey(event, dialog);
      const active = doc.activeElement;
      if (isTypingTarget(active)) {
        // Pickers in the composer take their Esc first (and prevent it); the Terminal keeps Esc for its programs.
        if (
          event.key === 'Escape' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !inTerminal(active)
        ) {
          event.preventDefault();
          active.blur();
        }
        return;
      }
      const name = keyName(event);
      if (!name || isNativeActivation(active, name, tabbed)) return;
      const result = resolveKey(compiled, pending, name, activePane());
      setPending(result?.pending || '');
      if (result) {
        event.preventDefault();
        if (result.entry && (!event.repeat || result.entry.repeat)) {
          // A clicked button keeps the focus; take it so the key's keyup cannot activate it.
          if (active && active !== doc.body && (name === 'Space' || name === 'Enter')) active.blur?.();
          run(result.entry.action, result.key);
        }
      }
      updateMode();
    }
    /** Ctrl+] leaves the Terminal. Captured before xterm sees it, which would send it to the shell. */
    function onTerminalEscape(event) {
      if (!enabled || !event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key !== ']' && event.code !== 'BracketRight') return;
      const active = doc.activeElement;
      if (!inTerminal(active)) return;
      event.preventDefault();
      event.stopPropagation();
      active.blur();
      scheduleMode();
    }

    doc.addEventListener('keydown', onKeyDown);
    win.addEventListener('keydown', onTerminalEscape, true);
    // How the focus last moved, for isNativeActivation. Captured, so no handler can hide it.
    doc.addEventListener('keydown', event => event.key === 'Tab' && (tabbed = true), true);
    doc.addEventListener('pointerdown', () => (tabbed = false), true);
    doc.addEventListener('focusin', scheduleMode);
    doc.addEventListener('focusout', scheduleMode);
    // `close` does not bubble, but a capturing listener still sees every dialog close.
    doc.addEventListener('close', scheduleMode, true);
    const toggle = $('shortcutsEnabled');
    if (toggle) {
      toggle.checked = enabled;
      toggle.onchange = () => {
        enabled = toggle.checked;
        storage.rpShortcuts = enabled ? 'on' : 'off';
        if (!enabled) {
          setPending('');
          setCursor(cursor, false);
        }
        syncBlock();
        updateMode();
      };
    }
    updateMode();

    return {
      /** Whether the list card of `key` shows the highlight. */
      isCursor: key => cursorVisible && key === cursor,
      /**
       * The app opened a session (any way): it becomes the cursor's place and the `\`` target's successor,
       * and the focus goes to its transcript, on the newest block.
       */
      noteSelection(key) {
        // An Abort armed in one session must not carry over to the next.
        abortArmedUntil = 0;
        if (key && key !== current) {
          if (current) previous = current;
          current = key;
        }
        setCursor(key, false);
        pane = 'transcript';
        setBlock(null, true);
        syncBlock();
        updateMode();
      },
      /** The transcript changed: keep the focused block on it (and on the newest while following). */
      transcriptChanged() {
        if (!enabled) return;
        syncBlock();
        updateMode();
      },
      /** A click in the transcript moves the focus there, onto the clicked block. */
      focusBlock(el) {
        const list = blocks();
        if (!enabled || !list.includes(el)) return;
        pane = 'transcript';
        setCursor(cursor, false);
        setBlock(el, el === list.at(-1));
        updateMode();
      },
      /**
       * For Undo: the item id of your message that starts the round the focused block is in, while the focus
       * is on the transcript; else null.
       */
      undoTarget() {
        if (!enabled || activePane() !== 'transcript') return null;
        const list = blocks();
        for (let i = list.indexOf(syncBlock()); i >= 0; i--)
          if (list[i].classList.contains('user') && list[i].dataset.itemId) return list[i].dataset.itemId;
        return null;
      },
      /** True while keys are shortcuts; nothing should then move the focus into the composer by itself. */
      inNormalMode: () => enabled && !openDialog() && !isTypingTarget(doc.activeElement),
      get enabled() {
        return enabled;
      }
    };
  }

  window.RemotePiShortcuts = {
    KEYMAP,
    CONTEXT_KEYS,
    keyName,
    keyLabel,
    compile,
    resolveKey,
    isTypingTarget,
    isNativeActivation,
    moveCursor,
    nextAttention,
    create
  };
})();
