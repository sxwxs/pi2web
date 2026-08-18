import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gitBaseline} from '../src/collab/hub.js';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=t@example.com','-c','user.name=t',...args],{cwd,stdio:'pipe'});
const capture=(cwd:string)=>gitBaseline({cwd,subject:{type:'free',value:'everything'},round:1});
/** Larger than the 8 MiB buffer the captured diff used to be limited to. */
const huge=(fill:string)=>fill.repeat(9*1024*1024);

describe('git baseline',()=>{
  it('keeps the hash sensitive to content in a working tree too big to buffer',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'collab-baseline-'));
    git(cwd,'init');
    await writeFile(path.join(cwd,'big.txt'),huge('a'));
    git(cwd,'add','.');git(cwd,'commit','-m','initial');

    const clean=await capture(cwd);
    expect(clean).toMatchObject({vcs:'git'});
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirtyHash).toBeUndefined();                       // nothing modified: there is no dirty state to hash

    // Two different edits to the *same* tracked file. `git status` is identical for both, so a baseline that
    // dropped the oversized diff hashed only the file name and called the second edit "unchanged".
    await writeFile(path.join(cwd,'big.txt'),huge('b'));
    const first=await capture(cwd);
    await writeFile(path.join(cwd,'big.txt'),huge('c'));
    const second=await capture(cwd);
    expect(first.dirtyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.dirtyHash).not.toBe(first.dirtyHash);

    // The same must hold for an untracked file, which `status` also reports by name only.
    await writeFile(path.join(cwd,'new.txt'),'first version');
    const added=await capture(cwd);
    await writeFile(path.join(cwd,'new.txt'),'second version');
    const edited=await capture(cwd);
    expect(added.dirtyHash).not.toBe(second.dirtyHash);
    expect(edited.dirtyHash).not.toBe(added.dirtyHash);

    await rm(cwd,{recursive:true,force:true});
  },60_000);

  it('reports no vcs instead of a fake identity outside a checkout',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'collab-nogit-'));
    expect(await capture(cwd)).toMatchObject({vcs:'none',paths:[]});
    await rm(cwd,{recursive:true,force:true});
  });
});
