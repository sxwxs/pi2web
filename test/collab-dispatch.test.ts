import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../src/metadata-store.js';
import {CollabStore} from '../src/collab/store.js';
import {CollabHub,type BaselineResolver} from '../src/collab/hub.js';
import {CollabDispatcher} from '../src/collab/dispatcher.js';
import {RemotePiServer} from '../src/server.js';
import {WorkspaceStore} from '../src/workspaces.js';
import {AgentManager,MockBackend} from '../src/agents.js';
import {MailNotifier} from '../src/mail-notifier.js';

const temp=(prefix:string)=>mkdtemp(path.join(tmpdir(),prefix));
const rid=()=>`req-${randomUUID()}`;

describe('collab dispatcher',()=>{
  let dir:string,metadata:MetadataStore,store:CollabStore,hub:CollabHub,dispatcher:CollabDispatcher;
  let sent:{agentId:string,kind:string,message:string}[],statuses:Map<string,string>;
  const baseline:BaselineResolver=async()=>({vcs:'git',commit:'commit-1',paths:[]});

  beforeEach(async()=>{
    dir=await temp('collab-dispatch-');metadata=new MetadataStore(dir);metadata.init();
    store=new CollabStore(()=>metadata.connection);
    hub=new CollabHub(store,{resolveBaseline:baseline});hub.init();
    sent=[];statuses=new Map();
    dispatcher=new CollabDispatcher(hub,{
      command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},
      agentStatus:agentId=>statuses.get(agentId),
      baseUrl:()=>'http://127.0.0.1:11318',
      delayMs:0
    });
    dispatcher.start();
  });
  afterEach(async()=>{await dispatcher.stop();metadata.close()});

  const session=async()=>hub.createSession({kind:'review',title:'Payment callback review',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~1..HEAD'}},async()=>dir);

  it('wakes a managed agent with its own token and skips repeats of the same task',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-security',binding:{type:'managed',agentId:'agent-1'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({agentId:'agent-1',kind:'prompt'});
    expect(sent[0].message).toContain(reviewer.token);
    expect(sent[0].message).toContain('task now due: file_findings');
    expect(sent[0].message).toContain(created.sessionId);
    // Managed agents are pushed to, so the briefing must not invite them to poll the inbox.
    expect(sent[0].message).toContain('END YOUR TURN');
    expect(sent[0].message).not.toContain('inbox?wait');
    expect(hub.events(created.sessionId).some(event=>event.type==='agent_dispatched')).toBe(true);

    // Re-emitting the very same assignment (same task, phase and round) must not prompt the agent twice.
    (hub as any).dispatch(created.sessionId);
    await dispatcher.drain();
    expect(sent).toHaveLength(1);
  });

  it('tells a managed agent that the session is over instead of leaving it waiting',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',binding:{type:'managed',agentId:'agent-1'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    // A clean review pushes no further task, so without the closing note the agent would wait forever.
    await hub.submitFindings(reviewer.participant,{clientRequestId:rid(),baselineId:(hub.digest(reviewer.participant) as any).baseline.baselineId,findings:[],reviewComplete:true});
    await dispatcher.drain();
    const closing=sent.at(-1)!;
    expect(closing.message).toContain('is finished');
    expect(closing.message).toContain('verdict: approved');
    expect(closing.message).toContain('END YOUR TURN');
    // The credential the hub was holding for the managed agent is dropped once the note is delivered.
    expect(store.getDispatchToken(reviewer.participant.participantId)).toBeUndefined();
  });

  it('queues a busy agent with follow-up and never touches external participants',async()=>{
    const created=await session();
    statuses.set('agent-busy','streaming');
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-busy',binding:{type:'managed',agentId:'agent-busy'}});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer-external',binding:{type:'external'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    expect(sent.map(entry=>entry.agentId)).toEqual(['agent-busy']);
    expect(sent[0].kind).toBe('follow-up');
  });

  it('records a failure instead of dropping the task when the agent cannot be reached',async()=>{
    const created=await session();
    dispatcher=new CollabDispatcher(hub,{command:async()=>{throw Error('Agent is not running')},agentStatus:()=>undefined,baseUrl:()=>'http://127.0.0.1:11318',delayMs:0});
    dispatcher.start();
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',binding:{type:'managed',agentId:'agent-dead'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();

    const failure=hub.events(created.sessionId).find(event=>event.type==='dispatch_failed');
    expect(failure?.payload).toMatchObject({agentId:'agent-dead',reason:'Agent is not running'});
  });

  it('re-wakes a managed agent whose task was queued before a restart',async()=>{
    const created=await session();
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',binding:{type:'managed',agentId:'agent-1'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    await dispatcher.stop();                              // the task is queued while nobody is dispatching
    await hub.openRound(created.sessionId);
    expect(sent).toHaveLength(0);

    const restarted=new CollabDispatcher(hub,{command:async(agentId,kind,message)=>{sent.push({agentId,kind,message})},agentStatus:()=>undefined,baseUrl:()=>'http://127.0.0.1:11318',delayMs:0});
    restarted.start();
    await restarted.drain();
    await restarted.stop();
    expect(sent.map(entry=>entry.agentId)).toEqual(['agent-1']);
  });

  it('rebinds a seat that was registered as external and delivers the task it already had',async()=>{
    const created=await hub.createSession({kind:'review',title:'Payment callback review',workspaceId:'ws-1',subject:{type:'commit_range',value:'HEAD~1..HEAD'},policy:{implementationFirst:true}},async()=>dir);
    // The trap this fixes: an implementer registered as `external` looks assigned in the log but nobody wakes it.
    const impl=hub.addParticipant(created.sessionId,{role:'implementer',displayName:'dev',binding:{type:'external'}});
    hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',binding:{type:'external'}});
    await hub.openRound(created.sessionId);
    await dispatcher.drain();
    expect(sent).toHaveLength(0);

    const rebound=hub.rebindParticipant(created.sessionId,impl.participant.participantId,{agentId:'agent-dev'});
    await dispatcher.drain();
    expect(rebound.participant.binding).toEqual({type:'managed',agentId:'agent-dev'});
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe('agent-dev');
    expect(sent[0].message).toContain('task now due: implement');
    expect(sent[0].message).toContain(rebound.token);        // the rotated token, not the one handed out at registration
    expect(store.findParticipantByToken(impl.token)).toBeUndefined();
  });

  it('refuses an external binding that carries an agentId instead of silently ignoring it',async()=>{
    const created=await session();
    expect(()=>hub.addParticipant(created.sessionId,{role:'implementer',displayName:'dev',binding:{type:'external',agentId:'agent-1'}}))
      .toThrow(/binding\.agentId/);
  });

  it('releases a long-polling inbox as soon as a task arrives',async()=>{
    const created=await session();
    const reviewer=hub.addParticipant(created.sessionId,{role:'reviewer',displayName:'reviewer',binding:{type:'external'}});
    hub.addParticipant(created.sessionId,{role:'implementer',displayName:'impl',binding:{type:'external'}});
    const waiting=hub.inboxWait(reviewer.participant,30);
    const started=Date.now();
    await hub.openRound(created.sessionId);
    const items=await waiting;
    expect(Date.now()-started).toBeLessThan(5000);
    expect(items.map(item=>item.type)).toContain('file_findings');
    // An empty inbox with wait=0 still returns immediately.
    await hub.ackInbox(reviewer.participant,items.map(item=>item.itemId));
    expect(await hub.inboxWait(reviewer.participant,0)).toEqual([]);
  });
});

