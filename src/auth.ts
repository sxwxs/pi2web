import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** `voiceTokenHash` is an optional second credential with the restricted `voice` role (see voice-api.ts). */
export type AuthFile={tokenHash:string,createdAt:string,rotatedAt?:string,voiceTokenHash?:string,voiceTokenCreatedAt?:string};
export type AuthRole='full'|'voice';
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const same=(token:string,expectedHash:string|undefined)=>{if(!expectedHash)return false;const a=Buffer.from(hash(token)),b=Buffer.from(expectedHash);return a.length===b.length&&timingSafeEqual(a,b)};
export class AuthStore {
  constructor(private readonly dir:string){ }
  private get file(){return path.join(this.dir,'auth.json')}
  async init():Promise<{token?:string}> { await mkdir(this.dir,{recursive:true}); try {await readFile(this.file); return {};} catch { const token=randomBytes(32).toString('base64url'); await this.save({tokenHash:hash(token),createdAt:new Date().toISOString()}); return {token}; } }
  private async save(data:AuthFile){await writeFile(this.file,JSON.stringify(data,null,2)+'\n',{mode:0o600}); await chmod(this.file,0o600)}
  private async read(){return JSON.parse(await readFile(this.file,'utf8')) as AuthFile}
  /** True only for the full-power pairing code. The restricted voice token never passes this (collab "human" checks rely on it). */
  async verify(token:string){try {return same(token,(await this.read()).tokenHash)}catch{return false}}
  /** Resolves a bearer token to its role: `full` (pairing code), `voice` (restricted voice token) or undefined. */
  async role(token:string):Promise<AuthRole|undefined>{try{const data=await this.read();if(same(token,data.tokenHash))return 'full';if(same(token,data.voiceTokenHash))return 'voice'}catch{}return undefined}
  async rotate(){const token=randomBytes(32).toString('base64url'); const old=await this.read(); await this.save({...old,tokenHash:hash(token),rotatedAt:new Date().toISOString()});return token}
  /** Creates (or replaces) the restricted voice token; the previous one stops working immediately. The plaintext is returned once. */
  async rotateVoice(){const token=randomBytes(32).toString('base64url'); const old=await this.read(); await this.save({...old,voiceTokenHash:hash(token),voiceTokenCreatedAt:new Date().toISOString()});return token}
  async revokeVoice(){const old=await this.read(); delete old.voiceTokenHash; delete old.voiceTokenCreatedAt; await this.save(old)}
}
