import {describe,it,expect} from 'vitest';
import {createCollabExtension,type CollabAction} from '../src/collab/pi-extension.js';

const SESSION='11111111-2222-3333-4444-555555555555',ISSUE='aaaaaaaa-2222-3333-4444-555555555555',BASELINE='bbbbbbbb-2222-3333-4444-555555555555';
const digest={sessionId:SESSION,kind:'review',phase:'validating',round:2,task:'validate_issues',
  subject:{type:'commit_range',value:'HEAD~1..HEAD'},baseline:{baselineId:BASELINE,commit:'abc123'},
  you:{participantId:'pppppppp-2222-3333-4444-555555555555',role:'reviewer',tokensUsed:10,tokenBudget:1000},
  issues:[{issueId:ISSUE,number:1,title:'Callback trusts the client amount'}],
  yourRequiredIssueIds:[ISSUE],
  instructions:'Verify each finding yourself, then call collab_submit_issue_votes once with a vote for each.'};

/** Minimal stand-in for the Pi extension host, including the active-tool and event surfaces it controls. */
const load=(submit:(action:CollabAction,payload:Record<string,unknown>)=>unknown,task:Record<string,unknown>=digest)=>{
  const tools:Record<string,any>={};let active=['read','bash','edit','write'];
  createCollabExtension('agent-1',{getTask:async()=>task,submit:async(_agentId,action,payload)=>submit(action,payload)})(
    {on:()=>{},registerTool:(tool:any)=>{tools[tool.name]=tool;active.push(tool.name)},getActiveTools:()=>active,setActiveTools:(names:string[])=>{active=names}} as any);
  Object.defineProperty(tools,'activeTools',{value:()=>active});
  return tools;
};

