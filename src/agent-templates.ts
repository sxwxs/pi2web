import {getAgentDir, parseFrontmatter} from '@earendil-works/pi-coding-agent';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * How a template's text is combined with Pi's system prompt.
 * - `replace`: replaces Pi's base prompt (the built-in preamble, tool list, rules and docs, or `SYSTEM.md`),
 *   exactly like Pi's own `SYSTEM.md` / `--system-prompt`.
 * - `append`: appended after Pi's base prompt and `APPEND_SYSTEM.md`, like `--append-system-prompt`.
 * Either way Pi still adds project context files (AGENTS.md), skills and the working directory.
 */
export type AgentTemplateMode = 'replace' | 'append';
export type AgentTemplate = {
  id: string;
  name: string;
  description: string;
  mode: AgentTemplateMode;
  systemPrompt: string;
  file: string;
  updatedAt: string;
};
/**
 * What an Agent keeps of its template. It is copied at creation time and never changes afterwards, so
 * editing or deleting the template file cannot silently change the behaviour of an existing Agent.
 */
export type AgentTemplateSnapshot = Pick<AgentTemplate, 'id' | 'name' | 'mode' | 'systemPrompt'>;
export type AgentTemplateInput = {
  name?: unknown;
  description?: unknown;
  mode?: unknown;
  systemPrompt?: unknown;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROMPT = 200_000;
const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_REQUEST'});
export const validTemplateId = (id: unknown): id is string =>
  typeof id === 'string' && ID.test(id) && !id.endsWith('.') && id !== 'default';
const asMode = (value: unknown): AgentTemplateMode | undefined =>
  value === 'replace' || value === 'append' ? value : undefined;

/** Serialize a template as Markdown with YAML front matter; JSON strings are valid YAML scalars. */
export const formatTemplateFile = (
  template: Pick<AgentTemplate, 'name' | 'description' | 'mode' | 'systemPrompt'>
) =>
  [
    '---',
    `name: ${JSON.stringify(template.name)}`,
    ...(template.description ? [`description: ${JSON.stringify(template.description)}`] : []),
    `mode: ${template.mode}`,
    '---',
    '',
    template.systemPrompt.trim(),
    ''
  ].join('\n');

/**
 * Agent templates are plain files under `<data-dir>/agent-templates/<id>.md` so they can be shared by copying:
 *
 * ```markdown
 * ---
 * name: Code reviewer
 * description: Reviews diffs, never edits files
 * mode: replace        # or append
 * ---
 * You are a meticulous code reviewer...
 * ```
 *
 * Files are re-read on every call, so templates dropped into the directory by hand show up immediately.
 */
export class AgentTemplateStore {
  constructor(readonly dir: string) {}
  private fileFor(id: string) {
    if (!validTemplateId(id))
      throw invalid('Template id must be 1-64 letters, digits, dot, underscore or hyphen');
    return path.join(this.dir, `${id}.md`);
  }
  private read(id: string, file: string): AgentTemplate {
    const raw = readFileSync(file, 'utf8');
    let frontmatter: Record<string, unknown> = {},
      body = raw;
    try {
      ({frontmatter, body} = parseFrontmatter<Record<string, unknown>>(raw));
    } catch (error) {
      throw Object.assign(new Error(`Invalid front matter in ${file}: ${(error as Error).message}`), {
        code: 'INVALID_TEMPLATE'
      });
    }
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : id;
    return {
      id,
      name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      mode: asMode(frontmatter.mode) ?? 'append',
      systemPrompt: body.trim(),
      file,
      updatedAt: statSync(file).mtime.toISOString()
    };
  }
  list(): {templates: AgentTemplate[]; errors: string[]} {
    if (!existsSync(this.dir)) return {templates: [], errors: []};
    const templates: AgentTemplate[] = [],
      errors: string[] = [];
    for (const entry of readdirSync(this.dir, {withFileTypes: true})) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!validTemplateId(id)) {
        errors.push(`Ignored ${entry.name}: invalid template id`);
        continue;
      }
      try {
        templates.push(this.read(id, path.join(this.dir, entry.name)));
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    templates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {templates, errors};
  }
  get(id: string): AgentTemplate {
    const file = this.fileFor(id);
    if (!existsSync(file))
      throw Object.assign(new Error(`Agent template not found: ${id}`), {code: 'TEMPLATE_NOT_FOUND'});
    return this.read(id, file);
  }
  save(id: string, input: AgentTemplateInput): AgentTemplate {
    const file = this.fileFor(id);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id;
    if (name.length > 100 || /[\r\n]/.test(name))
      throw invalid('name must be a single line of at most 100 characters');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length > 500 || /[\r\n]/.test(description))
      throw invalid('description must be a single line of at most 500 characters');
    const mode = asMode(input.mode);
    if (!mode) throw invalid('mode must be replace or append');
    if (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim())
      throw invalid('systemPrompt is required');
    if (input.systemPrompt.length > MAX_PROMPT) throw invalid('systemPrompt is too long');
    mkdirSync(this.dir, {recursive: true});
    writeFileSync(
      file,
      formatTemplateFile({name, description, mode, systemPrompt: input.systemPrompt}),
      'utf8'
    );
    return this.read(id, file);
  }
  remove(id: string) {
    const file = this.fileFor(id);
    if (!existsSync(file))
      throw Object.assign(new Error(`Agent template not found: ${id}`), {code: 'TEMPLATE_NOT_FOUND'});
    rmSync(file);
  }
  snapshot(id: string): AgentTemplateSnapshot {
    const {name, mode, systemPrompt} = this.get(id);
    return {id, name, mode, systemPrompt};
  }
}

/** Pi's own global system-prompt files in the agent directory (`~/.pi/agent`). */
export type PiPromptFileKind = 'system' | 'append';
const PI_PROMPT_FILES: Record<PiPromptFileKind, string> = {system: 'SYSTEM.md', append: 'APPEND_SYSTEM.md'};
export const piPromptFile = (kind: PiPromptFileKind, agentDir = getAgentDir()) =>
  path.join(agentDir, PI_PROMPT_FILES[kind]);
export function readPiPromptFiles(agentDir = getAgentDir()) {
  const read = (kind: PiPromptFileKind) => {
    const file = piPromptFile(kind, agentDir),
      exists = existsSync(file);
    return {path: file, exists, content: exists ? readFileSync(file, 'utf8') : ''};
  };
  return {agentDir, system: read('system'), append: read('append')};
}
/** Write (or, for an empty value, delete) a global Pi prompt file. Deleting SYSTEM.md restores Pi's built-in prompt. */
export function writePiPromptFile(kind: PiPromptFileKind, content: string, agentDir = getAgentDir()) {
  if (content.length > MAX_PROMPT) throw invalid('content is too long');
  const file = piPromptFile(kind, agentDir);
  if (!content.trim()) rmSync(file, {force: true});
  else {
    mkdirSync(agentDir, {recursive: true});
    writeFileSync(file, content, 'utf8');
  }
}
