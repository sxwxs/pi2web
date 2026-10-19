import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export type AuthFile = {
  tokenHash: string;
  createdAt: string;
  rotatedAt?: string;
  voiceTokenHash?: string;
  voiceTokenCreatedAt?: string;
};

const hash = (token:string) => createHash('sha256').update(token).digest('hex');
const validateToken = (token:string) => {
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(token)) {
    throw Object.assign(
      new Error('Access token must be 16-128 URL-safe characters (letters, digits, dot, underscore, tilde or hyphen)'),
      {code:'INVALID_ACCESS_TOKEN'},
    );
  }
};

export type AuthRole = 'full' | 'voice';

export class AuthStore {
  constructor(private readonly dir:string) {}

  private get file() {
    return path.join(this.dir, 'auth.json');
  }

  async init():Promise<{token?:string}> {
    await mkdir(this.dir, {recursive:true});
    try {
      await readFile(this.file);
      return {};
    } catch {
      const token = randomBytes(32).toString('base64url');
      await this.save({tokenHash:hash(token), createdAt:new Date().toISOString()});
      return {token};
    }
  }

  private async save(data:AuthFile) {
    await mkdir(this.dir, {recursive:true});
    await writeFile(this.file, JSON.stringify(data, null, 2) + '\n', {mode:0o600});
    await chmod(this.file, 0o600);
  }

  async verify(token:string) {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
      const actual = Buffer.from(hash(token));
      const expected = Buffer.from(data.tokenHash);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /** Only the pairing code verifies as a full-power token. */
  async role(token:string):Promise<AuthRole|undefined> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
      const same = (expected?:string) => {
        if (!expected) return false;
        const actual = Buffer.from(hash(token)), stored = Buffer.from(expected);
        return actual.length === stored.length && timingSafeEqual(actual, stored);
      };
      if (same(data.tokenHash)) return 'full';
      if (same(data.voiceTokenHash)) return 'voice';
    } catch { /* absent credential */ }
    return undefined;
  }

  async rotateVoice() {
    const old = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
    const token = randomBytes(32).toString('base64url');
    await this.save({...old, voiceTokenHash:hash(token), voiceTokenCreatedAt:new Date().toISOString()});
    return token;
  }

  async revokeVoice() {
    const old = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
    delete old.voiceTokenHash;
    delete old.voiceTokenCreatedAt;
    await this.save(old);
  }

  async rotate() {
    const token = randomBytes(32).toString('base64url');
    const old = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
    await this.save({...old, tokenHash:hash(token), rotatedAt:new Date().toISOString()});
    return token;
  }

  async setToken(token:string) {
    validateToken(token);
    let data:AuthFile;
    try {
      data = JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
    } catch {
      await this.save({tokenHash:hash(token), createdAt:new Date().toISOString()});
      return;
    }
    await this.save({...data, tokenHash:hash(token), rotatedAt:new Date().toISOString()});
  }
}
