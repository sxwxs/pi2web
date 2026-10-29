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
  disabled = false;
  textContent = '';
  innerHTML = '';
  children: Element[] = [];
  get options() {
    return this.children;
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    this.value = children[0]?.value || '';
  }
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

async function setup(
  options: {
    submit?: boolean;
    catalog?: unknown;
    modelRefresh?: Promise<unknown>;
    onModal?: (dialog: Element, input: Element, submit: Element) => Promise<void>;
  } = {}
) {
  const cwd = new Element();
  cwd.value = '.';
  const dialog = new Element();
  const submit = new Element();
  let modelCalls = 0;
  const pending: Array<{url: string; response: ReturnType<typeof deferred<{systemPrompt: string}>>}> = [];
  let input!: Element, template!: Element;
  let created: unknown;
  const context = {
    state: {workspace: {id: 'ws', backendId: 'backend'}},
    $: (id: string) => (id === 'modalOk' ? submit : id === 'modal' ? dialog : cwd),
    document: {createElement: () => new Element()},
    field: (_body: Element, _label: string, value: string) => {
      input = new Element();
      input.value = value;
      return input;
    },
    templateSelect: () => (template = new Element()),
    promptSourcesText: () => 'preview',
    toast: vi.fn(),
    URLSearchParams,
    requestBackend: (_backend: string, url: string) => {
      if (url.startsWith('/api/v1/sessions?')) return Promise.resolve([]);
      if (url === '/api/v1/agent-templates') return Promise.resolve({templates: []});
      if (url.startsWith('/api/v1/agents/models?'))
        return ++modelCalls === 1
          ? Promise.resolve(options.catalog || {models: []})
          : options.modelRefresh || Promise.resolve(options.catalog || {models: []});
      const response = deferred<{systemPrompt: string}>();
      pending.push({url, response});
      return response.promise;
    },
    modal: async (_title: string, build: (body: Element) => () => unknown) => {
      const selection = build(dialog);
      await options.onModal?.(dialog, input, submit);
      return options.submit ? selection() : null;
    },
    postBackend: async (_backend: string, _path: string, body: unknown) => {
      created = body;
      return {agentId: 'new-agent'};
    },
    localStorage: {getItem: () => null, setItem: () => {}},
    stampNewItem: (_backend: string, agent: unknown) => agent,
    autoBindNewSession: () => null,
    refreshAgents: async () => {},
    selectAgent: async () => {}
  };
  const {createAgent} = runInNewContext(`${createSource}\n${previewSource}\n({createAgent})`, context, {
    filename: 'web/app.js'
  });
  await createAgent();
  const box = dialog.children.find(child => child.className === 'prompt-preview')!;
  const modelSelect = dialog.children.find(child => child.textContent === '模型')?.children[0];
  return {input, template, box, pending, modelSelect, created, toast: context.toast};
}

describe('create-Agent model selection', () => {
  it('lists project models and sends the selected model when creating', async () => {
    const ui = await setup({
      submit: true,
      catalog: {model: {provider: 'p', id: 'm'}, models: [{provider: 'p', id: 'm', name: 'Model M'}]}
    });
    expect(ui.modelSelect?.options.map(option => option.textContent)).toEqual(['Pi 默认模型', 'p / Model M']);
    expect(ui.created).toMatchObject({model: {provider: 'p', modelId: 'm'}});
  });

  it('waits for the new directory catalog and preserves a still-available model', async () => {
    const refresh = deferred<unknown>();
    const ui = await setup({
      submit: true,
      catalog: {model: {provider: 'p', id: 'm'}, models: [{provider: 'p', id: 'm'}]},
      modelRefresh: refresh.promise,
      onModal: async (dialog, input, submit) => {
        const select = dialog.children.find(child => child.textContent === '模型')!.children[0];
        input.value = 'subdir';
        input.fire('change');
        expect(submit.disabled).toBe(true);
        expect(select.disabled).toBe(true);
        refresh.resolve({
          models: [
            {provider: 'p', id: 'm'},
            {provider: 'p', id: 'other'}
          ]
        });
        await vi.waitFor(() => expect(submit.disabled).toBe(false));
        expect(select.value).toBe(JSON.stringify(['p', 'm']));
      }
    });
    expect(ui.created).toMatchObject({model: {provider: 'p', modelId: 'm'}, relativeCwd: 'subdir'});
  });

  it('warns when the previous model is not available in the new directory', async () => {
    const refresh = deferred<unknown>();
    const ui = await setup({
      submit: true,
      catalog: {model: {provider: 'p', id: 'm'}, models: [{provider: 'p', id: 'm'}]},
      modelRefresh: refresh.promise,
      onModal: async (dialog, input, submit) => {
        input.value = 'subdir';
        input.fire('change');
        refresh.resolve({models: []});
        await vi.waitFor(() => expect(submit.disabled).toBe(false));
      }
    });
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('所选模型在新工作路径不可用'));
    expect(ui.created).not.toHaveProperty('model');
  });

  it('allows the Pi default when no model catalog is available', async () => {
    const ui = await setup({submit: true});
    expect(ui.modelSelect?.options).toHaveLength(1);
    expect(ui.created).not.toHaveProperty('model');
  });
});

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
