import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));

describe('dialogs that open on their confirm button', () => {
  it('sets the initial focus before opening, and only for dialogs that ask for it', async () => {
    const ok = {textContent: '', autofocus: false},
      focusAtOpen: boolean[] = [];
    let onClose = () => {};
    const dialog = {
      returnValue: '',
      addEventListener: (_event: string, listener: () => void) => (onClose = listener),
      removeEventListener: () => {},
      showModal() {
        focusAtOpen.push(ok.autofocus);
        this.returnValue = 'default';
        onClose();
      }
    };
    const elements: Record<string, object> = {
      modal: dialog,
      modalOk: ok,
      modalBody: {replaceChildren: () => {}},
      modalTitle: {}
    };
    const {modal} = runInNewContext(`${slice('  function modal(', '  const field = (body')}\n({modal})`, {
      $: (id: string) => elements[id]
    });
    expect(await modal('绑定', () => 'bound', '绑定', {focusOk: true})).toBe('bound');
    await modal('Session 名称', () => 'name');
    expect(focusAtOpen).toEqual([true, false]);
  });

  it('opens the key binding and key colour dialogs on the confirm button', async () => {
    const modal = vi.fn(async () => null);
    const {bindKeyboard, changeKeyboardColor} = runInNewContext(
      `${slice('  async function bindKeyboard(', '  async function createAgent(')}\n({bindKeyboard, changeKeyboardColor})`,
      {
        modal,
        toast: vi.fn(),
        state: {agents: [{agentId: 'a'}]},
        sessionKeyboard: {
          getFreeSlots: () => [0],
          getBinding: (agentId: string) => (agentId === 'bound' ? {slot: 1, color: '#ffffff'} : null)
        }
      }
    );
    await bindKeyboard({agentId: 'a'});
    await changeKeyboardColor({agentId: 'bound'});
    expect(modal.mock.calls.map(call => (call as unknown[])[3])).toEqual([{focusOk: true}, {focusOk: true}]);
  });
});
