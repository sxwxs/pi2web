import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {getAgentDir,hasTrustRequiringProjectResources,ProjectTrustStore} from '@earendil-works/pi-coding-agent';

/**
 * Read-only view of the MCP servers Pi would use for a working directory, plus the one change that is
 * safe to make remotely: turning a server on or off.
 *
 * Pi 0.99+ reads `mcp.json` from the agent directory and, for trusted projects, from `<cwd>/.pi/mcp.json`;
 * a project entry without `command`, `url`, or `type` only overrides `enabled`, `exposure` and
 * `toolExposure` of the global server with the same name. The files are read and written here instead of
 * through Pi, which keeps those functions internal. A session reads them when it starts, so a change
 * applies the next time an Agent is loaded.
 */
export type McpServerSummary={
  name:string,
  enabled:boolean,
  exposure:string,
  transport:'stdio'|'http',
  /** The command or URL the server is reached with, without headers, secrets or environment values. */
  target:string,
  description?:string,
  scope:'global'|'project',
  source:string,
  /** Project `mcp.json` that overrides this global server. */
  override?:string
};
export type McpOverview={servers:McpServerSummary[],globalConfig:string,projectConfig?:string,projectTrusted:boolean,errors:string[]};
type Entry={name:string,config:Record<string,unknown>,scope:'global'|'project',source:string,override?:string};

const globalConfigPath=()=>path.join(getAgentDir(),'mcp.json');
const projectConfigPath=(cwd:string)=>path.join(cwd,'.pi','mcp.json');
/** A project entry without transport fields only overrides settings of the global server. */
const isOverrideOnly=(config:Record<string,unknown>)=>config.command===undefined&&config.url===undefined&&config.type===undefined;

function readConfig(file:string,errors:string[]):Record<string,Record<string,unknown>>{
  let text:string;
  try{text=readFileSync(file,'utf8')}catch{return {}}
  try{
    const value=JSON.parse(text)?.mcpServers;
    if(!value||typeof value!=='object')return {};
    // One malformed entry must not hide the servers next to it.
    const servers:Record<string,Record<string,unknown>>={};
    for(const [name,config] of Object.entries(value as Record<string,unknown>)){
      if(config&&typeof config==='object'&&!Array.isArray(config))servers[name]=config as Record<string,unknown>;
      else errors.push(`${file}: “${name}” is not a server configuration`);
    }
    return servers;
  }catch(error){errors.push(`${file}: ${(error as Error).message}`);return {}}
}

function summarize(entry:Entry):McpServerSummary{
  const config=entry.config,http=typeof config.url==='string';
  return {
    name:entry.name,
    enabled:config.enabled!==false,
    exposure:typeof config.exposure==='string'?config.exposure:'codemode',
    transport:http?'http':'stdio',
    target:http?String(config.url):[config.command,...(Array.isArray(config.args)?config.args:[])].filter(Boolean).join(' ').trim(),
    description:typeof config.description==='string'?config.description:undefined,
    scope:entry.scope,
    source:entry.source,
    override:entry.override
  };
}

function load(cwd:string){
  const errors:string[]=[],globalFile=globalConfigPath(),projectFile=projectConfigPath(cwd);
  let projectTrusted=false,explicitlyTrusted=false;
  // Pi only reads project files such as .pi/mcp.json after the project was trusted interactively.
  // A project without trust-requiring resources is read, but writing one into it would make Pi ask
  // for trust first, so project overrides are only written where trust was actually granted.
  try{
   explicitlyTrusted=new ProjectTrustStore(getAgentDir()).get(cwd)===true;
   projectTrusted=explicitlyTrusted||!hasTrustRequiringProjectResources(cwd);
  }catch{/* Untrusted is the safe default. */}
  const globals=readConfig(globalFile,errors),project=projectTrusted?readConfig(projectFile,errors):{};
  const entries=new Map<string,Entry>();
  for(const [name,config] of Object.entries(globals))entries.set(name,{name,config,scope:'global',source:globalFile});
  for(const [name,config] of Object.entries(project)){
    const existing=entries.get(name);
    if(existing&&isOverrideOnly(config))entries.set(name,{...existing,config:{...existing.config,...config},override:projectFile});
    else entries.set(name,{name,config,scope:'project',source:projectFile});
  }
  return {entries:[...entries.values()],globalFile,projectFile:projectTrusted?projectFile:undefined,projectTrusted,explicitlyTrusted,errors};
}

/** Every configured MCP server for `cwd`, including disabled ones. */
export function listMcpServers(cwd:string):McpOverview{
  const config=load(cwd);
  return {servers:config.entries.map(summarize),globalConfig:config.globalFile,projectConfig:config.projectFile,projectTrusted:config.projectTrusted,errors:config.errors};
}

/** Write one server's `enabled` flag into `file`, keeping the rest of the file as it is. */
function writeEnabled(file:string,name:string,enabled:boolean,explicit=false){
  // Only a missing file starts a new one: a file that cannot be read or parsed must not be overwritten.
  let text:string|undefined;
  try{text=readFileSync(file,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const document:Record<string,any>=text?.trim()?JSON.parse(text):{};
  const servers=document.mcpServers&&typeof document.mcpServers==='object'?document.mcpServers:(document.mcpServers={});
  const current=servers[name]&&typeof servers[name]==='object'?servers[name]:(servers[name]={});
  // `enabled: true` is the default, so it is dropped where the server itself is defined. A project
  // override only changes what it states, so there the flag is always written out.
  if(enabled&&!explicit)delete current.enabled; else current.enabled=enabled;
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,`${JSON.stringify(document,null,2)}\n`);
}

/**
 * Enable or disable one server. A global server is changed with a project override when the project is
 * trusted, which keeps the change local to this project, and in the global file otherwise.
 */
export function setMcpServerEnabled(cwd:string,name:string,enabled:boolean):McpOverview{
  const config=load(cwd);
  const entry=config.entries.find(item=>item.name===name);
  if(!entry)throw Object.assign(new Error('MCP server not found'),{code:'MCP_SERVER_NOT_FOUND'});
  const asOverride=entry.scope==='global'&&config.explicitlyTrusted&&!!config.projectFile;
  writeEnabled(asOverride?config.projectFile!:entry.source,name,enabled,asOverride);
  return listMcpServers(cwd);
}
