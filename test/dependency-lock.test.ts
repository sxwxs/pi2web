import {readFileSync, existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// The @earendil-works packages reference each other with caret ranges, so a
// fresh install of pi2web can mix incompatible minors (e.g. pi-coding-agent
// 1.1.0 with pi-codemode 1.3.0, which no longer exports
// MCP_TYPESCRIPT_PREAMBLE) and crash on startup. package-lock.json and
// "overrides" are ignored for published packages, so we guard twice:
//  1. every @earendil-works package in the tree is an exact direct dependency,
//     which npm places before resolving pi-coding-agent's caret ranges;
//  2. npm-shrinkwrap.json is published, for registries that honor it.
const root = new URL('../', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const piPackages = (lock: {packages: Record<string, {version: string; dev?: boolean}>}) =>
  Object.entries(lock.packages)
    .filter(([key, entry]) => /node_modules\/@earendil-works\/[^/]+$/.test(key) && !entry.dev)
    .map(([key, entry]) => ({name: key.slice(key.lastIndexOf('@earendil-works/')), version: entry.version}));

describe('published dependency tree', () => {
  it('ships npm-shrinkwrap.json instead of package-lock.json', () => {
    expect(existsSync(new URL('npm-shrinkwrap.json', root))).toBe(true);
    expect(existsSync(new URL('package-lock.json', root))).toBe(false);
    // npm does not add the shrinkwrap to the tarball when "files" is a whitelist.
    expect(read('package.json').files).toContain('npm-shrinkwrap.json');
  });

  it('keeps the shrinkwrap in sync with package.json', () => {
    const pkg = read('package.json'),
      lock = read('npm-shrinkwrap.json');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  });

  it('pins every @earendil-works package to the pi-coding-agent version as a direct dependency', () => {
    const pkg = read('package.json'),
      lock = read('npm-shrinkwrap.json');
    const expected = pkg.dependencies['@earendil-works/pi-coding-agent'];
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
    const found = piPackages(lock);
    expect(found.length).toBeGreaterThan(1);
    expect(found.filter(({version}) => version !== expected)).toEqual([]);
    const missing = [...new Set(found.map(({name}) => name))].filter(
      name => pkg.dependencies[name] !== expected
    );
    expect(missing).toEqual([]);
  });
});
