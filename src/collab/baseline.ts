import {execFile, spawn} from 'node:child_process';
import {createHash, type Hash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import type {Readable} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import type {CollabSubject} from './types.js';

const run = promisify(execFile);

export type BaselineSnapshot = {
  vcs: string;
  commit?: string;
  range?: string;
  rangeResolved?: string;
  dirtyHash?: string;
  paths: string[];
};
export type BaselineResolver = (input: {
  cwd: string;
  subject: CollabSubject;
  round: number;
}) => Promise<BaselineSnapshot>;

/** Anchors every round to an immutable code state so round N+1 verdicts are not made against round N's memory. */
export const gitBaseline: BaselineResolver = async ({cwd, subject}) => {
  const git = async (args: string[]) => (await run('git', args, {cwd})).stdout;
  try {
    const commit = (await git(['rev-parse', 'HEAD'])).trim();
    let dirtyHash: string | undefined;
    const status = await git(['status', '--porcelain', '-z']);
    if (status) {
      const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z']))
        .split('\0')
        .filter(Boolean)
        .sort();
      // Hashed as a stream, never buffered. A working tree diff can be tens of megabytes, and a diff dropped for
      // exceeding a buffer would leave a hash of nothing but file names - identical before and after an edit to
      // those same files, which is exactly what `assertBaselineCurrent()` exists to catch.
      const hash = createHash('sha256').update(status);
      await hashStream(
        hash,
        spawn('git', ['diff', 'HEAD', '--binary'], {cwd, stdio: ['ignore', 'pipe', 'ignore']})
      );
      for (const relative of untracked) {
        hash.update(relative).update('\0');
        // A file removed during capture is already represented by status.
        await hashStream(hash, createReadStream(path.join(cwd, relative))).catch(() => {});
      }
      dirtyHash = `sha256:${hash.digest('hex')}`;
    }
    // A commit range such as `main...feature` is only a name: either endpoint can move while HEAD and the
    // working tree stay identical, which would silently change the code under review. Resolve both endpoints
    // so the pinned identity covers the range, not just its spelling.
    let rangeResolved: string | undefined;
    if (subject.type === 'commit_range') {
      const expression = subject.value.trim();
      const endpoints = expression.includes('...')
        ? expression.split('...')
        : expression.includes('..')
          ? expression.split('..')
          : [expression];
      const resolved: string[] = [];
      for (const endpoint of endpoints) {
        const name = endpoint.trim();
        resolved.push(
          name
            ? (await git(['rev-parse', '--verify', `${name}^{commit}`]).catch(() => '')).trim() ||
                `unresolved:${name}`
            : 'HEAD'
        );
      }
      rangeResolved = resolved.join('...');
    }
    return {
      vcs: 'git',
      commit,
      range: subject.type === 'commit_range' ? subject.value : undefined,
      rangeResolved,
      dirtyHash,
      paths:
        subject.type === 'paths'
          ? subject.value
              .split(/[\n,]/)
              .map(value => value.trim())
              .filter(Boolean)
          : []
    };
  } catch {
    // Not a git checkout (or git is missing). The hub still works; it just cannot prove code identity.
    return {vcs: 'none', paths: []};
  }
};
/** Feeds one stream into a hash, rejecting on failure so a partial read can never pass as "nothing changed". */
function hashStream(hash: Hash, source: Readable | ChildProcess) {
  const process = 'stdout' in source ? source : undefined,
    stream = (process ? process.stdout : source) as Readable | null;
  return new Promise<void>((resolve, reject) => {
    if (!stream) return reject(new Error('Stream is not readable'));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    if (!process) return void stream.on('end', resolve);
    process.on('error', reject);
    process.on('close', code => (code === 0 ? resolve() : reject(new Error(`git exited with ${code}`))));
  });
}
