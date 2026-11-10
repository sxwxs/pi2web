import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import WebSocket from 'ws';
import {parseFrontmatter} from '@earendil-works/pi-coding-agent';
import {PromptTemplateStore, formatPromptTemplateFile} from '../src/prompt-templates.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager, MockBackend} from '../src/agents.js';

const source = readFileSync(new URL('../web/prompt-library.js', import.meta.url), 'utf8');
const window = {} as any;
runInNewContext(source, {window}, {filename: 'web/prompt-library.js'});
const {historyStep, insertText, usesArguments, matches} = window.PromptLibrary;
const temp = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));

describe('composer history navigation', () => {
  const items = ['newest', 'two\nlines', 'oldest'],
    idle = {index: -1, draft: ''},
    at = (value: string, caret = value.length) => ({value, selectionStart: caret, selectionEnd: caret});

  it('walks back on ↑ and forward on ↓, restoring the unsent draft at the end', () => {
    let nav = idle;
    const first = historyStep({items, nav, ...at('my draft')}, 'up');
    expect(first).toEqual({nav: {index: 0, draft: 'my draft'}, value: 'newest', caret: 6});
    nav = first.nav;
    // A recalled multi-line entry keeps the caret on its first line so ↑ keeps going.
    const second = historyStep({items, nav, ...at('newest')}, 'up');
    expect(second).toMatchObject({nav: {index: 1, draft: 'my draft'}, value: 'two\nlines', caret: 0});
    const third = historyStep({items, nav: second.nav, ...at('two\nlines', 0)}, 'up');
    expect(third.value).toBe('oldest');
    expect(historyStep({items, nav: third.nav, ...at('oldest')}, 'up')).toBeNull();
    const back = historyStep({items, nav: third.nav, ...at('oldest')}, 'down');
    expect(back).toMatchObject({value: 'two\nlines', caret: 9});
    const newest = historyStep({items, nav: back.nav, ...at('two\nlines')}, 'down');
    const draft = historyStep({items, nav: newest.nav, ...at('newest')}, 'down');
    expect(draft).toEqual({nav: idle, value: 'my draft', caret: 8});
  });

  it('leaves arrows to the textarea inside multi-line text, with a selection, or when not browsing', () => {
    expect(historyStep({items, nav: idle, ...at('line 1\nline 2')}, 'up')).toBeNull();
    expect(
      historyStep({items, nav: idle, value: 'abc', selectionStart: 0, selectionEnd: 2}, 'up')
    ).toBeNull();
    expect(historyStep({items, nav: idle, ...at('abc')}, 'down')).toBeNull();
    expect(historyStep({items, nav: {index: 1, draft: ''}, ...at('a\nb', 0)}, 'down')).toBeNull();
    expect(historyStep({items: [], nav: idle, ...at('')}, 'up')).toBeNull();
  });

  it('skips an entry equal to what the composer already shows', () => {
    expect(historyStep({items, nav: idle, ...at('newest')}, 'up')?.value).toBe('two\nlines');
  });
});

describe('prompt library helpers', () => {
  it('inserts into the composer without losing typed text', () => {
    expect(insertText('  ', 0, 0, 'template')).toEqual({value: 'template', caret: 8});
    expect(insertText('before after', 7, 7, 'X')).toEqual({value: 'before \nX\nafter', caret: 9});
    expect(insertText('typed', 5, 5, 'X')).toEqual({value: 'typed\nX', caret: 7});
    expect(insertText('a\nb', 2, 2, 'X')).toEqual({value: 'a\nX\nb', caret: 3});
  });

  it('recognizes Pi template arguments and filters by every word', () => {
    expect(usesArguments('Review PR $1 carefully')).toBe(true);
    expect(usesArguments('Use ${@:2} and $ARGUMENTS')).toBe(true);
    expect(usesArguments('Costs $5? no: $x and plain text')).toBe(true);
    expect(usesArguments('No placeholders here')).toBe(false);
    expect(matches('pr review', 'review-ai', 'Critically review PR comments')).toBe(true);
    expect(matches('pr deploy', 'review-ai', 'Critically review PR comments')).toBe(false);
    expect(matches('  ', 'anything')).toBe(true);
  });
});

