import {getAgentDir, parseFrontmatter} from '@earendil-works/pi-coding-agent';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * A Pi prompt template from the global prompts directory (`~/.pi/agent/prompts/<name>.md`). The file name is
 * the slash command, so the same template works as `/name` in the Pi CLI and in the web composer.
 * Names are case-insensitive on every file system: `Review` and `review` are the same template.
 */
export type PromptTemplate = {
  name: string;
  /** Front matter `description`; empty when the file has none (Pi then shows its first line). */
  description: string;
  argumentHint?: string;
  content: string;
  updatedAt: string;
};
export type PromptTemplateInput = {description?: unknown; argumentHint?: unknown; content?: unknown};

const MAX_CONTENT = 100_000;
// A command name has no whitespace (Pi splits `/name args` there) and must be a portable file name.
const NAME = /^[^\s\\/:*?"<>|.][^\s\\/:*?"<>|]{0,63}$/u;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_REQUEST'});
const notFound = (name: string) =>
  Object.assign(new Error(`Prompt template not found: ${name}`), {code: 'PROMPT_TEMPLATE_NOT_FOUND'});
export const validPromptTemplateName = (name: unknown): name is string =>
  typeof name === 'string' && NAME.test(name) && !name.endsWith('.') && !RESERVED.test(name);
const singleLine = (value: unknown, field: string, max: number) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const text = value.trim();
  if (text.length > max || /[\r\n]/.test(text))
    throw invalid(`${field} must be a single line of at most ${max} characters`);
  return text;
};

/** Front matter values are written as JSON, which is valid YAML, so any value Pi parsed is written back unchanged. */
export function formatPromptTemplateFile(frontmatter: Record<string, unknown>, content: string) {
  const entries = Object.entries(frontmatter).filter(([, value]) => value !== undefined && value !== '');
  // A body starting with `---` would be read as front matter, so it always gets a header of its own.
  if (!entries.length && !content.startsWith('---')) return `${content}\n`;
  if (!entries.length) entries.push(['description', '']);
  return [
    '---',
    ...entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    '---',
    '',
    content,
    ''
  ].join('\n');
}

export class PromptTemplateStore {
  /** The directory is resolved on every call so `PI_CODING_AGENT_DIR` behaves exactly as it does for Pi. */
  constructor(private readonly dirOf: () => string = () => path.join(getAgentDir(), 'prompts')) {}
  get dir() {
    return this.dirOf();
  }
  private fileFor(name: string) {
    if (!validPromptTemplateName(name))
      throw invalid('Template name must be 1-64 characters without spaces or \\ / : * ? " < > |');
    return path.join(this.dir, `${name}.md`);
  }
  /** The existing file of template `name`, matched case-insensitively. */
  private find(name: string) {
    this.fileFor(name);
    const dir = this.dir,
      wanted = `${name}.md`.toLowerCase(),
      entry = existsSync(dir) ? readdirSync(dir).find(file => file.toLowerCase() === wanted) : undefined;
    return entry ? path.join(dir, entry) : undefined;
  }
  private parse(file: string) {
    try {
      return parseFrontmatter<Record<string, unknown>>(readFileSync(file, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`Invalid front matter in ${file}: ${(error as Error).message}`), {
        code: 'INVALID_PROMPT_TEMPLATE'
      });
    }
  }
  private read(name: string, file: string): PromptTemplate {
    const {frontmatter, body} = this.parse(file),
      argumentHint = frontmatter['argument-hint'];
    return {
      name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      ...(typeof argumentHint === 'string' && argumentHint.trim() ? {argumentHint: argumentHint.trim()} : {}),
      content: body.trim(),
      updatedAt: statSync(file).mtime.toISOString()
    };
  }
  /** Re-read on every call, so templates written by the Pi CLI or by hand show up immediately. */
  list(): {templates: PromptTemplate[]; errors: string[]} {
    const dir = this.dir;
    if (!existsSync(dir)) return {templates: [], errors: []};
    const templates: PromptTemplate[] = [],
      errors: string[] = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (!entry.name.endsWith('.md') || !(entry.isFile() || entry.isSymbolicLink())) continue;
      const name = entry.name.slice(0, -3);
      if (!validPromptTemplateName(name)) {
        errors.push(`Ignored ${entry.name}: the name cannot be used from the web composer`);
        continue;
      }
      try {
        templates.push(this.read(name, path.join(dir, entry.name)));
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    templates.sort((a, b) => a.name.localeCompare(b.name));
    return {templates, errors};
  }
  get(name: string): PromptTemplate {
    const file = this.find(name);
    if (!file) throw notFound(name);
    return this.read(path.basename(file, '.md'), file);
  }
  /**
   * Write template `name`. `editing` names the template being edited (absent: a new one); a different
   * name renames it. Replacing any other existing template requires `overwrite`, so a second device
   * cannot silently clobber a template it has not seen. An existing template is written in place and
   * keeps its file name, so changing only the case of a name does not rename it. Front matter keys the
   * web UI does not edit are kept.
   */
  save(name: string, input: PromptTemplateInput, options: {editing?: string; overwrite?: boolean} = {}) {
    const file = this.fileFor(name),
      editingFile = options.editing ? this.find(options.editing) : undefined;
    if (typeof input.content !== 'string' || !input.content.trim()) throw invalid('content is required');
    const content = input.content.replace(/\r\n?/g, '\n').trim();
    if (content.length > MAX_CONTENT) throw invalid('content is too long');
    const description = singleLine(input.description, 'description', 500),
      argumentHint = singleLine(input.argumentHint, 'argumentHint', 200);
    if (options.editing && !editingFile) throw notFound(options.editing);
    const existing = this.find(name);
    if (existing && existing !== editingFile && !options.overwrite)
      throw Object.assign(new Error(`Prompt template already exists: ${name}`), {
        code: 'PROMPT_TEMPLATE_EXISTS'
      });
    const kept = editingFile ? this.parse(editingFile).frontmatter : {};
    const frontmatter: Record<string, unknown> = {
      ...kept,
      description,
      ...(input.argumentHint !== undefined ? {'argument-hint': argumentHint} : {})
    };
    const target = existing ?? file;
    mkdirSync(this.dir, {recursive: true});
    writeFileSync(target, formatPromptTemplateFile(frontmatter, content), 'utf8');
    if (editingFile && editingFile !== target) rmSync(editingFile, {force: true});
    return this.read(path.basename(target, '.md'), target);
  }
  remove(name: string) {
    const file = this.find(name);
    if (!file) throw notFound(name);
    rmSync(file);
  }
}
