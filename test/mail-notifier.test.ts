import {describe,it,expect,vi} from 'vitest';
import {MailNotifier} from '../src/mail-notifier.js';

const ok=()=>Response.json({ok:true,message_id:'msg_1',status:'queued'},{status:202});

describe('MailNotifier',()=>{
  it('queues one MailDispatch message when an Agent becomes fully settled',async()=>{
    let requestUrl='',requestInit:RequestInit|undefined;
    const fetcher:typeof fetch=async(input,init)=>{requestUrl=String(input);requestInit=init;return ok()};
    const notifier=new MailNotifier({endpoint:'https://mail.example.com/api/v1/messages',apiKey:'md_live_secret',recipient:'owner@example.com',senderId:'system'},fetcher);
    notifier.handleAgentEvent('agent-1',{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'已修复，测试通过。'}]}});
    notifier.handleAgentEvent('agent-1',{type:'agent_settled'},{sessionName:'登录修复',workspaceLabel:'Remote Pi',cwd:'/workspace/remote-pi'});
    await notifier.close();

    expect(requestUrl).toBe('https://mail.example.com/api/v1/messages');
    expect(requestInit?.headers).toMatchObject({authorization:'Bearer md_live_secret','idempotency-key':expect.any(String)});
    const payload=JSON.parse(String(requestInit?.body));
    expect(payload).toMatchObject({sender_id:'system',to:['owner@example.com'],subject:'[Remote Pi] 登录修复已完成',purpose:'transactional',metadata:{source:'remote-pi',task_count:1}});
    expect(payload.text).toContain('Session：登录修复');expect(payload.text).toContain('路径：/workspace/remote-pi');expect(payload.text).toContain('已修复，测试通过。');
  });

  it('aggregates tasks completed during the configured delay',async()=>{
    const payloads:any[]=[];const fetcher:typeof fetch=async(_input,init)=>{payloads.push(JSON.parse(String(init?.body)));return ok()};
    const notifier=new MailNotifier({endpoint:'https://mail.example.com/api/v1/messages',apiKey:'key',recipient:'owner@example.com'},fetcher);
    notifier.updateSettings({aggregationDelaySeconds:3600});
    notifier.handleAgentEvent('agent-1',{type:'message_end',message:'first response'});notifier.handleAgentEvent('agent-1',{type:'agent_settled'},{sessionName:'one'});
    notifier.handleAgentEvent('agent-2',{type:'message_end',message:'second response'});notifier.handleAgentEvent('agent-2',{type:'agent_settled'},{sessionName:'two'});
    await notifier.close();
    expect(payloads).toHaveLength(1);expect(payloads[0].subject).toBe('[Remote Pi] 2 个 Agent 任务已完成');expect(payloads[0].text).toContain('first response');expect(payloads[0].text).toContain('second response');
  });

  it('sends only a generic completion notice when both detail options are off',async()=>{
    let payload:any;const fetcher:typeof fetch=async(_input,init)=>{payload=JSON.parse(String(init?.body));return ok()};
    const notifier=new MailNotifier({endpoint:'https://mail.example.com/api/v1/messages',apiKey:'key',recipient:'owner@example.com'},fetcher);
    notifier.updateSettings({includeResponse:false,includeSessionDetails:false});notifier.handleAgentEvent('agent-1',{type:'message_end',message:'secret response'});notifier.handleAgentEvent('agent-1',{type:'agent_settled'},{sessionName:'secret session',cwd:'/secret/path'});await notifier.close();
    expect(payload.text).toBe('有 Agent 任务完成。');expect(JSON.stringify(payload)).not.toContain('secret response');expect(JSON.stringify(payload)).not.toContain('secret session');expect(JSON.stringify(payload)).not.toContain('/secret/path');
  });

  it('does not send on agent_end because retry or queued follow-up work may remain',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>ok());const notifier=new MailNotifier({endpoint:'https://mail.example.com/api/v1/messages',apiKey:'key',recipient:'owner@example.com'},fetcher);
    notifier.handleAgentEvent('agent-1',{type:'agent_end'});await notifier.close();expect(fetcher).not.toHaveBeenCalled();
  });
});
