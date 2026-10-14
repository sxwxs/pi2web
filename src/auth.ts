import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export type AuthFile={tokenHash:string,createdAt:string,rotatedAt?:string};
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
export class AuthStore {
  constructor(private readonly dir:string){ }
  private get file(){return path.join(this.dir,'auth.json')}
  async init():Promise<{token?:string}> { await mkdir(this.dir,{recursive:true}); try {await readFile(this.file); return {};} catch { const token=randomBytes(32).toString('base64url'); await this.save({tokenHash:hash(token),createdAt:new Date().toISOString()}); return {token}; } }
  private async save(data:AuthFile){await writeFile(this.file,JSON.stringify(data,null,2)+'\n',{mode:0o600}); await chmod(this.file,0o600)}
  async verify(token:string){try {const data=JSON.parse(await readFile(this.file,'utf8')) as AuthFile; const a=Buffer.from(hash(token));const b=Buffer.from(data.tokenHash);return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}}
  async rotate(){const token=randomBytes(32).toString('base64url'); const old=JSON.parse(await readFile(this.file,'utf8')) as AuthFile; await this.save({...old,tokenHash:hash(token),rotatedAt:new Date().toISOString()});return token}
  /** Stores a caller-chosen pairing code with the same hash format as init()/rotate(). */
  async setToken(token:string){
    const value=token.trim();
    if(!/^\S{16,128}$/.test(value))throw Object.assign(new Error('Access token must be 16-128 characters without whitespace'),{code:'INVALID_ACCESS_TOKEN'});
    let data:AuthFile;
    try{data=JSON.parse(await readFile(this.file,'utf8')) as AuthFile}
    catch{data={tokenHash:hash(value),createdAt:new Date().toISOString()};await this.save(data);return}
    await this.save({...data,tokenHash:hash(value),rotatedAt:new Date().toISOString()});
  }
}
