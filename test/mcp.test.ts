import {describe,it,expect,afterEach,beforeEach} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {listMcpServers,setMcpServerEnabled} from '../src/mcp.js';
import {ProjectTrustStore} from '@earendil-works/pi-coding-agent';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';

/** The agent directory holds the global mcp.json; PI_CODING_AGENT_DIR keeps these tests off the real one. */
const previousAgentDir=process.env.PI_CODING_AGENT_DIR;
let agentDir='';
beforeEach(async()=>{agentDir=await mkdtemp(path.join(tmpdir(),'remote-pi-agentdir-'));process.env.PI_CODING_AGENT_DIR=agentDir});
let server:RemotePiServer|undefined;
afterEach(async()=>{await server?.stop();server=undefined;if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir});

const globalConfig={mcpServers:{
  docs:{url:'https://example.com/mcp',description:'Docs search'},
  files:{command:'npx',args:['-y','server-filesystem','.'],enabled:false}
}};

describe('MCP server overview',()=>{
  it('lists global servers with their transport and state',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(globalConfig));
    const overview=listMcpServers(cwd);
    expect(overview.servers).toEqual([
      {name:'docs',enabled:true,exposure:'codemode',transport:'http',target:'https://example.com/mcp',description:'Docs search',scope:'global',source:path.join(agentDir,'mcp.json'),override:undefined},
      {name:'files',enabled:false,exposure:'codemode',transport:'stdio',target:'npx -y server-filesystem .',description:undefined,scope:'global',source:path.join(agentDir,'mcp.json'),override:undefined},
    ]);
    expect(overview.errors).toEqual([]);
  });

  it('reports a broken config file instead of failing',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),'{ not json');
    const overview=listMcpServers(cwd);
    expect(overview.servers).toEqual([]);
    expect(overview.errors).toHaveLength(1);
  });

  it('ignores an untrusted project config and writes the flag globally',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(globalConfig));
    // A project mcp.json requires trust, which this project was never given, so it is ignored
    // for reading and must not be written to either.
    await mkdir(path.join(cwd,'.pi'),{recursive:true});
    await writeFile(path.join(cwd,'.pi','mcp.json'),JSON.stringify({mcpServers:{local:{command:'./server'}}}));
    const untrusted=listMcpServers(cwd);
    expect(untrusted.projectTrusted).toBe(false);
    expect(untrusted.servers.map(server=>server.name)).toEqual(['docs','files']);
    expect(setMcpServerEnabled(cwd,'docs',false).servers.find(server=>server.name==='docs')?.enabled).toBe(false);
    const written=JSON.parse(await readFile(path.join(agentDir,'mcp.json'),'utf8'));
    expect(written.mcpServers.docs).toEqual({url:'https://example.com/mcp',description:'Docs search',enabled:false});
    // Enabling again removes the flag instead of writing the default back.
    setMcpServerEnabled(cwd,'docs',true);
    expect(JSON.parse(await readFile(path.join(agentDir,'mcp.json'),'utf8')).mcpServers.docs.enabled).toBeUndefined();
    expect(listMcpServers(cwd).servers.find(server=>server.name==='docs')?.enabled).toBe(true);
    expect(JSON.parse(await readFile(path.join(cwd,'.pi','mcp.json'),'utf8')).mcpServers.local).toEqual({command:'./server'});
  });

  it('keeps a change to a global server inside an explicitly trusted project as an override',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(globalConfig));
    // Trust is granted in Pi's own trust store; without it the change would go to the global file,
    // because writing a project mcp.json would make Pi ask for trust before reading it again.
    new ProjectTrustStore(agentDir).set(cwd,true);
    expect(listMcpServers(cwd).projectTrusted).toBe(true);
    const disabled=setMcpServerEnabled(cwd,'docs',false);
    expect(disabled.servers.find(server=>server.name==='docs')).toMatchObject({enabled:false,scope:'global',override:path.join(cwd,'.pi','mcp.json')});
    expect(JSON.parse(await readFile(path.join(agentDir,'mcp.json'),'utf8')).mcpServers.docs.enabled).toBeUndefined();
    // The override states the value it changes, so re-enabling cannot fall back to the global false.
    setMcpServerEnabled(cwd,'files',true);
    expect(JSON.parse(await readFile(path.join(cwd,'.pi','mcp.json'),'utf8')).mcpServers).toEqual({docs:{enabled:false},files:{enabled:true}});
    expect(listMcpServers(cwd).servers.find(server=>server.name==='files')?.enabled).toBe(true);
  });

  it('keeps the valid servers of a config with a malformed entry',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{broken:null,docs:{url:'https://example.com/mcp'}}}));
    const overview=listMcpServers(cwd);
    expect(overview.servers.map(server=>server.name)).toEqual(['docs']);
    expect(overview.errors).toHaveLength(1);
  });

  it('refuses to overwrite a config file it cannot parse',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    await writeFile(path.join(agentDir,'mcp.json'),'{ not json');
    expect(()=>setMcpServerEnabled(cwd,'docs',false)).toThrow();
    expect(await readFile(path.join(agentDir,'mcp.json'),'utf8')).toBe('{ not json');
  });

  it('rejects an unknown server',async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),'remote-pi-mcp-'));
    expect(()=>setMcpServerEnabled(cwd,'missing',false)).toThrow(/not found/);
  });

  it('serves the overview and toggles over the agent API',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'remote-pi-')),root=await mkdtemp(path.join(tmpdir(),'remote-pi-ws-'));
    await writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(globalConfig));
    const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd));
    server=new RemotePiServer({port:0,dataDir:dir,workspaces,agents});
    const {token}=await server.auth.init(),address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const post=(url:string,body={})=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
    const workspace=(await (await post('/api/v1/workspaces',{label:'x',rootPath:root})).json()).data;
    const agent=(await (await post('/api/v1/agents',{workspaceId:workspace.id})).json()).data;
    const listed=(await (await fetch(base+`/api/v1/agents/${agent.agentId}/mcp`,{headers})).json()).data;
    expect(listed.servers.map((server:any)=>server.name)).toEqual(['docs','files']);
    const updated=(await (await post(`/api/v1/agents/${agent.agentId}/mcp`,{name:'files',enabled:true})).json()).data;
    expect(updated.servers.find((server:any)=>server.name==='files').enabled).toBe(true);
    expect((await post(`/api/v1/agents/${agent.agentId}/mcp`,{name:'files'})).status).toBe(400);
    expect((await post(`/api/v1/agents/${agent.agentId}/mcp`,{name:'nope',enabled:false})).status).toBe(404);
  });
});