describe('collaboration wiring over HTTP',()=>{
  let server:RemotePiServer|undefined;
  afterEach(async()=>{await server?.stop();server=undefined});

  it('wakes a managed pi2web agent and mails the human when an escalation is raised',async()=>{
    const dataDir=await temp('remote-pi-collab-wire-'),root=await temp('collab-ws-');
    const mails:any[]=[];
    const mailNotifier=new MailNotifier({endpoint:'https://mail.example/send',apiKey:'key',recipient:'owner@example.com'},
      (async(_url:any,init:any)=>{mails.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true}),{status:200})}) as any);
    const workspaces=new WorkspaceStore(),agents=new AgentManager(workspaces,(id,cwd)=>new MockBackend(id,cwd));
    server=new RemotePiServer({port:0,dataDir,workspaces,agents,mailNotifier});
    const auth=await server.auth.init(),address=await server.start();
    const base=`http://127.0.0.1:${address!.port}`,human=auth.token!;
    const call=async(method:string,url:string,body?:unknown,token=human)=>{
      const response=await fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const payload:any=await response.json().catch(()=>({}));
      return {status:response.status,data:payload.data,error:payload.error};
    };

    const workspace=(await call('POST','/api/v1/workspaces',{label:'w',rootPath:root})).data;
    const agent=(await call('POST','/api/v1/agents',{workspaceId:workspace.id})).data;
    const sessionId=(await call('POST','/api/v1/collab/sessions',{kind:'review',title:'Managed dispatch review',workspaceId:workspace.id,subject:{type:'free',value:'everything'}})).data.sessionId;
    const managed=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'reviewer',displayName:'reviewer-managed',binding:{type:'managed',agentId:agent.agentId}})).data;
    expect(managed.participantToken).toMatch(/^cpt_/);
    const implementer=(await call('POST',`/api/v1/collab/sessions/${sessionId}/participants`,{role:'implementer',displayName:'impl',binding:{type:'external'}})).data;
    await call('POST',`/api/v1/collab/sessions/${sessionId}/advance`,{});

    // The managed reviewer must have been prompted by the hub, with a usable participant token.
    const prompt=await waitFor(async()=>{
      const messages=await agents.messages(agent.agentId) as any[];
      return messages.map(entry=>String(entry.content??'')).find(text=>text.includes('pi2web collaboration hub'));
    });
    expect(prompt).toContain(managed.participantToken);
    expect(prompt).toContain('task now due: file_findings');
    expect(prompt).toContain(`${base}/api/v1/collab/sessions/${sessionId}`);

    // A long poll returns the queued task for an external participant.
    const inbox=(await call('GET',`/api/v1/collab/sessions/${sessionId}/inbox?wait=5`,undefined,implementer.participantToken));
    expect(inbox.status).toBe(200);

    const escalation=await call('POST',`/api/v1/collab/sessions/${sessionId}/escalations`,{clientRequestId:rid(),kind:'other',
      summary:'The reviewer and the implementer cannot agree on the callback verification requirement.',
      question:'Should the HMAC check ship in this round?',options:['ship now','defer'],urgency:'high'},managed.participantToken);
    expect(escalation.status).toBe(202);

    const mail=await waitFor(async()=>mails[0]);
    expect(mail.subject).toContain('需要人工裁定');
    expect(mail.text).toContain('Managed dispatch review');
    expect(mail.text).toContain(`/collab.html?session=${sessionId}`);
    expect(mail.metadata).toMatchObject({kind:'collab'});
  });

  it('serves the collaboration board',async()=>{
    const dataDir=await temp('remote-pi-collab-web-');
    server=new RemotePiServer({port:0,dataDir});
    await server.auth.init();
    const address=await server.start(),base=`http://127.0.0.1:${address!.port}`;
    const page=await fetch(`${base}/collab.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('协作看板');
    expect((await fetch(`${base}/collab.js`)).headers.get('content-type')).toContain('text/javascript');
  });
});

async function waitFor<T>(probe:()=>Promise<T|undefined>,timeoutMs=5000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  for(;;){
    const value=await probe();
    if(value!==undefined&&value!==null)return value;
    if(Date.now()>deadline)throw Error('Timed out waiting for the expected value');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
