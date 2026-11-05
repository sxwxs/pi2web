import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function isSendKey(event, mode)');
const context: any = {};
runInNewContext(source.slice(start, source.indexOf("  $('input').onkeydown", start)), context);
const isSendKey: (event: object, mode: string) => boolean = context.isSendKey;
const enter = (extra: object = {}) => ({key: 'Enter', ...extra});

describe('prompt send shortcut', () => {
  it('sends only on Ctrl/⌘+Enter by default', () => {
    expect(isSendKey(enter(), 'ctrl-enter')).toBe(false);
    expect(isSendKey(enter({shiftKey: true}), 'ctrl-enter')).toBe(false);
    expect(isSendKey(enter({ctrlKey: true}), 'ctrl-enter')).toBe(true);
    expect(isSendKey(enter({metaKey: true}), 'ctrl-enter')).toBe(true);
  });

  it('sends on plain Enter in enter mode and keeps Shift+Enter for new lines', () => {
    expect(isSendKey(enter(), 'enter')).toBe(true);
    expect(isSendKey(enter({ctrlKey: true}), 'enter')).toBe(true);
    expect(isSendKey(enter({shiftKey: true}), 'enter')).toBe(false);
    expect(isSendKey(enter({altKey: true}), 'enter')).toBe(false);
    expect(isSendKey({key: 'a'}, 'enter')).toBe(false);
  });

  it('never sends the Enter that confirms an IME composition', () => {
    expect(isSendKey(enter({isComposing: true}), 'enter')).toBe(false);
    expect(isSendKey(enter({keyCode: 229}), 'enter')).toBe(false);
    expect(isSendKey(enter({isComposing: true, ctrlKey: true}), 'ctrl-enter')).toBe(false);
  });
});