describe('Pi prompt template store', () => {
  it('reads Pi templates, writes ones Pi parses back, and protects existing files', async () => {
    const dir = await temp('pi2web-prompts-'),
      store = new PromptTemplateStore(() => dir);
    expect(store.list()).toEqual({templates: [], errors: []});
    await writeFile(
      path.join(dir, 'review.md'),
      '---\ndescription: Review a PR\nargument-hint: <pr>\nmodel: fast\n---\nReview PR $1\n'
    );
    await writeFile(path.join(dir, 'plain.md'), 'Just do it\n');
    await writeFile(path.join(dir, 'has space.md'), 'ignored');
    const listed = store.list();
    expect(listed.templates.map(t => [t.name, t.description, t.argumentHint, t.content])).toEqual([
      ['plain', '', undefined, 'Just do it'],
      ['review', 'Review a PR', '<pr>', 'Review PR $1']
    ]);
    expect(listed.errors).toHaveLength(1);

    const saved = store.save('pr-ai-comments', {
      description: '审查 PR 上的 AI 评论',
      content: '批判性地审查\r\n报告'
    });
    expect(saved).toMatchObject({
      name: 'pr-ai-comments',
      description: '审查 PR 上的 AI 评论',
      content: '批判性地审查\n报告'
    });
    const written = await readFile(path.join(dir, 'pr-ai-comments.md'), 'utf8');
    expect(parseFrontmatter(written)).toEqual({
      frontmatter: {description: '审查 PR 上的 AI 评论'},
      body: '批判性地审查\n报告'
    });
    expect(() => store.save('pr-ai-comments', {content: 'other'})).toThrow(/already exists/);
    expect(store.save('pr-ai-comments', {content: 'other'}, {overwrite: true}).content).toBe('other');

    // Editing keeps front matter the web UI does not show, and renaming moves the file.
    const renamed = store.save(
      'review-pr',
      {description: 'Review', content: 'Review PR $1 now'},
      {editing: 'review'}
    );
    expect(renamed.argumentHint).toBe('<pr>');
    expect(parseFrontmatter(await readFile(path.join(dir, 'review-pr.md'), 'utf8')).frontmatter).toEqual({
      description: 'Review',
      'argument-hint': '<pr>',
      model: 'fast'
    });
    expect(store.list().templates.map(t => t.name)).toEqual(['plain', 'pr-ai-comments', 'review-pr']);
    expect(() => store.save('plain', {content: 'x'}, {editing: 'review-pr'})).toThrow(/already exists/);
    expect(() => store.save('bad name', {content: 'x'})).toThrow(/without spaces/);
    expect(() => store.save('../escape', {content: 'x'})).toThrow(/without spaces/);
    expect(() => store.save('empty', {content: '  '})).toThrow(/content is required/);
    store.remove('plain');
    expect(() => store.get('plain')).toThrow(/not found/);
  });

  it('never lets a body that starts with --- be read as front matter', () => {
    const file = formatPromptTemplateFile({}, '---\nnot: yaml\n---\nbody');
    expect(parseFrontmatter(file).body).toBe('---\nnot: yaml\n---\nbody');
    expect(formatPromptTemplateFile({}, 'plain')).toBe('plain\n');
  });
});

describe('prompt library API', () => {
  let server: RemotePiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start() {
    const dataDir = await temp('pi2web-library-'),
      root = await temp('pi2web-library-ws-'),
      promptsDir = path.join(await temp('pi2web-agentdir-'), 'prompts');
    const workspaces = new WorkspaceStore(),
      agents = new AgentManager(workspaces, (id, cwd) => new MockBackend(id, cwd));
    server = new RemotePiServer({
      port: 0,
      noAuth: true,
      dataDir,
      workspaces,
      agents,
      promptTemplates: new PromptTemplateStore(() => promptsDir)
    });
    const address = await server.start(),
      base = `http://127.0.0.1:${address!.port}`;
    const call = async (url: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + url, {
        method,
        headers: {'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      return {status: response.status, body: (await response.json()) as any};
    };
    const workspace = (await call('/api/v1/workspaces', 'POST', {label: 'ws', rootPath: root})).body.data;
    const agent = (await call('/api/v1/agents', 'POST', {workspaceId: workspace.id})).body.data;
    return {base, call, agent, promptsDir};
  }

  it('records every input a person sends, newest first and without duplicates', async () => {
    const {base, call, agent} = await start();
    await call(`/api/v1/agents/${agent.agentId}/prompt`, 'POST', {message: 'first prompt'});
    await call(`/api/v1/agents/${agent.agentId}/bash`, 'POST', {
      command: 'git status',
      excludeFromContext: true
    });
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws');
    await new Promise(resolve => ws.once('open', resolve));
    const acknowledged = new Promise(resolve =>
      ws.on('message', raw => JSON.parse(String(raw)).type === 'command_result' && resolve(undefined))
    );
    ws.send(
      JSON.stringify({type: 'follow-up', requestId: 'r1', agentId: agent.agentId, message: 'via socket'})
    );
    await acknowledged;
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    await call(`/api/v1/agents/${agent.agentId}/prompt`, 'POST', {message: '  first prompt  '});
    const items = (await call('/api/v1/prompt-history')).body.data.items;
    expect(items.map((item: any) => item.text)).toEqual(['first prompt', 'via socket', '!!git status']);
    expect(Date.parse(items[0].usedAt)).toBeGreaterThan(0);
  });

  it('manages Pi prompt templates and reports a name collision as 409', async () => {
    const {call, promptsDir} = await start();
    expect((await call('/api/v1/prompt-templates')).body.data).toEqual({
      dir: promptsDir,
      templates: [],
      errors: []
    });
    const created = await call('/api/v1/prompt-templates/review-ai', 'PUT', {
      description: 'Review AI comments',
      content: 'Read the AI review comments on the PR and report critically.'
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({name: 'review-ai', description: 'Review AI comments'});
    const clash = await call('/api/v1/prompt-templates/review-ai', 'PUT', {content: 'other'});
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('PROMPT_TEMPLATE_EXISTS');
    expect(
      (await call('/api/v1/prompt-templates/review-ai', 'PUT', {content: 'edited', editing: 'review-ai'}))
        .body.data.content
    ).toBe('edited');
    await mkdir(promptsDir, {recursive: true});
    expect((await call('/api/v1/prompt-templates')).body.data.templates).toHaveLength(1);
    expect((await call('/api/v1/prompt-templates/review-ai', 'DELETE')).body.data).toEqual({deleted: true});
    expect((await call('/api/v1/prompt-templates/review-ai')).status).toBe(404);
  });
});
