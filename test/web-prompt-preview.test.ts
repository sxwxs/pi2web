import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const createSource = source.slice(
  source.indexOf('  async function createAgent()'),
  source.indexOf('  const templateModeText')
);
const previewSource = source.slice(
  source.indexOf('  function promptPreviewBox('),
  source.indexOf('  async function showAgentSystemPrompt()')
);

class Element {
  className = '';
  value = '';
  open = false;
  textContent = '';
  innerHTML = '';
  children: Element[] = [];
  listeners = new Map<string, () => void>();
  onchange?: () => void;
  append(...children: Element[]) {
    this.children.push(...children);
  }
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  fire(event: string) {
    this.listeners.get(event)?.();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return {promise, resolve};
}

async function setup() {
  const cwd = new Element();
  cwd.value = '.';
  const dialog = new Element();
  const pending: Array<{url: string; response: ReturnType<typeof deferred<{systemPrompt: string}>>}> = [];
  let input!: Element, template!: Element;
  const context = {
    state: {workspace: {id: 'ws', backendId: 'backend'}},
    $: () => cwd,
    document: {createElement: () => new Element()},
    field: (_body: Element, _label: string, value: string) => {
      input = new Element();
      input.value = value;
      return input;
    },
    templateSelect: () => (template = new Element()),
    promptSourcesText: () => 'preview',
    toast: () => {},
    URLSearchParams,
    requestBackend: (_backend: string, url: string) => {
      if (url.startsWith('/api/v1/sessions?')) return Promise.resolve([]);
      if (url === '/api/v1/agent-templates') return Promise.resolve({templates: []});
      const response = deferred<{systemPrompt: string}>();
      pending.push({url, response});
      return response.promise;
    },
    modal: async (_title: string, build: (body: Element) => void) => {
      build(dialog);
      return null;
    }
  };
  const {createAgent} = runInNewContext(`${createSource}\n${previewSource}\n({createAgent})`, context, {
    filename: 'web/app.js'
  });
  await createAgent();
  const box = dialog.children.find(child => child.className === 'prompt-preview')!;
  return {input, template, box, pending};
}

describe('create-Agent system prompt preview', () => {
  it('reloads for the new cwd even after the earlier preview was loaded', async () => {
    const ui = await setup();
    ui.box.open = true;
    ui.box.fire('toggle');
    expect(ui.pending).toHaveLength(1);
    ui.pending[0].response.resolve({systemPrompt: 'cwd A'});
    await vi.waitFor(() => expect(ui.box.children[2].textContent).toBe('cwd A'));

    ui.input.value = 'subdir';
    ui.input.fire('input');
    expect(ui.pending).toHaveLength(2);
    expect(new URLSearchParams(ui.pending[1].url.split('?')[1]).get('relativeCwd')).toBe('subdir');
    ui.pending[1].response.resolve({systemPrompt: 'cwd B'});
    await vi.waitFor(() => expect(ui.box.children[2].textContent).toBe('cwd B'));
  });

  it('ignores a pending response after the closed preview is reset', async () => {
    const ui = await setup();
    ui.box.open = true;
    ui.box.fire('toggle');
    ui.box.open = false;
    ui.box.fire('toggle');
    ui.template.value = 'reviewer';
    ui.template.onchange!();
    ui.pending[0].response.resolve({systemPrompt: 'old template'});
    await ui.pending[0].response.promise;
    await Promise.resolve();

    ui.box.open = true;
    ui.box.fire('toggle');
    expect(ui.pending).toHaveLength(2);
    expect(new URLSearchParams(ui.pending[1].url.split('?')[1]).get('templateId')).toBe('reviewer');
    ui.pending[1].response.resolve({systemPrompt: 'new template'});
    await vi.waitFor(() => expect(ui.box.children[2].textContent).toBe('new template'));
  });
});
