(() => {
  'use strict';

  /**
   * One ↑/↓ step through the composer history, like a shell.
   *
   * `items` is newest first. `nav.index` is the recalled entry (-1: the person's own draft, kept in
   * `nav.draft` while browsing). ↑ only recalls when the caret is on the first line and ↓ only when it
   * is on the last, so arrows still move through a multi-line prompt. Returns null when the key should
   * keep its normal caret movement.
   */
  function historyStep({items, nav, value, selectionStart, selectionEnd}, direction) {
    if (selectionStart !== selectionEnd) return null;
    // Text changed without typing (dictation, a voice draft, a restored queue) is a new draft, never discarded.
    if (nav.index >= 0 && value !== items[nav.index]) nav = {index: -1, draft: ''};
    if (direction === 'up') {
      if (value.slice(0, selectionStart).includes('\n')) return null;
      // Skip an entry equal to what is already shown, or ↑ would seem to do nothing.
      let index = nav.index + 1;
      while (index < items.length && items[index] === value) index++;
      if (index >= items.length) return null;
      const text = items[index];
      // A multi-line entry keeps the caret on its first line, so the next ↑ continues to older entries.
      return {
        nav: {index, draft: nav.index < 0 ? value : nav.draft},
        value: text,
        caret: text.includes('\n') ? 0 : text.length
      };
    }
    if (nav.index < 0 || value.slice(selectionEnd).includes('\n')) return null;
    let index = nav.index - 1;
    while (index >= 0 && items[index] === value) index--;
    if (index < 0) return {nav: {index: -1, draft: ''}, value: nav.draft, caret: nav.draft.length};
    return {nav: {index, draft: nav.draft}, value: items[index], caret: items[index].length};
  }

  /**
   * Put a chosen text into the composer without losing what is already typed: an empty composer takes
   * it as is; otherwise it goes in at the selection, on lines of its own.
   */
  function insertText(value, selectionStart, selectionEnd, text) {
    if (!value.trim()) return {value: text, caret: text.length};
    const before = value.slice(0, selectionStart),
      after = value.slice(selectionEnd),
      lead = before && !before.endsWith('\n') ? '\n' : '',
      trail = after && !after.startsWith('\n') ? '\n' : '';
    return {value: before + lead + text + trail + after, caret: (before + lead + text).length};
  }

  /** Whether a Pi prompt template takes arguments ($1, $@, $ARGUMENTS, ${…}): then it runs as `/name args`. */
  const usesArguments = content => /\$(?:\d|@|ARGUMENTS)|\$\{(?:\d|@|ARGUMENTS)/.test(content);

  /** Case-insensitive match of every whitespace-separated word against any of the given fields. */
  function matches(query, ...fields) {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = fields.filter(Boolean).join('\n').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  }

  window.PromptLibrary = {historyStep, insertText, usesArguments, matches};
})();
