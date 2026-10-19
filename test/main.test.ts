import {describe,expect,it} from 'vitest';
import {execFile,spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {AuthStore} from '../src/auth.js';

const entry=path.resolve('src/main.ts');
const run=(...args:string[])=>promisify(execFile)(process.execPath,['--import','tsx',entry,...args],{timeout:10_000});

describe('voice token CLI',()=>{
  it('prints a new pairing code to stderr while reserving stdout for the draft token',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'pi2web-voice-cli-'));
    try{
      const first=await run('--data-dir',dir,'--create-voice-token');
      const code=first.stderr.match(/Remote Pi pairing code \(shown once; save it securely\): ([A-Za-z0-9_-]+)/)?.[1];
      expect(code).toBeTruthy();
      expect(first.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(first.stdout).not.toContain(code);
      expect(await new AuthStore(dir).verify(code!)).toBe(true);
      const next=await run('--data-dir',dir,'--create-voice-token');
      expect(next.stderr).not.toContain('Remote Pi pairing code');
      expect(next.stdout.trim()).not.toBe(first.stdout.trim());
    }finally{await rm(dir,{recursive:true,force:true})}
  },30_000);
});

describe('no-auth CLI options',()=>{
  it('documents the insecure override in help',async()=>{
    const {stdout}=await run('--help');
    expect(stdout).toContain('--allow-insecure-no-auth');
    expect(stdout).toContain('requires --no-auth; DANGEROUS');
  },20_000);
  it('rejects a non-loopback no-auth bind by default',async()=>{
    await expect(run('--host','0.0.0.0','--no-auth')).rejects.toMatchObject({code:1,stderr:expect.stringContaining('use --allow-insecure-no-auth')});
  },20_000);
  it('rejects the override without --no-auth',async()=>{
    await expect(run('--allow-insecure-no-auth')).rejects.toMatchObject({code:1,stderr:expect.stringContaining('--allow-insecure-no-auth requires --no-auth')});
  },20_000);
  it('passes the override to the server and warns on startup',async()=>{
    const dataDir=await mkdtemp(path.join(tmpdir(),'remote-pi-cli-noauth-'));
    const child=spawn(process.execPath,['--import','tsx',entry,'--host','0.0.0.0','--port','0','--data-dir',dataDir,'--session-naming','off','--no-auth','--allow-insecure-no-auth'],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
    const closed=new Promise<void>(resolve=>child.on('close',()=>resolve()));
    child.on('error',error=>{stderr+=error.message});
    try{
      await expect.poll(()=>stdout,{timeout:10_000}).toMatch(/Remote Pi is ready: http:\/\/0\.0\.0\.0:\d+/);
      const port=stdout.match(/http:\/\/0\.0\.0\.0:(\d+)/)![1];
      const response=await fetch(`http://127.0.0.1:${port}/api/v1/system/status`,{headers:{origin:'https://remote.example'}});
      expect(response.status).toBe(200);expect((await response.json()).data.authRequired).toBe(false);
      expect(stderr).toContain('WARNING: --allow-insecure-no-auth');
      expect(stdout).not.toContain('Remote Pi pairing code');
    }finally{
      child.kill('SIGTERM');await closed;await rm(dataDir,{recursive:true,force:true});
    }
  },15_000);
});