describe('collaboration Pi extension',()=>{
  it('hands the model a task with no endpoints, tokens, or hub ids',async()=>{
    const tools=load(()=>({}));
    const text=(await tools.collab_get_task.execute('call-1',{})).content[0].text as string;
    expect(text).toContain('HEAD~1..HEAD');
    expect(text).toContain('collab_submit');
    // The hub writes its instructions for the HTTP flow; the tool flow must not repeat its URLs or ids.
    expect(text).not.toContain('/api/v1');
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain(BASELINE);
    expect(text).not.toContain(ISSUE);
    // Required work is useless if it never reaches the prompt: id lists must alias, not vanish.
    expect(text).toMatch(/"yourRequiredIssueRefs":\s*\[\s*"issue-1"\s*\]/);
  });

  it('keeps normal tools available while making the non-mutating workspace rule explicit',async()=>{
    const review=load(()=>({}),{...digest,phase:'collecting',task:'file_findings'});
    const taskText=(await review.collab_get_task.execute('call-1',{})).content[0].text as string;
    expect(taskText).toContain('User request: HEAD~1..HEAD');
    expect(taskText).toContain('Do not create, delete, rename, or modify files under the working directory');
    expect(review.activeTools()).toEqual(expect.arrayContaining(['read','bash','edit','write','collab_submit_findings']));

    const implement=load(()=>({}),{...digest,phase:'implementing',task:'implement'});
    await implement.collab_get_task.execute('call-2',{});
    expect(implement.activeTools()).toEqual(expect.arrayContaining(['read','bash','edit','write','collab_submit_ready']));
  });

  it('restores aliases and the baseline on submit and adds the idempotency key',async()=>{
    let seen:Record<string,unknown>={};
    const tools=load((_action,payload)=>{seen=payload;return {accepted:[{issueId:ISSUE}]}},{...digest,phase:'collecting',task:'file_findings'});
    await tools.collab_get_task.execute('call-1',{});
    const result=await tools.collab_submit_findings.execute('call-2',{
      findings:[{title:'Refund path double-credits'}],rechecks:[{issueRef:'issue-1',outcome:'resolved',rationale:'HMAC is verified now.'}]});
    expect(seen).toMatchObject({baselineId:BASELINE,reviewComplete:true,rechecks:[{issueId:ISSUE,outcome:'resolved'}]});
    expect(seen.clientRequestId).toEqual(expect.any(String));
    expect(result.content[0].text).not.toContain(ISSUE);
  });

  it('keeps codeRef intact instead of renaming it to codeId',async()=>{
    let seen:Record<string,unknown>={};
    const tools=load((_action,payload)=>{seen=payload;return {}},{...digest,phase:'implementing',task:'implement'});
    await tools.collab_get_task.execute('call-1',{});
    await tools.collab_submit_ready.execute('call-2',{summary:'Fixed the callback check and covered it with a test.',
      changes:[{path:'src/pay/callback.ts',summary:'verify HMAC'}],codeRef:{commit:'commit-2',dirtyHash:'sha256:abc'}});
    expect(seen.codeRef).toEqual({commit:'commit-2',dirtyHash:'sha256:abc'});
    expect(seen).not.toHaveProperty('codeId');
  });

  it('names findings by their alias in validation errors instead of hiding them',async()=>{
    const tools=load(()=>{throw Object.assign(new Error(`Invalid request: a vote for issue ${ISSUE} is required`),{fieldErrors:[{path:'votes',code:'REQUIRED'}]})});
    await tools.collab_get_task.execute('call-1',{});
    // The hub names findings by hub id. Blanking them left the model unable to tell *which* vote it still owed,
    // so an id it has an alias for is translated, and only an unknown one is blanked.
    await expect(tools.collab_submit_issue_votes.execute('call-2',{votes:[{issueRef:'issue-1'}]}))
      .rejects.toThrow(/a vote for issue issue-1 is required/);
    await expect(tools.collab_submit_issue_votes.execute('call-3',{votes:[{issueRef:'issue-1'}]}))
      .rejects.toThrow(/^(?!.*aaaaaaaa-2222).*$/);
  });

  it('blanks an id it has no alias for',async()=>{
    const unknown='eeeeeeee-2222-3333-4444-555555555555';
    const tools=load(()=>{throw new Error(`Invalid request: unknown issue ${unknown}`)});
    await tools.collab_get_task.execute('call-1',{});
    await expect(tools.collab_submit_issue_votes.execute('call-2',{votes:[{issueRef:'issue-1'}]})).rejects.toThrow(/internal reference/);
  });

  it('keeps seat aliases aligned with the panel and never leaks a raw seat id',async()=>{
    const seats=['11111111-aaaa-3333-4444-555555555555','22222222-aaaa-3333-4444-555555555555'];
    const tools=load(()=>({}),{...digest,task:'defend_approved_issues',phase:'issue_discussing',
      panel:[{participantId:seats[0],role:'reviewer',displayName:'Reviewer one'},{participantId:seats[1],role:'reviewer',displayName:'Reviewer two'}],
      you:{participantId:seats[1],role:'reviewer'},
      // A plain string array is not an id-shaped key: without seeding, these reach the model as raw hub ids.
      progress:{waitingOn:[seats[0],seats[1]]},
      consensus:[{issueId:ISSUE,rejecters:[seats[0]],supporters:[seats[1]],panelRejected:true}],
      instructions:'Defend or withdraw.'});
    const text=(await tools.collab_get_task.execute('call-1',{})).content[0].text as string;
    expect(text).not.toContain(seats[0]);expect(text).not.toContain(seats[1]);
    expect(text).toContain('reviewer-1');expect(text).toContain('reviewer-2');
    expect(text).toMatch(/"waitingOn":\s*\[\s*"reviewer-1",\s*"reviewer-2"\s*\]/);
  });

  it('lets a reporter withdraw and defend in one submission',async()=>{
    const other='ffffffff-2222-3333-4444-555555555555';let seen:any;
    const tools=load((action,payload)=>{seen={action,payload};return {withdrawn:[ISSUE],accepted:[other]}},{...digest,task:'defend_approved_issues',phase:'issue_discussing',
      issues:[{issueId:ISSUE,number:1,title:'Dropped'},{issueId:other,number:2,title:'Kept'}],
      yourRequiredIssueIds:[ISSUE,other],instructions:'Defend or withdraw every required finding.'});
    await tools.collab_get_task.execute('call-1',{});
    await tools.collab_submit_issue_discussions.execute('call-2',{
      withdrawals:[{issueRef:'issue-1',rationale:'The rejecter is right; my evidence does not hold on this baseline.'}],
      discussions:[{issueRef:'issue-2',argument:'This one still reproduces exactly as filed, so I am keeping it.'}]});
    expect(seen).toMatchObject({action:'issue_discussions',payload:{withdrawals:[{issueId:ISSUE}],discussions:[{issueId:other}]}});
  });

  it('exposes complete scoring candidates and restores criterion aliases in votes',async()=>{
    const criterion='cccccccc-2222-3333-4444-555555555555';let seen:any;
    const tools=load((action,payload)=>{seen={action,payload};return {accepted:[criterion]}},{sessionId:SESSION,kind:'scoring',phase:'voting',round:1,task:'vote_on_criteria',
      subject:{type:'free',value:'payment refactor'},scoringPolicy:{minCriteria:1,maxCriteria:4},
      candidates:[{criterionId:criterion,name:'Security',definition:'Authentication and input validation are complete.',anchors:{0:'directly exploitable',10:'threat-modelled and tested'}}],yourRequiredCriterionIds:[criterion],instructions:'Vote on every candidate.'});
    const text=(await tools.collab_get_task.execute('call-1',{})).content[0].text as string;
    expect(text).toContain('Authentication and input validation are complete.');
    expect(text).toContain('criterion-1');expect(text).not.toContain(criterion);
    const result=await tools.collab_submit_votes.execute('call-2',{votes:[{criterionRef:'criterion-1',stance:'approve',weight:1}]});
    expect(seen).toMatchObject({action:'votes',payload:{votes:[{criterionId:criterion,stance:'approve'}],clientRequestId:expect.any(String)}});
    expect(result.terminate).toBe(true);
  });

  it('passes full rubric context into scoring and batches every required debate',async()=>{
    const criterion='cccccccc-2222-3333-4444-555555555555',debate='dddddddd-2222-3333-4444-555555555555';let seen:any;
    const scoreTools=load((action,payload)=>{seen={action,payload};return {accepted:[criterion]}},{kind:'scoring',phase:'scoring',round:1,task:'score_rubric',
      scoringPolicy:{scale:{min:0,max:10,step:0.5}},rubric:[{criterionId:criterion,name:'Security',definition:'Authentication and input validation are complete.',anchors:{0:'exploitable',10:'fully tested'},weight:1}],yourRequiredCriterionIds:[criterion],instructions:'Score the rubric.'});
    const scoreText=(await scoreTools.collab_get_task.execute('call-1',{})).content[0].text as string;
    expect(scoreText).toContain('fully tested');
    await scoreTools.collab_submit_scores.execute('call-2',{scores:[{criterionRef:'criterion-1',score:7,rationale:'The callback validates signatures but lacks replay coverage.',evidence:[{path:'src/callback.ts',startLine:10}]}]});
    expect(seen).toMatchObject({action:'scores',payload:{scores:[{criterionId:criterion,score:7}]}});

    const debateTools=load((action,payload)=>{seen={action,payload};return {accepted:[debate]}},{kind:'scoring',phase:'debating',round:1,task:'debate_contested_scores',
      debates:[{debateId:debate,criterionId:criterion,criterion:{criterionId:criterion,name:'Security'},arguments:[]}],yourRequiredDebateIds:[debate],analysis:[{criterionId:criterion,min:2,max:9}],instructions:'Debate every contested criterion.'});
    const debateText=(await debateTools.collab_get_task.execute('call-3',{})).content[0].text as string;
    expect(debateText).toContain('debate-1');expect(debateText).toContain('criterion-1');
    await debateTools.collab_submit_debate_arguments.execute('call-4',{arguments:[{debateRef:'debate-1',stance:'hold',argument:'The reachable unsigned callback justifies retaining the lower score.'}]});
    expect(seen).toMatchObject({action:'debate_arguments',payload:{arguments:[{debateId:debate,stance:'hold'}]}});
  });
});
