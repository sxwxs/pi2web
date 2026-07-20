import path from 'node:path';
import { lstat, realpath, readdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export type Workspace={id:string,label:string,rootPath:string,createdAt:string};
export class WorkspaceStore {
 constructor(private items:Workspace[]=[]) {}
 list(){return this.items.map(x=>({...x}))}
 replace(items:Workspace[]){this.items=items.map(item=>({...item,rootPath:path.resolve(item.rootPath)}))}
 add(label:string,rootPath:string){const root=path.resolve(rootPath); const item={id:randomUUID(),label,rootPath:root,createdAt:new Date().toISOString()};this.items.push(item);return item}
 get(id:string){return this.items.find(x=>x.id===id)}
 async resolve(ws:Workspace, relative='.') { const candidate=path.resolve(ws.rootPath,relative); const root=await realpath(ws.rootPath); let actual:string; try{actual=await realpath(candidate)}catch{throw Object.assign(new Error('Path does not exist'),{code:'PATH_NOT_FOUND'})} if(actual!==root&&!actual.startsWith(root+path.sep))throw Object.assign(new Error('Path is outside the workspace root'),{code:'WORKSPACE_PATH_OUTSIDE_ROOT'}); return actual }
 async tree(id:string,relative='.') {const ws=this.get(id);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});const dir=await this.resolve(ws,relative);if(!(await stat(dir)).isDirectory())throw new Error('Not a directory');const entries=await readdir(dir,{withFileTypes:true});return Promise.all(entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name)).map(async e=>{const p=path.join(dir,e.name);const s=await lstat(p);return {name:e.name,type:e.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtime.toISOString()}}))}
 async stat(id:string,relative='.'){const ws=this.get(id);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});const p=await this.resolve(ws,relative);const s=await lstat(p);return {path:relative,type:s.isDirectory()?'directory':s.isFile()?'file':'other',size:s.size,modifiedAt:s.mtime.toISOString()}}
 async file(id:string,relative:string,offset=0,limit=1024*1024){const ws=this.get(id);if(!ws)throw Object.assign(new Error('Workspace not found'),{code:'WORKSPACE_NOT_FOUND'});if(limit>1024*1024)throw Object.assign(new Error('File limit exceeded'),{code:'FILE_TOO_LARGE'});const p=await this.resolve(ws,relative);const s=await stat(p);if(!s.isFile())throw new Error('Not a file');if(s.size>10*1024*1024)throw Object.assign(new Error('File limit exceeded'),{code:'FILE_TOO_LARGE'});const buf=await readFile(p);const chunk=buf.subarray(offset,offset+limit);const binary=chunk.includes(0);return {path:relative,size:s.size,modifiedAt:s.mtime.toISOString(),binary,content:binary?undefined:chunk.toString('utf8'),offset,limit:chunk.length}}
}
