(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {
    base: localStorage.rpBase || location.origin, token: '', workspace: null, workspaces: [], treePath: '.',
    filePath: null, fileOffset: 0, fileSize: 0, fileLimit: 64 * 1024, agent: null, agents: [], terminals: [], terminal: null, selectedKind: 'agent', ws: null, terminalWs: null,
    terminalEmulator: null, terminalAssetsPromise: null, terminalConnectAttempt: 0, fitAddon: null, resizeObserver: null, reconnectTimer: null, reconnectAttempt: 0, manuallyClosed: false, streams: new Map(), contextTarget: null,
    mentionPath: '.', mentionStart: null, mentionEnd: null, mentionPrefix: '', mentionOptions: [], mentionFiltered: [], mentionIndex: 0, mentionRequest: 0, extensionStatus: new Map(), widgets: new Map(), contexts: new Map(), connected: false, mobileView: 'home',
    toolCards: new Map(), commands: [], commandsAgentId: null, commandFiltered: [], commandIndex: 0, commandRequest: 0,
    agentPageSize: Number(localStorage.rpAgentPageSize || 10), agentVisibleCount: Number(localStorage.rpAgentPageSize || 10), messagePageStart: 0, messageTotal: 0, messagePageSize: 25,
    voiceEnabled: false, voiceSttEnabled: false, voicePlaybackEnabled: localStorage.rpVoicePlayback === 'true', voiceAudio: {context:null,nextTime:0,playbackId:null,sources:new Set(),decodeChain:Promise.resolve(),generation:0}, mediaRecorder:null, mediaChunks:[], mediaStream:null, mediaTimer:null, mediaAgentId:null,
    mailNotificationsAvailable:false,mailSettings:{enabled:false,aggregationDelaySeconds:0,includeResponse:true,includeSessionDetails:true,collabEscalations:true},
  };
  $('api').value = state.base;
  $('pairBase').value = state.base;

  const clean = value => String(value || '').split('\\').join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const joinPath = (base, name) => base === '.' ? name : `${base}/${name}`;
  const parentPath = value => { const p = value.split('/'); p.pop(); return p.join('/') || '.'; };
  const absolutePath = relative => clean(`${state.workspace.rootPath}/${relative === '.' ? '' : relative}`);
  const isInside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
  const relativeTo = (file, dir) => file === dir ? '.' : file.slice(dir.length + 1);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toast = text => { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 3000); };
  const requireConnection = () => { if (!state.connected) { openPair(); return false; } return true; };
  const mobileMedia = matchMedia('(max-width: 700px)');
  const isMobile = () => mobileMedia.matches;
  function setMobileView(view, {push = false, replace = false} = {}) {
    if (!['home','workspace','file','agent'].includes(view)) view = 'home';
    const changed = state.mobileView !== view;
    state.mobileView = view; document.body.dataset.mobileView = view;
    $('workspaceHeading').textContent = view === 'home' ? 'Workspace' : state.workspace?.label || 'Workspace';
    $('mobileAgentActions').closest('.toolbar')?.classList.remove('actions-open');
    if (!isMobile()) return;
    const historyState = {...(history.state || {}), rpView:view};
    if (replace) history.replaceState(historyState, '');
    else if (push && (changed || history.state?.rpView !== view)) history.pushState(historyState, '');
  }
  const navigateMobile = view => { if (isMobile()) setMobileView(view, {push:true}); };
  const mobileBack = fallback => { if (isMobile() && history.state?.rpView === state.mobileView && state.mobileView !== 'home') history.back(); else setMobileView(fallback, {replace:true}); };

  async function request(base, token, url, options = {}, disconnectOnUnauthorized = false) {
    if (!token) throw Error('请先输入配对码');
    const headers = {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers};
    const response = await fetch(base + url, {...options, headers});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (disconnectOnUnauthorized && response.status === 401) disconnect('配对码无效或已失效');
      throw Error(body.error?.message || `HTTP ${response.status}`);
    }
    return body.data;
  }
  async function api(url, options = {}) { return request(state.base, state.token, url, options, true); }
  const post = (url, body = {}) => api(url, {method:'POST', body:JSON.stringify(body)});

  function openPair() {
    if($('configDialog').open)$('configDialog').close();
    $('pairBase').value = state.base;
    $('pairToken').value = localStorage.rpToken || '';
    if (!$('pairDialog').open) $('pairDialog').showModal();
  }
  async function connect(base, token) {
    const candidateBase=base.trim().replace(/\/$/, '')||location.origin,candidateToken=token.trim();
    const status=await request(candidateBase,candidateToken,'/api/v1/system/status');
    if(status.protocolVersion!==1)throw Error(`不支持的协议版本 ${status.protocolVersion}（需要 1）`);
    disconnect();state.base=candidateBase;state.token=candidateToken;state.connected=true;localStorage.rpBase=state.base;$('api').value=state.base;
    $('status').className='ok';$('status').textContent='已配对';$('serverInfo').textContent=`v${status.version} · Pi ${status.piVersion}`;
    state.voiceEnabled=!!(status.voiceCapabilities?.tts??status.voiceEnabled);state.voiceSttEnabled=!!(status.voiceCapabilities?.stt??status.voiceEnabled);$('voicePlayback').hidden=!state.voiceEnabled;$('voiceInput').hidden=!state.voiceSttEnabled;updateVoiceButton();
    await loadMailNotificationSettings(status);updateConfigUi();await refreshWs();await refreshAgents(true);setMobileView('home',{replace:true});
    if(localStorage.rpToken!==state.token){if(confirm('是否将配对码保存到浏览器本地存储？\n\n请仅在可信设备上保存。'))localStorage.rpToken=state.token;else localStorage.removeItem('rpToken');}
    $('pairDialog').close();
  }
  function disconnect(reason = '未配对') {
    state.connected = false; state.token = ''; state.manuallyClosed = true;state.terminalConnectAttempt++;state.voiceEnabled=false;state.voiceSttEnabled=false;state.mailNotificationsAvailable=false;$('voicePlayback').hidden=true;$('voiceInput').hidden=true;
    clearTimeout(state.reconnectTimer); state.ws?.close(); state.ws = null; state.terminalWs?.close(); state.terminalWs = null; if(state.mediaRecorder?.state==='recording')state.mediaRecorder.stop();stopVoiceAudio();
    $('status').className = 'bad'; $('status').textContent = reason; $('serverInfo').textContent = '';updateConfigUi();
  }

  async function refreshWs() {
    if (!requireConnection()) return;
    state.workspaces = await api('/api/v1/workspaces');
    $('workspaces').replaceChildren(...state.workspaces.map(workspace => {
      const option = document.createElement('option'); option.value = workspace.id;
      option.textContent = `${workspace.label} (${workspace.rootPath})`; return option;
    }));
    renderMobileWorkspaces();
    const wanted = state.workspace?.id || localStorage.rpWorkspaceId;
    if (state.workspaces.length) {
      $('workspaces').value = state.workspaces.some(x => x.id === wanted) ? wanted : state.workspaces[0].id;
      await selectWorkspace();
    } else {
      state.workspace = null; $('tree').innerHTML = '<div class="muted">请添加 Workspace</div>';
    }
  }
  function renderMobileWorkspaces() {
    $('mobileWorkspaces').replaceChildren(...state.workspaces.map(workspace => {
      const button=document.createElement('button');button.type='button';button.className='workspace-card';
      const name=document.createElement('b'),path=document.createElement('small');name.textContent=workspace.label;path.textContent=workspace.rootPath;button.append(name,path);
      button.onclick=async()=>{try{$('workspaces').value=workspace.id;await selectWorkspace();navigateMobile('workspace');}catch(error){toast(error.message);}};return button;
    }));
  }
  async function selectWorkspace() {
    state.workspace = state.workspaces.find(x => x.id === $('workspaces').value);
    if (!state.workspace) return;
    localStorage.rpWorkspaceId = state.workspace.id; state.treePath = '.'; $('agentCwd').value = '.'; $('filePanel').hidden = true;
    $('workspaceHeading').textContent = isMobile() && state.mobileView !== 'home' ? state.workspace.label : 'Workspace';
    await loadTree();
  }
  async function loadTree() {
    if (!state.workspace) return;
    $('treePath').textContent = absolutePath(state.treePath);
    try {
      const items = await api(`/api/v1/workspaces/${state.workspace.id}/tree?path=${encodeURIComponent(state.treePath)}`);
      $('tree').replaceChildren(...items.map(item => {
        const el = document.createElement('div'); el.className = `entry ${item.type === 'directory' ? 'dir' : 'file-entry'}`;
        el.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`;
        const relativePath = joinPath(state.treePath, item.name);
        el.onclick = () => item.type === 'directory' ? openDirectory(relativePath) : openFile(relativePath, 0);
        const contextTarget={relativePath,type:item.type};el.oncontextmenu=event=>showContextMenu(event,contextTarget);enableLongPressMenu(el,event=>showContextMenu(event,contextTarget));return el;
      }));
    } catch (error) { $('tree').textContent = error.message; }
  }
  async function openDirectory(relativePath) { state.treePath = relativePath; $('filePanel').hidden = true; await loadTree(); }
  async function openFile(relativePath, offset, showView = true) {
    try {
      const file = await api(`/api/v1/workspaces/${state.workspace.id}/file?path=${encodeURIComponent(relativePath)}&offset=${offset}&limit=${state.fileLimit}`);
      state.filePath = relativePath; state.fileOffset = file.offset; state.fileSize = file.size;
      $('filePanel').hidden = false; $('fileName').textContent = relativePath;
      $('file').textContent = file.binary ? `[二进制文件，${file.size} bytes，无法预览]` : file.content;
      $('filePage').textContent = `${file.offset.toLocaleString()}–${Math.min(file.offset + file.limit, file.size).toLocaleString()} / ${file.size.toLocaleString()} bytes`;
      $('filePrev').disabled = file.offset <= 0; $('fileNext').disabled = file.binary || file.offset + file.limit >= file.size;
      if (showView) navigateMobile('file');
    } catch (error) { toast(error.message); }
  }
  function showContextMenu(event, target) {
    event.preventDefault(); state.contextTarget = target; const isDirectory = target.type === 'directory'; $('menuStartAgent').hidden = !isDirectory; $('menuSetCwd').hidden = !isDirectory; $('menuOpenTerminal').hidden = !isDirectory;
    const menu = $('contextMenu'); menu.hidden = false; const margin=8;menu.style.left=`${Math.max(margin,Math.min(event.clientX,innerWidth-menu.offsetWidth-margin))}px`;menu.style.top=`${Math.max(margin,Math.min(event.clientY,innerHeight-menu.offsetHeight-margin))}px`;
  }
  function enableLongPressMenu(element, openMenu) {
    let timer=null,pointerId=null,startX=0,startY=0,suppressClickUntil=0;
    const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;pointerId=null;element.classList.remove('long-press-pending');};
    element.classList.add('long-press-menu');
    element.addEventListener('pointerdown',event=>{
      if(!isMobile()||event.pointerType==='mouse'||event.button!==0||!event.isPrimary)return;
      cancel();pointerId=event.pointerId;startX=event.clientX;startY=event.clientY;element.classList.add('long-press-pending');
      timer=setTimeout(()=>{timer=null;suppressClickUntil=Date.now()+700;element.classList.remove('long-press-pending');navigator.vibrate?.(15);openMenu({preventDefault(){},clientX:startX,clientY:startY});},550);
    });
    element.addEventListener('pointermove',event=>{if(event.pointerId===pointerId&&Math.hypot(event.clientX-startX,event.clientY-startY)>10)cancel();});
    element.addEventListener('pointerup',event=>{if(event.pointerId===pointerId)cancel();});
    element.addEventListener('pointercancel',cancel);element.addEventListener('pointerleave',event=>{if(event.pointerId===pointerId)cancel();});
    element.addEventListener('click',event=>{if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
  function mentionContext() {
    const input=$('input'),end=input.selectionStart,before=input.value.slice(0,end),match=before.match(/(^|\s)@(?:"([^"]*)"?|([^\s]*))$/);
    if(!match)return null;const token=match[0].slice(match[1]?.length||0),start=end-token.length,replacementEnd=end+(token.startsWith('@"')&&input.value[end]==='"'?1:0);return {start,end,replacementEnd,query:match[2]??match[3]??''};
  }
  function mentionValue(relativePath, directory=false) {
    const target=absolutePath(relativePath),cwd=clean(state.agent?.cwd||absolutePath($('agentCwd').value.trim()||'.'));
    let value=isInside(target,cwd)?relativeTo(target,cwd):target;if(directory&&value!=='.')value+='/';return value;
  }
  function writeMention(relativePath,{directory=false,close=true}={}) {
    if(!state.workspace)return;const input=$('input'),context=mentionContext(),from=state.mentionStart??context?.start??input.selectionStart,to=state.mentionEnd??context?.replacementEnd??input.selectionStart;
    const value=mentionValue(relativePath,directory),quoted=value.includes(' '),mention=`@${quoted?`"${value}"`:value}`;input.setRangeText(`${mention}${close?' ':''}`,from,to,'end');state.mentionStart=from;state.mentionEnd=from+mention.length;if(directory&&!close&&quoted)input.setSelectionRange(state.mentionEnd-1,state.mentionEnd-1);input.focus();if(close)closeMention();
  }
  function insertMention(relativePath) { state.mentionStart=null;state.mentionEnd=null;writeMention(relativePath); }
  function setMentionSelection(index) {
    const count=state.mentionFiltered.length;if(!count){state.mentionIndex=0;return;}state.mentionIndex=(index+count)%count;
    $('mentionItems').querySelectorAll('.picker-item').forEach((element,i)=>element.classList.toggle('selected',i===state.mentionIndex));
    $('mentionItems').querySelector('.picker-item.selected')?.scrollIntoView({block:'nearest'});
  }
  function browseMention(path) { writeMention(path,{directory:true,close:false});state.mentionPrefix=mentionValue(path,true);void openMention(path,''); }
  function chooseMention(option,close) {
    if(!option)return;if(option.type==='directory'&&!close&&!option.current){browseMention(option.path);return;}
    writeMention(option.path,{close});if(!close)state.mentionPrefix='';
  }
  function renderMentionItems(filter='') {
    const query=filter.toLocaleLowerCase(),options=state.mentionOptions.filter(option=>!query||(!option.current&&(option.name.toLocaleLowerCase().includes(query)||option.path.toLocaleLowerCase().includes(query))));
    state.mentionFiltered=options;state.mentionIndex=0;
    if(!options.length){const empty=document.createElement('div');empty.className='picker-empty muted';empty.textContent='没有匹配的文件或目录';$('mentionItems').replaceChildren(empty);return;}
    $('mentionItems').replaceChildren(...options.map((option,index)=>{const el=document.createElement('div');el.className=`picker-item ${option.type==='directory'?'dir':'file-entry'}${index===0?' selected':''}`;el.textContent=option.label;el.onmouseenter=()=>setMentionSelection(index);el.onclick=()=>chooseMention(option,option.type!=='directory'||option.current);return el;}));
  }
  async function openMention(path=state.treePath,filter='') {
    if(!state.workspace)return;const request=++state.mentionRequest;state.mentionPath=path;$('mentionPicker').hidden=false;$('mentionPath').textContent=absolutePath(path);
    try {
      const items=await api(`/api/v1/workspaces/${state.workspace.id}/tree?path=${encodeURIComponent(path)}`);if(request!==state.mentionRequest)return;
      state.mentionOptions=[{name:'引用当前目录',path,type:'directory',current:true,label:'📁 引用当前目录'},...items.map(item=>({name:item.name,path:joinPath(path,item.name),type:item.type,current:false,label:`${item.type==='directory'?'📁':'📄'} ${item.name}`}))];renderMentionItems(filter);
    } catch(error){if(request===state.mentionRequest)$('mentionItems').textContent=error.message;}
  }
  function closeMention(){state.mentionRequest++;state.mentionStart=null;state.mentionEnd=null;state.mentionPrefix='';$('mentionPicker').hidden=true;}

  // Slash commands: prompt templates and skills are expanded by the Pi session itself
  // (AgentSession.prompt() expands them by default), so the composer only has to help discover them.
  function commandContext() {
    const input=$('input'),end=input.selectionStart,before=input.value.slice(0,end);
    const match=before.match(/^\/([^\s]*)$/);return match?{end,query:match[1]}:null;
  }
  async function loadCommands(agentId) {
    if(state.commandsAgentId===agentId)return state.commands;
    const commands=await api(`/api/v1/agents/${agentId}/commands`);return Array.isArray(commands)?commands:[];
  }
  function setCommandSelection(index) {
    const count=state.commandFiltered.length;if(!count){state.commandIndex=0;return;}state.commandIndex=(index+count)%count;
    $('commandItems').querySelectorAll('.picker-item').forEach((element,i)=>element.classList.toggle('selected',i===state.commandIndex));
    $('commandItems').querySelector('.picker-item.selected')?.scrollIntoView({block:'nearest'});
  }
  function chooseCommand(option) {
    if(!option)return;const input=$('input'),context=commandContext();
    input.setRangeText(`/${option.name} `,0,context?context.end:input.value.length,'end');closeCommandPicker();input.focus();
  }
  function renderCommandItems(query='') {
    const filter=query.toLocaleLowerCase(),options=state.commands.filter(command=>!filter||command.name.toLocaleLowerCase().includes(filter));
    state.commandFiltered=options;state.commandIndex=0;
    if(!options.length){const empty=document.createElement('div');empty.className='picker-empty muted';empty.textContent=state.commands.length?'没有匹配的命令':'当前目录没有 prompt template 或 skill';$('commandItems').replaceChildren(empty);return;}
    $('commandItems').replaceChildren(...options.map((option,index)=>{
      const el=document.createElement('div');el.className=`picker-item${index===0?' selected':''}`;
      const name=document.createElement('b');name.textContent=`/${option.name}${option.argumentHint?` ${option.argumentHint}`:''}`;
      const description=document.createElement('small');description.className='muted';description.textContent=`${option.source==='skill'?'skill':'prompt'}${option.description?` · ${option.description}`:''}`;
      el.append(name,description);el.onmouseenter=()=>setCommandSelection(index);el.onclick=()=>chooseCommand(option);return el;
    }));
  }
  async function openCommandPicker(query='') {
    if(!state.agent)return;const agentId=state.agent.agentId,request=++state.commandRequest;$('commandPicker').hidden=false;
    if(state.commandsAgentId!==agentId){state.commands=[];$('commandItems').textContent='正在加载命令…';}
    try{const commands=await loadCommands(agentId);if(request!==state.commandRequest||state.agent?.agentId!==agentId||$('commandPicker').hidden)return;state.commands=commands;state.commandsAgentId=agentId;renderCommandItems(query);}
    catch(error){if(request===state.commandRequest&&state.agent?.agentId===agentId){state.commands=[];$('commandItems').textContent='无法加载命令';console.error('Unable to load slash commands',error);}}
  }
  function closeCommandPicker(){state.commandRequest++;$('commandPicker').hidden=true;state.commandFiltered=[];state.commandIndex=0;}

  function agentName(agent) { return agent.sessionName || agent.name; }
  function agentLabel(agent) { return agentName(agent) || agent.cwd || agent.agentId; }
  function agentSubtitle(agent) { return agentName(agent) ? agent.cwd : agent.agentId; }
  function updateKeyboardUi(connection) {
    const connected=connection?.connected??sessionKeyboard.connected,name=connection?.name||sessionKeyboard.device?.productName||'Codex Micro';
    $('keyboardConnect').hidden=connected;$('keyboardDisconnect').hidden=!connected;
    const unavailable=!window.isSecureContext?'需要 HTTPS 或 localhost':!navigator.hid?'当前浏览器不支持 WebHID':'';
    $('keyboardConnect').disabled=Boolean(unavailable);$('keyboardConnect').title=unavailable;
    $('keyboardStatus').textContent=connected?`已连接 ${name} · 工作中亮 1 秒/灭 1 秒，空闲常亮`:unavailable||'未连接 · 绑定保存在当前浏览器';
    renderKeyboardBindings();
  }
  function renderKeyboardBindings() {
    if(!$('keyboardSlots'))return;
    const agents=new Map(state.agents.map(agent=>[agent.agentId,agent]));
    $('keyboardSlots').replaceChildren(...Array.from({length:6},(_,slot)=>{
      const binding=sessionKeyboard.getSlot(slot),agent=binding&&agents.get(binding.agentId),el=document.createElement('div');el.className='keyboard-slot';
      el.style.setProperty('--key-color',binding?.color||'#586174');
      const title=document.createElement('b');title.textContent=`键 ${slot+1}${binding?' · '+binding.color:''}`;
      const detail=document.createElement('small');detail.textContent=binding?(agent?agentLabel(agent):'Session 当前不可用'):'未绑定';
      el.append(title,detail);return el;
    }));
  }
  const sessionKeyboard = new window.SessionKeyboardController({
    onKey:binding=>{const agent=state.agents.find(item=>item.agentId===binding.agentId);if(!agent)return toast(`按键 ${binding.slot+1} 绑定的 Session 当前不可用`);selectAgent(agent).catch(error=>toast(error.message));},
    onStateChange:updateKeyboardUi,
    onBindingsChange:()=>{renderAgentList();renderKeyboardBindings();},
    onError:error=>{console.error('Session keyboard error',error);toast(`键盘：${error.message}`);}
  });
  const formatTokens = value => { const n=Number(value); if(!Number.isFinite(n)||n<=0)return '0'; if(n>=1e6)return `${(n/1e6).toFixed(1)}M`;if(n>=1e3)return `${(n/1e3).toFixed(n>=1e4?0:1)}k`;return String(Math.round(n)); };
  const usageLevel = usage => Number(usage?.percent)>90?'usage-danger':Number(usage?.percent)>70?'usage-warning':'';
  const usageText = usage => { if(!usage||!Number(usage.contextWindow))return 'Context ?';const percent=usage.percent==null?'?':`${Number(usage.percent).toFixed(1)}%`;return `${percent} · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`; };
  const costText = usage => { const cost=Number(usage?.cost);if(!Number.isFinite(cost))return 'Session cost ?';return `Session cost ~$${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`; };
  const sessionUsage = session => ({...(session.contextUsage||{}),cost:session.stats?.cost});
  function renderAgentList() {
    const recent=(value,fallback)=>{const time=Date.parse(value||fallback||'');return Number.isFinite(time)?time:0;};
    const allItems=[...state.agents.map(item=>({kind:'agent',item})),...state.terminals.map(item=>({kind:'terminal',item}))].sort((a,b)=>recent(b.item.lastActiveAt,b.item.createdAt)-recent(a.item.lastActiveAt,a.item.createdAt));
    const items=allItems.slice(0,state.agentVisibleCount);
    $('agents').replaceChildren(...items.map(({kind,item}) => {
      const isAgent=kind==='agent',id=isAgent?item.agentId:item.terminalId,selected=state.selectedKind===kind&&(isAgent?state.agent?.agentId:state.terminal?.terminalId)===id;
      const el=document.createElement('div');el.dataset.itemId=id;el.className=`agent ${item.status}${selected?' selected':''}`;
      if(isAgent){const usage=state.contexts.get(item.agentId),binding=sessionKeyboard.getBinding(item.agentId);el.innerHTML=`<div class="agent-top"><b>${esc(agentLabel(item))}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(agentSubtitle(item))}</small><div class="agent-context ${usageLevel(usage)}"><span>Context</span><div class="mini-track"><i style="width:${Math.min(100,Math.max(0,Number(usage?.percent)||0))}%"></i></div><span>${esc(usageText(usage))} · ${esc(costText(usage))}</span></div>`;if(binding){const badge=document.createElement('span');badge.className='key-binding';badge.style.setProperty('--key-color',binding.color);badge.textContent=`K${binding.slot+1}`;badge.title=`键盘按键 ${binding.slot+1} · ${binding.color}`;el.querySelector('.agent-top').append(badge);}}
      else el.innerHTML=`<div class="agent-top"><span class="terminal-kind">&gt;_</span><b>${esc(item.title||'Terminal')}</b><span class="state-badge state-${esc(item.status)}">${esc(item.status)}</span></div><small>${esc(item.cwd)}</small>`;
      el.onclick=()=>isAgent?selectAgent(item):selectTerminal(item);el.oncontextmenu=event=>showItemContextMenu(event,kind,item);return el;
    }));
    $('agentListCount').textContent=`已显示 ${items.length} / ${allItems.length}`;$('loadMoreAgents').hidden=items.length>=allItems.length;$('loadMoreAgents').disabled=items.length>=allItems.length;
  }
  async function loadAgentContexts(agents=state.agents) {
    await Promise.allSettled(agents.map(async agent=>{const session=await api(`/api/v1/agents/${agent.agentId}/session?summary=true`);agent.sessionName=session.sessionName||undefined;let lastMessageAt=0;for(const entry of session.entries||[]){if(entry.type!=='message')continue;const time=Date.parse(entry.timestamp||'');if(Number.isFinite(time))lastMessageAt=Math.max(lastMessageAt,time);}if(lastMessageAt)agent.lastActiveAt=new Date(lastMessageAt).toISOString();state.contexts.set(agent.agentId,sessionUsage(session));}));
    renderAgentList();if(state.agent)updateAgentHeader();
  }
  async function refreshAgents(selectPrevious = false) {
    if (!state.connected) return;
    [state.agents,state.terminals] = await Promise.all([api('/api/v1/agents'),api('/api/v1/terminals')]);sessionKeyboard.setAgents(state.agents);renderKeyboardBindings(); const previous = state.agent?.agentId || localStorage.rpAgentId,previousTerminal=state.terminal?.terminalId||localStorage.rpTerminalId;
    if(state.agent){const fresh=state.agents.find(x=>x.agentId===state.agent.agentId);if(fresh)state.agent=Object.assign(state.agent,fresh);}
    renderAgentList();
    if (selectPrevious) { const foundTerminal=state.terminals.find(x=>x.terminalId===previousTerminal),found = state.agents.find(x => x.agentId === previous); if(localStorage.rpSelectedKind==='terminal'&&foundTerminal)await selectTerminal(foundTerminal,false);else if (found) await selectAgent(found, false); else connectSocket(); }
    else if (!state.ws) connectSocket();
  }
  function setAgentStatus(agentId,status) {
    const agent=state.agents.find(x=>x.agentId===agentId);if(!agent){void refreshAgents();return null;}agent.status=status;if(state.agent?.agentId===agentId)state.agent.status=status;sessionKeyboard.updateAgent(agent);renderAgentList();updateAgentHeader();return agent;
  }
  function updateAgentHeader(agent = state.agent) {
    if (!agent) return;
    $('agentTitle').textContent = agentLabel(agent); $('agentStatus').textContent = agentSubtitle(agent);
    const badge=$('agentStateBadge');badge.textContent=agent.status;badge.className=`state-badge state-${agent.status}`;
    const usage=state.contexts.get(agent.agentId),panel=$('contextUsage');panel.hidden=false;$('contextText').textContent=`Context ${usageText(usage)} · ${costText(usage)}`;const percent=Math.min(100,Math.max(0,Number(usage?.percent)||0));$('contextBar').style.width=`${percent}%`;panel.className=`context-usage ${usageLevel(usage)}`;
  }
  function showAgentView(){
    $('agentToolbar').hidden=false;$('terminalToolbar').hidden=true;$('terminalView').hidden=true;$('widgets').hidden=false;$('messages').hidden=false;$('prompt').hidden=false;
  }
  const loadTerminalStyle=()=>new Promise((resolve,reject)=>{
    const id='xterm-styles',loaded=document.getElementById(id);if(loaded?.dataset.loaded==='true')return resolve();
    const link=loaded||document.createElement('link');link.id=id;link.rel='stylesheet';link.href='/vendor/xterm.css';link.onload=()=>{link.dataset.loaded='true';resolve();};link.onerror=()=>{link.remove();reject(Error('无法加载 /vendor/xterm.css'));};if(!loaded)document.head.append(link);
  });
  const loadTerminalScript=(id,src)=>new Promise((resolve,reject)=>{
    const loaded=document.getElementById(id);if(loaded?.dataset.loaded==='true')return resolve();
    const script=loaded||document.createElement('script');script.id=id;script.src=src;script.async=true;script.onload=()=>{script.dataset.loaded='true';resolve();};script.onerror=()=>{script.remove();reject(Error(`无法加载 ${src}`));};if(!loaded)document.head.append(script);
  });
  function loadTerminalAssets(){
    if(window.Terminal&&window.FitAddon?.FitAddon)return Promise.resolve();
    if(!state.terminalAssetsPromise)state.terminalAssetsPromise=(async()=>{
      await Promise.all([loadTerminalStyle(),loadTerminalScript('xterm-script','/vendor/xterm.js')]);
      await loadTerminalScript('xterm-fit-script','/vendor/addon-fit.js');
      if(typeof window.Terminal!=='function'||typeof window.FitAddon?.FitAddon!=='function')throw Error('xterm.js 初始化失败');
    })().catch(error=>{state.terminalAssetsPromise=null;throw error;});
    return state.terminalAssetsPromise;
  }
  async function ensureTerminalEmulator(){
    if(state.terminalEmulator)return state.terminalEmulator;
    await loadTerminalAssets();if(state.terminalEmulator)return state.terminalEmulator;
    const term=new window.Terminal({cursorBlink:true,convertEol:false,fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',fontSize:14,scrollback:5000,theme:{background:'#111111',foreground:'#d8dee9',cursor:'#88c0d0'}}),fit=new window.FitAddon.FitAddon();
    term.loadAddon(fit);term.open($('terminal'));term.onData(data=>{if(state.terminalWs?.readyState===WebSocket.OPEN)state.terminalWs.send(JSON.stringify({type:'input',data}));});
    term.onResize(size=>{if(state.terminalWs?.readyState===WebSocket.OPEN)state.terminalWs.send(JSON.stringify({type:'resize',cols:size.cols,rows:size.rows}));});
    state.resizeObserver=new ResizeObserver(()=>{if(!$('terminalView').hidden)try{fit.fit();}catch{}});state.resizeObserver.observe($('terminalView'));state.terminalEmulator=term;state.fitAddon=fit;return term;
  }
  async function connectTerminalSocket(terminal){
    state.terminalWs?.close();state.terminalWs=null;const terminalId=terminal.terminalId,attempt=++state.terminalConnectAttempt;$('terminalStatus').textContent=`${terminal.cwd} · 正在加载 Terminal…`;
    try{
      const term=await ensureTerminalEmulator();if(attempt!==state.terminalConnectAttempt||state.selectedKind!=='terminal'||state.terminal?.terminalId!==terminalId)return;term.reset();term.clear();$('terminalStatus').textContent=`${terminal.cwd} · 正在连接…`;
      const ws=new WebSocket(state.base.replace(/^http/,'ws')+`/api/v1/terminals/${encodeURIComponent(terminalId)}/ws`,['access-token.'+state.token]);state.terminalWs=ws;
      ws.onopen=()=>{if(ws!==state.terminalWs)return;requestAnimationFrame(()=>{try{state.fitAddon.fit();ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));term.focus();}catch{}});};
      ws.onmessage=event=>{if(ws!==state.terminalWs)return;try{const message=JSON.parse(event.data);if(message.type==='snapshot'){term.reset();if(message.data)term.write(message.data);terminal.status=message.record.status;updateTerminalHeader();renderAgentList();}else if(message.type==='output')term.write(message.data);else if(message.type==='exit'){terminal.status='exited';terminal.exitCode=message.exitCode;updateTerminalHeader();renderAgentList();void refreshAgents();}else if(message.type==='error')toast(message.message);}catch(error){console.error(error);}};
      ws.onerror=()=>{};ws.onclose=()=>{if(ws===state.terminalWs&&terminal.status==='running')$('terminalStatus').textContent=`${terminal.cwd} · 连接已断开`;};
    }catch(error){if(attempt===state.terminalConnectAttempt&&state.selectedKind==='terminal'&&state.terminal?.terminalId===terminalId){$('terminalStatus').textContent=`${terminal.cwd} · Terminal 加载失败`;toast(`Terminal 加载失败：${error.message}`);}}
  }
  function updateTerminalHeader(){const terminal=state.terminal;if(!terminal)return;$('terminalTitle').textContent=terminal.title||'Terminal';$('terminalStatus').textContent=`${terminal.cwd}${terminal.exitCode===undefined?'':` · exit ${terminal.exitCode}`}`;const badge=$('terminalStateBadge');badge.textContent=terminal.status;badge.className=`state-badge state-${terminal.status}`;}
  async function selectTerminal(terminal,openView=true){
    state.selectedKind='terminal';state.terminal=terminal;localStorage.rpTerminalId=terminal.terminalId;localStorage.rpSelectedKind='terminal';$('agentToolbar').hidden=true;$('terminalToolbar').hidden=false;$('terminalView').hidden=false;$('widgets').hidden=true;$('messages').hidden=true;$('prompt').hidden=true;updateTerminalHeader();renderAgentList();if(openView)navigateMobile('agent');void connectTerminalSocket(terminal);
  }
  const autoBindNewSession=agent=>sessionKeyboard.autoBind(agent.agentId);
  async function startAgent(relativePath){if(!state.workspace)return toast('请先选择 Workspace');$('contextMenu').hidden=true;try{const agent=await post('/api/v1/agents',{workspaceId:state.workspace.id,relativeCwd:relativePath}),binding=autoBindNewSession(agent);$('agentCwd').value=relativePath;await refreshAgents();await selectAgent(agent);if(binding)toast(`新 Session 已自动绑定到按键 ${binding.slot+1}`);}catch(error){toast(error.message);}}
  async function openTerminal(relativePath){if(!state.workspace)return toast('请先选择 Workspace');try{const terminal=await post('/api/v1/terminals',{workspaceId:state.workspace.id,relativeCwd:relativePath});state.terminals.unshift(terminal);$('contextMenu').hidden=true;renderAgentList();await selectTerminal(terminal);}catch(error){toast(error.message);}}
  async function closeTerminal(terminal=state.terminal){if(!terminal)return;try{await api(`/api/v1/terminals/${terminal.terminalId}`,{method:'DELETE'});state.terminalWs?.close();state.terminalWs=null;state.terminals=state.terminals.filter(x=>x.terminalId!==terminal.terminalId);if(state.terminal?.terminalId===terminal.terminalId){state.terminal=null;localStorage.removeItem('rpTerminalId');localStorage.rpSelectedKind='agent';showAgentView();}renderAgentList();toast('Terminal 已关闭');}catch(error){toast(error.message);}}
  async function selectAgent(agent, openView = true) {
    state.selectedKind='agent';state.terminalWs?.close();state.terminalWs=null;state.agent = agent; localStorage.rpAgentId = agent.agentId;localStorage.rpSelectedKind='agent';showAgentView();updateAgentHeader();
    if (openView) navigateMobile('agent');
    if (state.workspace && isInside(clean(agent.cwd), clean(state.workspace.rootPath))) $('agentCwd').value = relativeTo(clean(agent.cwd), clean(state.workspace.rootPath));
    $('messages').replaceChildren(); discardStreams();state.messagePageStart=0;state.messageTotal=0;closeCommandPicker();state.commands=[];state.commandsAgentId=null;
    try { await loadMessagePage(agent.agentId,undefined,true); await loadSessionIdentity(); } catch (error) { addCard('加载消息失败', error.message, 'error', true); }
    renderAgentList();
    connectSocket();
  }
  async function loadSessionIdentity() {
    if (!state.agent) return;
    const session = await api(`/api/v1/agents/${state.agent.agentId}/session?summary=true`);
    state.agent.sessionName=session.sessionName||undefined;state.contexts.set(state.agent.agentId,sessionUsage(session));renderAgentList();updateAgentHeader();
  }

  function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking || part.text : part?.type === 'toolCall' ? `${part.name || 'Tool'}\n${JSON.stringify(part.arguments || {}, null, 2)}` : '').filter(Boolean).join('\n');
  }
  // Pi persists failed provider responses as empty assistant messages with
  // stopReason="error" and errorMessage. They have no content to render, so
  // handle the error metadata explicitly instead of silently dropping them.
  function assistantError(message) {
    if(message?.role!=='assistant'||(message.stopReason!=='error'&&!message.errorMessage))return '';
    const detail=String(message.errorMessage||'LLM request failed').trim();
    const source=[message.provider,message.model].filter(Boolean).join(' · ');
    return source?`${detail}\n\n${source}`:detail;
  }
  function renderCardBody(body, content, markdown = false) {
    const value=String(content??'');body.classList.toggle('markdown',markdown);
    if(markdown&&window.marked&&window.DOMPurify){body.innerHTML=DOMPurify.sanitize(marked.parse(value,{gfm:true,breaks:true}));for(const link of body.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}}
    else body.textContent=value;
  }
  // The transcript only shows what a human reads linearly: prompts, answers, thinking, dialogs and errors.
  // Everything else (tool calls, bash output, retries, extension chatter) is folded into one collapsed
  // activity group per stretch of activity, whose summary tracks the most recent item while it streams.
  const TRANSCRIPT_KINDS = new Set(['user','assistant','thinking','dialog','voice','error']);
  function activityGroup(target) {
    const last=target.lastElementChild;
    if (last?.classList?.contains('activity-group')) return last;
    const group=document.createElement('details'); group.className='msg activity-group';
    const summary=document.createElement('summary'),text=document.createElement('span'),count=document.createElement('span'),time=document.createElement('span');
    text.className='summary-text';text.textContent='活动';count.className='activity-count';time.className='event-time';
    summary.append(text,count,time);
    const items=document.createElement('div');items.className='activity-items';
    group.append(summary,items);target.append(group);return group;
  }
  const eventTime = timestamp => {const value=Number(timestamp);return Number.isFinite(value)&&value>0?new Date(value>1e12?value:value*1000).toLocaleTimeString():'';};
  function updateActivityGroup(group, title, timestamp) {
    const count=group.querySelector('.activity-items').childElementCount;
    group.querySelector('.summary-text').textContent=title||'活动';
    group.querySelector('.activity-count').textContent=`${count} 项`;
    const time=eventTime(timestamp);if(time)group.querySelector('.event-time').textContent=time;
  }
  function addCard(title, content, kind = 'system', open = false, timestamp, target = $('messages'), autoScroll = true) {
    const derivedTitle=!title,details=document.createElement('details'); details.className = `msg ${kind}${derivedTitle?' derived-title':''}`; details.open = open;
    const summary=document.createElement('summary'),summaryText=document.createElement('span'),summaryLabel=document.createElement('span');summaryText.className='summary-text';summaryText.textContent=title||String(content).trim()||kind;summaryLabel.className='summary-label';summaryLabel.textContent=kind==='user'?'You':kind==='assistant'?'Assistant':kind;summary.append(summaryText,summaryLabel);
    const time=document.createElement('span'); time.className='event-time'; time.textContent=eventTime(timestamp); summary.append(time);
    const body = document.createElement('div'); body.className = 'msg-content';renderCardBody(body,content,kind==='assistant');
    details.append(summary, body);
    const group=TRANSCRIPT_KINDS.has(kind)?null:activityGroup(target);
    (group?group.querySelector('.activity-items'):target).append(details);
    if(group)updateActivityGroup(group,title||kind,timestamp);
    if(autoScroll&&target===$('messages'))$('messages').scrollTop = $('messages').scrollHeight;
    return {details, summary, summaryText, summaryTime:time, body, group, content:String(content??'')};
  }
  /** One card per tool call: `tool_execution_start` opens it, updates stream into it and `tool_execution_end` closes it. */
  function upsertToolCard(ev, timestamp) {
    const key=`tool:${ev.toolCallId||ev.toolName||'tool'}`,existing=state.toolCards.get(key);
    const args=ev.args&&Object.keys(ev.args).length?JSON.stringify(ev.args,null,2):'';
    if (ev.type==='tool_execution_start') {
      const card=addCard(`🔧 ${ev.toolName||'Tool'}`,args,'tool',false,timestamp);card.toolName=ev.toolName||'Tool';card.args=args;state.toolCards.set(key,card);return card;
    }
    const card=existing||addCard(`🔧 ${ev.toolName||'Tool'}`,args,'tool',false,timestamp);
    if(!existing){card.toolName=ev.toolName||'Tool';card.args=args;state.toolCards.set(key,card);}
    if (ev.type==='tool_execution_update') {
      const partial=textContent(ev.partialResult?.content??ev.partialResult)||(ev.partialResult?JSON.stringify(ev.partialResult):'');
      if(partial)renderCardBody(card.body,`${card.args}\n\n— 输出 —\n${partial}`);
      card.summaryTime.textContent=eventTime(timestamp);
      if(card.group)updateActivityGroup(card.group,`🔧 ${card.toolName}`,timestamp);
      return card;
    }
    const result=textContent(ev.result?.content??ev.result)||(ev.result&&!ev.result.content?JSON.stringify(ev.result,null,2):'')||(ev.isError?'执行失败':'执行完成');
    card.details.classList.toggle('tool-error',!!ev.isError);
    card.summaryText.textContent=`${ev.isError?'✗':'✓'} ${card.toolName}`;
    renderCardBody(card.body,`${card.args}\n\n— 结果 —\n${result}`);
    card.summaryTime.textContent=eventTime(timestamp);
    if(card.group)updateActivityGroup(card.group,card.summaryText.textContent,timestamp);
    state.toolCards.delete(key);
    return card;
  }
  /** Session bash has streaming deltas followed by one server-generated completion event. */
  function updateBashCard(ev, timestamp) {
    const key=`bash:${ev.id||'default'}`;let card=state.toolCards.get(key);
    if(!card){card=addCard(ev.command?`$ ${ev.command}`:'$ bash','','tool',false,timestamp);card.content='';state.toolCards.set(key,card);}
    if(ev.type==='bash_execution_update')card.content+=String(ev.delta||'');
    else {
      card.content=String(ev.output??card.content);const failed=!!ev.isError||ev.cancelled||Number(ev.exitCode)>0;
      const status=ev.isError?ev.errorMessage:ev.cancelled?'已取消':ev.exitCode===undefined?'完成':`exit ${ev.exitCode}${ev.truncated?' · 输出已截断':''}`;
      card.details.classList.toggle('tool-error',failed);card.summaryText.textContent=`${failed?'✗':'✓'} ${ev.command?`$ ${ev.command}`:'bash'} · ${status}`;state.toolCards.delete(key);
    }
    renderCardBody(card.body,card.content);card.summaryTime.textContent=eventTime(timestamp);
    if(card.group)updateActivityGroup(card.group,card.summaryText.textContent,timestamp);
  }
  function renderMessages(messages, target = $('messages'), showEmpty = true) {
    if (!messages?.length) { if(showEmpty&&target===$('messages'))$('messages').innerHTML = '<div class="empty">尚无消息</div>'; return; }
    for (const message of messages) {
      const role=message.role||'event',timestamp=message.timestamp;
      if(role==='bashExecution'){
        const failed=message.cancelled||Number(message.exitCode)>0,status=message.cancelled?'已取消':message.exitCode===undefined?'完成':`exit ${message.exitCode}${message.truncated?' · 输出已截断':''}`;
        const card=addCard(`${failed?'✗':'✓'} $ ${message.command} · ${status}`,message.output||'','tool',false,timestamp,target,false);card.details.classList.toggle('tool-error',!!failed);
      } else if (Array.isArray(message.content) && role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) addCard(null,part.text,'assistant',false,timestamp,target,false);
          else if (part.type === 'thinking' && (part.thinking||part.text)) addCard('Thinking',part.thinking||part.text,'thinking',false,timestamp,target,false);
          // Completed historical tools are represented by their toolResult message below.
        }
        const error=assistantError(message);if(error)addCard('LLM Error',error,'error',true,timestamp,target,false);
      } else if(role==='toolResult'){
        const failed=!!message.isError,content=textContent(message.content)||(failed?'执行失败':'执行完成');
        const card=addCard(`${failed?'✗':'✓'} ${message.toolName||'Tool'}`,content,'tool',false,timestamp,target,false);card.details.classList.toggle('tool-error',failed);
      } else { const content=textContent(message.content);if(content)addCard(['user','assistant'].includes(role)?null:role,content,role==='user'?'user':role==='assistant'?'assistant':'system',false,timestamp,target,false); }
    }
    if(target===$('messages'))$('messages').scrollTop=$('messages').scrollHeight;
  }
  function updateMessageHistoryControl() {
    $('messageHistoryControls')?.remove();if(state.messagePageStart<=0)return;
    const controls=document.createElement('div');controls.id='messageHistoryControls';controls.className='message-history-controls';
    const older=document.createElement('button');older.id='loadOlderMessages';older.type='button';older.textContent=`加载更早的对话（还有 ${state.messagePageStart} 条）`;older.onclick=()=>state.agent&&loadMessagePage(state.agent.agentId,state.messagePageStart,false).catch(error=>toast(error.message));
    const all=document.createElement('button');all.id='loadAllMessages';all.type='button';all.textContent='加载全部对话';all.onclick=()=>state.agent&&loadAllMessages(state.agent.agentId,all).catch(error=>toast(error.message));controls.append(older,all);$('messages').prepend(controls);
  }
  async function loadAllMessages(agentId,button) {
    button.disabled=true;button.textContent='正在加载全部对话…';
    try { const messages=await api(`/api/v1/agents/${agentId}/messages`);if(state.agent?.agentId!==agentId)return;const box=$('messages');box.replaceChildren();renderMessages(messages);state.messagePageStart=0;state.messageTotal=messages.length;updateMessageHistoryControl(); }
    finally { button.disabled=false;button.textContent='加载全部对话'; }
  }
  async function loadMessagePage(agentId,before,reset) {
    const query=new URLSearchParams({limit:String(state.messagePageSize)});if(before!==undefined)query.set('before',String(before));
    const page=await api(`/api/v1/agents/${agentId}/messages?${query}`);if(state.agent?.agentId!==agentId)return;
    const box=$('messages'),oldHeight=box.scrollHeight,oldTop=box.scrollTop,fragment=document.createDocumentFragment();renderMessages(page.items,fragment,false);
    if(reset){box.replaceChildren(fragment);state.messageTotal=page.total;}else{box.querySelector('#messageHistoryControls')?.remove();box.prepend(fragment);}
    state.messagePageStart=page.start;state.messageTotal=page.total;updateMessageHistoryControl();
    if(reset)box.scrollTop=box.scrollHeight;else box.scrollTop=oldTop+(box.scrollHeight-oldHeight);
    if(!page.total)box.innerHTML='<div class="empty">尚无消息</div>';
  }
  function ensureStream(key, title, kind) {
    if (!state.streams.has(key)) { const card=addCard(title,'',kind,true);card.kind=kind;card.renderFrame=null;state.streams.set(key,card); }
    return state.streams.get(key);
  }
  // Parsing and sanitizing the complete accumulated Markdown for every tiny
  // provider delta is O(n²) and can leave the browser minutes behind the agent.
  // Paint plain text at most once per animation frame and parse Markdown once
  // when the message finishes.
  function paintStream(card) {
    card.renderFrame=null;card.body.textContent=card.content;card.summaryText.textContent=(card.content.trim().split('\n')[0]||card.kind||'Assistant').slice(0,160);
    $('messages').scrollTop=$('messages').scrollHeight;
  }
  function scheduleStreamPaint(card) { if(card.renderFrame===null)card.renderFrame=requestAnimationFrame(()=>paintStream(card)); }
  function finalizeAgentStreams() {
    for(const key of ['assistant','thinking']){const card=state.streams.get(key);if(!card)continue;if(card.renderFrame!==null){cancelAnimationFrame(card.renderFrame);card.renderFrame=null;}renderCardBody(card.body,card.content,key==='assistant');card.summaryText.textContent=(card.content.trim().split('\n')[0]||key).slice(0,160);state.streams.delete(key);}
  }
  function discardStreams() { for(const card of state.streams.values())if(card.renderFrame!==null&&card.renderFrame!==undefined)cancelAnimationFrame(card.renderFrame);state.streams.clear();state.toolCards.clear(); }
  function extensionRequest(agentId, ev, timestamp) {
    const card = addCard(ev.title || `Extension ${ev.kind}`, ev.message || ev.placeholder || ev.prefill || '', 'dialog', true, timestamp);
    const controls = document.createElement('div'); controls.className = 'dialog-actions';
    const send = async value => { try { await post(`/api/v1/agents/${agentId}/extension-response`, {requestId:ev.requestId, value}); controls.replaceChildren(document.createTextNode('已响应')); } catch (e) { toast(e.message); } };
    if (ev.kind === 'select') for (const option of ev.options || []) { const b = document.createElement('button'); b.textContent = option; b.onclick = () => send(option); controls.append(b); }
    else if (ev.kind === 'confirm') { for (const [label, value] of [['否',false],['是',true]]) { const b=document.createElement('button');b.textContent=label;b.onclick=()=>send(value);controls.append(b); } }
    else { const input = ev.kind === 'editor' ? document.createElement('textarea') : document.createElement('input'); input.value = ev.prefill || ''; input.placeholder = ev.placeholder || ''; const b = document.createElement('button'); b.textContent = '提交'; b.onclick = () => send(input.value); controls.append(input,b); }
    card.body.append(controls);
  }
  function stopVoiceAudio() {
    state.voiceAudio.generation++;for(const source of state.voiceAudio.sources){try{source.stop();}catch{}}state.voiceAudio.sources.clear();state.voiceAudio.nextTime=0;state.voiceAudio.playbackId=null;
  }
  async function ensureAudioContext() {
    const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw Error('当前浏览器不支持音频播放');
    state.voiceAudio.context??=new AudioContext();if(state.voiceAudio.context.state==='suspended')await state.voiceAudio.context.resume();return state.voiceAudio.context;
  }
  function playVoiceChunk(event) {
    if(!state.voicePlaybackEnabled||!event.audio)return;const generation=state.voiceAudio.generation;
    state.voiceAudio.decodeChain=state.voiceAudio.decodeChain.then(async()=>{
      const context=await ensureAudioContext();if(generation!==state.voiceAudio.generation)return;state.voiceAudio.playbackId=event.playbackId;
      const raw=atob(event.audio),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));let buffer;
      if(event.encoding==='mp3')buffer=await context.decodeAudioData(bytes.buffer.slice(0));
      else{const samples=new Float32Array(Math.floor(bytes.length/2));for(let i=0;i<samples.length;i++){let value=bytes[i*2]|(bytes[i*2+1]<<8);if(value&0x8000)value-=0x10000;samples[i]=value/32768;}const rate=Number(event.sampleRate||24000);buffer=context.createBuffer(1,samples.length,rate);buffer.copyToChannel(samples,0);}
      if(generation!==state.voiceAudio.generation||state.voiceAudio.playbackId!==event.playbackId)return;const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);const start=Math.max(context.currentTime+0.03,state.voiceAudio.nextTime||0);source.start(start);state.voiceAudio.nextTime=start+buffer.duration;state.voiceAudio.sources.add(source);source.onended=()=>state.voiceAudio.sources.delete(source);
    }).catch(error=>toast(`语音播放失败：${error.message}`));
  }
  function handleVoiceEvent(message) {
    const ev=message.event||{},selected=state.selectedKind==='agent'&&state.agent?.agentId===message.agentId,key=`voice-${ev.playbackId||message.agentId}`;
    if(ev.type==='voice_start'){if(state.voicePlaybackEnabled)void ensureAudioContext().catch(()=>{});if(selected){const c=ensureStream(key,'语音摘要','voice');c.content='';renderCardBody(c.body,'正在生成语音摘要…',false);}}
    else if(ev.type==='voice_summary_delta'){if(selected){const c=ensureStream(key,'语音摘要','voice');c.content+=ev.text||'';renderCardBody(c.body,c.content,false);c.summaryText.textContent='语音摘要';}}
    else if(ev.type==='voice_audio_chunk')playVoiceChunk(ev);
    else if(ev.type==='voice_cancelled'){stopVoiceAudio();}
    else if(ev.type==='voice_error'){if(selected)addCard('语音服务',ev.message||'语音生成失败','error',true);}
    else if(ev.type==='voice_end'){if(selected)state.streams.delete(key);}
  }
  function updateVoiceButton(){const button=$('voicePlayback');button.textContent=state.voicePlaybackEnabled?'语音已启用':'启用语音';button.title=state.voicePlaybackEnabled?'点击关闭 Agent 语音摘要':'点击启用 Agent 语音摘要播放';}
  async function toggleVoicePlayback(){state.voicePlaybackEnabled=!state.voicePlaybackEnabled;localStorage.rpVoicePlayback=String(state.voicePlaybackEnabled);updateVoiceButton();if(state.voicePlaybackEnabled){try{await ensureAudioContext();toast('Agent 完成后将播放语音摘要');}catch(error){state.voicePlaybackEnabled=false;localStorage.rpVoicePlayback='false';updateVoiceButton();toast(error.message);}}else stopVoiceAudio();}
  async function toggleVoiceInput(){
    if(!state.voiceSttEnabled)return toast('服务端未启用语音识别');if(!state.agent)return toast('请先选择 Agent');
    if(state.mediaRecorder&&state.mediaRecorder.state==='recording'){state.mediaRecorder.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return toast('当前浏览器不支持麦克风录音');
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true}),preferred=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));state.mediaStream=stream;state.mediaChunks=[];state.mediaRecorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined);
      state.mediaRecorder.ondataavailable=event=>{if(event.data.size)state.mediaChunks.push(event.data)};
      state.mediaAgentId=state.agent.agentId;state.mediaRecorder.onstop=()=>void transcribeVoice();state.mediaRecorder.start(250);$('voiceInput').textContent='■';$('voiceInput').title='停止并识别';$('voiceInput').classList.add('recording');state.mediaTimer=setTimeout(()=>state.mediaRecorder?.state==='recording'&&state.mediaRecorder.stop(),60000);
    }catch(error){toast(`无法录音：${error.message}`);}
  }
  async function transcribeVoice(){
    clearTimeout(state.mediaTimer);const recorder=state.mediaRecorder,mime=recorder?.mimeType||'audio/webm',blob=new Blob(state.mediaChunks,{type:mime}),agentId=state.mediaAgentId;state.mediaStream?.getTracks().forEach(track=>track.stop());state.mediaRecorder=null;state.mediaStream=null;state.mediaChunks=[];state.mediaAgentId=null;$('voiceInput').textContent='…';$('voiceInput').classList.remove('recording');
    if(!agentId){$('voiceInput').textContent='🎙';return;}try{const response=await fetch(state.base+`/api/v1/agents/${agentId}/transcribe`,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,'Content-Type':mime,'X-Audio-Filename':mime.includes('mp4')?'recording.m4a':'recording.webm'},body:blob});const body=await response.json().catch(()=>({}));if(!response.ok)throw Error(body.error?.message||`HTTP ${response.status}`);const text=body.data?.text?.trim();if(text){const input=$('input'),prefix=input.value&& !/\s$/.test(input.value)?' ':'';input.value+=prefix+text;input.focus();toast('语音已转换为文字');}else toast('没有识别到语音');}catch(error){toast(`语音识别失败：${error.message}`);}finally{$('voiceInput').textContent='🎙';$('voiceInput').title='开始语音输入';}
  }
  function handleAgentEvent(message) {
    if(message.type==='voice_event'){handleVoiceEvent(message);return;}
    if (message.type === 'subscribed') {
      const key = `rpSeq:${message.agentId}`, saved = Number(localStorage[key] || 0), current = Number(message.currentSequence || 0);
      // Agent event sequences restart when the server restores an Agent. A cursor
      // from the previous process must not cause every new event to be discarded.
      if (saved > current) localStorage[key] = current;
      return;
    }
    if (message.type === 'agent_snapshot') {
      localStorage[`rpSeq:${message.agentId}`] = message.lastSequence; if (state.agent?.agentId === message.agentId) { discardStreams();$('messages').replaceChildren(); renderMessages(message.messages);state.messagePageStart=message.messagePage?.start||0;state.messageTotal=message.messagePage?.total??message.messages?.length??0;updateMessageHistoryControl(); } return;
    }
    if (message.type !== 'agent_event') return;
    const key = `rpSeq:${message.agentId}`, last = Number(localStorage[key] || 0); if (message.sequence <= last) return; localStorage[key] = message.sequence;
    const ev = message.event || {}, selected = state.selectedKind==='agent'&&state.agent?.agentId === message.agentId;
    let eventAgent=state.agents.find(x=>x.agentId===message.agentId);
    if(eventAgent&&Number(message.timestamp)>0)eventAgent.lastActiveAt=new Date(Number(message.timestamp)*1000).toISOString();
    if (ev.type === 'agent_start' || ev.type === 'auto_retry_start') eventAgent=setAgentStatus(message.agentId,'streaming')||eventAgent;
    else if (ev.type === 'agent_end') {
      const final=!ev.willRetry;eventAgent=setAgentStatus(message.agentId,final?'idle':'streaming')||eventAgent;
      if(final){if(selected)finalizeAgentStreams();notifyComplete(eventAgent||{agentId:message.agentId},message.timestamp);if(eventAgent)void loadAgentContexts([eventAgent]);}
    } else if (ev.type === 'agent_settled') { eventAgent=setAgentStatus(message.agentId,'idle')||eventAgent;if(eventAgent)void loadAgentContexts([eventAgent]); }
    else if (ev.type === 'session_info_changed') { if(eventAgent)eventAgent.sessionName=ev.name||undefined;if(selected)state.agent.sessionName=ev.name||undefined;renderAgentList();if(selected)updateAgentHeader(); }
    if (!selected) return;
    if (ev.type === 'agent_start') { $('messages').querySelector('.empty')?.remove(); }
    else if (ev.type === 'message_update') {
      const update = ev.assistantMessageEvent || {};
      if (update.type === 'text_delta') { const c=ensureStream('assistant',null,'assistant');c.content+=update.delta||'';scheduleStreamPaint(c); }
      else if (update.type === 'thinking_delta') {const c=ensureStream('thinking','Thinking','thinking');c.content+=update.delta||'';scheduleStreamPaint(c);}
    } else if (ev.type === 'message_end') {finalizeAgentStreams();const error=assistantError(ev.message);if(error)addCard('LLM Error',error,'error',true,message.timestamp);}
    else if (ev.type === 'tool_execution_start' || ev.type === 'tool_execution_update' || ev.type === 'tool_execution_end') upsertToolCard(ev, message.timestamp);
    else if (ev.type === 'bash_execution_update' || ev.type === 'bash_execution_end') updateBashCard(ev, message.timestamp);
    else if (ev.type === 'auto_retry_start' || ev.type === 'auto_retry_end') addCard('Retry', ev.errorMessage || ev.finalError || `${ev.type}${ev.attempt?` · attempt ${ev.attempt}`:''}`, 'system', false, message.timestamp);
    else if (String(ev.type).startsWith('summarization_retry')) addCard('Summarization Retry', ev.errorMessage || `${ev.type}${ev.attempt?` · ${ev.attempt}/${ev.maxAttempts}`:''}`, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_request') extensionRequest(message.agentId, ev, message.timestamp);
    else if (ev.type === 'extension_ui_notify') addCard(ev.notificationType || '通知', ev.message, 'system', false, message.timestamp);
    else if (ev.type === 'extension_ui_status') { ev.text ? state.extensionStatus.set(ev.key, ev.text) : state.extensionStatus.delete(ev.key); renderExtensionStatus(); }
    else if (ev.type === 'extension_ui_widget') { ev.content ? state.widgets.set(ev.key, ev.content) : state.widgets.delete(ev.key); renderWidgets(); }
    else if (ev.type === 'extension_ui_title') { state.agent.sessionName = ev.title; updateAgentHeader(); }
    else if (ev.type === 'extension_ui_working_message') { ev.message ? state.extensionStatus.set('working',ev.message) : state.extensionStatus.delete('working'); renderExtensionStatus(); }
    else if (!['message_start','agent_end','agent_settled','session_info_changed','turn_start','turn_end','model_select','thinking_level_select','thinking_level_changed'].includes(ev.type)) addCard(ev.title || ev.type || 'Event', JSON.stringify(ev, null, 2), 'system', false, message.timestamp);
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  function renderExtensionStatus() { let row=$('extensionStatus'); if (!state.extensionStatus.size) { row?.remove(); return; } if(!row){row=document.createElement('div');row.id='extensionStatus';row.className='status-row';$('widgets').after(row);} row.textContent=[...state.extensionStatus.values()].join(' · '); }
  function renderWidgets() { $('widgets').replaceChildren(...[...state.widgets.entries()].map(([key,value])=>{const el=document.createElement('div');el.className='widget';el.dataset.key=key;el.textContent=Array.isArray(value)?value.map(x=>typeof x==='string'?x:x.text||'').join('\n'):String(value);return el;})); }

  function connectSocket() {
    if (!state.connected) return;
    clearTimeout(state.reconnectTimer); state.manuallyClosed = true; const previous=state.ws; state.ws=null; previous?.close(); state.manuallyClosed = false;
    const ws = new WebSocket(state.base.replace(/^http/, 'ws') + '/api/v1/ws', ['access-token.' + state.token]); state.ws = ws;
    ws.onopen = () => { state.reconnectAttempt = 0; $('status').textContent = '已配对 · 实时'; for (const agent of state.agents) { const key=`rpSeq:${agent.agentId}`, cursor=localStorage[key]; ws.send(JSON.stringify(cursor===undefined?{type:'subscribe',agentId:agent.agentId,fromNow:true,messageLimit:state.messagePageSize}:{type:'subscribe',agentId:agent.agentId,lastSequence:Number(cursor),messageLimit:state.messagePageSize})); } ws.send(JSON.stringify({type:'subscribe_all',fromNow:true})); };
    ws.onmessage = event => { try { handleAgentEvent(JSON.parse(event.data)); } catch (error) { console.error(error); } };
    ws.onclose = () => { if (!state.connected || state.manuallyClosed || ws !== state.ws) return; $('status').textContent = '正在重连…'; const delays=[1000,2000,4000,8000,15000,30000], delay=delays[Math.min(state.reconnectAttempt++,delays.length-1)]; state.reconnectTimer=setTimeout(connectSocket,delay); };
    ws.onerror = () => {};
  }
  function notificationUnavailableReason() {
    if (!window.isSecureContext) return '浏览器通知需要 HTTPS；仅 localhost 可使用 HTTP';
    if (!('Notification' in window) || typeof Notification.requestPermission !== 'function') return '当前浏览器不支持系统通知';
    return '';
  }
  function updateNotificationButton() {
    const button=$('notifications'),status=$('browserNotificationStatus'),unavailable=notificationUnavailableReason();
    // Keep the button clickable so unsupported/denied states can explain how to
    // fix the problem instead of silently ignoring the user's click.
    button.disabled=false;
    if (unavailable) { button.textContent='通知不可用'; button.title=unavailable;status.textContent=unavailable; return; }
    button.textContent=Notification.permission==='granted'?'通知已启用':Notification.permission==='denied'?'通知已禁用':'启用通知';
    button.title=Notification.permission==='denied'?'通知权限已被浏览器阻止，点击查看处理方式':'启用所有 Agent 的完成通知';status.textContent=Notification.permission==='granted'?'Agent 完成后会显示浏览器系统通知。':Notification.permission==='denied'?'通知权限已被浏览器阻止。':'尚未授予浏览器通知权限。';
  }
  async function enableNotifications() {
    const unavailable=notificationUnavailableReason();
    if (unavailable) return toast(unavailable);
    if (Notification.permission==='denied') return toast('通知权限已被阻止，请在地址栏的网站权限中允许通知后刷新页面');
    try {
      const permission=await Notification.requestPermission(); updateNotificationButton();
      toast(permission==='granted'?'已启用所有 Agent 的完成通知':'未获得通知权限，请在浏览器的网站权限中开启');
    } catch (error) {
      console.error('Unable to request notification permission',error);
      toast(`无法请求通知权限：${error?.message||'请检查浏览器的网站权限'}`);
    }
  }
  function notifyComplete(agent, timestamp) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const occurredAt=Number(timestamp)||Math.floor(Date.now()/1000);
    try { new Notification('Agent 完成', {body:`${agentLabel(agent)} 已转为空闲\n本地时间：${new Date(occurredAt*1000).toLocaleString()}\nUnix 时间戳：${occurredAt}`, timestamp:occurredAt*1000, tag:`remote-pi-${agent.agentId}-${occurredAt}`}); } catch (error) { console.error('Unable to show notification',error); }
  }
  async function loadMailNotificationSettings(status) {
    if(status?.mailNotificationsConfigured===false){state.mailNotificationsAvailable=false;return}
    try{const result=await api('/api/v1/mail-notifications');state.mailNotificationsAvailable=!!result.available;if(result.settings)state.mailSettings={...state.mailSettings,...result.settings};}
    catch(error){state.mailNotificationsAvailable=false;console.error('Unable to load mail notification settings',error);}
  }
  function updateMailControls(){
    const available=state.connected&&state.mailNotificationsAvailable,settings=state.mailSettings;
    $('mailNotificationEnabled').checked=!!settings.enabled;$('mailAggregationDelay').value=String(settings.aggregationDelaySeconds??0);$('mailIncludeResponse').checked=!!settings.includeResponse;$('mailIncludeSessionDetails').checked=!!settings.includeSessionDetails;$('mailCollabEscalations').checked=!!settings.collabEscalations;
    for(const id of ['mailNotificationEnabled','mailAggregationDelay','mailIncludeResponse','mailIncludeSessionDetails','mailCollabEscalations','configSave'])$(id).disabled=!available;
    $('mailNotificationAvailability').textContent=!state.connected?'连接服务后可以配置邮件通知。':available?'MailDispatch 已在服务端配置。设置对所有 Agent 和客户端生效。':'服务端启动时未配置 MailDispatch endpoint、API key 和通知邮箱。';
  }
  function updateConfigUi(){
    $('configConnectionStatus').textContent=state.connected?`已连接 ${state.base}`:'当前未配对';updateNotificationButton();updateVoiceButton();updateMailControls();
  }
  function openConfig(){updateConfigUi();if(!$('configDialog').open)$('configDialog').showModal();}
  async function saveMailSettings(){
    if(!requireConnection())return;if(!state.mailNotificationsAvailable)return toast('服务端未配置 MailDispatch');
    const delay=Number($('mailAggregationDelay').value);if(!Number.isInteger(delay)||delay<0||delay>86400)return toast('聚合时间必须是 0 到 86400 之间的整数秒');
    $('configSave').disabled=true;
    try{const result=await post('/api/v1/mail-notifications',{enabled:$('mailNotificationEnabled').checked,aggregationDelaySeconds:delay,includeResponse:$('mailIncludeResponse').checked,includeSessionDetails:$('mailIncludeSessionDetails').checked,collabEscalations:$('mailCollabEscalations').checked});state.mailSettings=result.settings;updateMailControls();toast('邮件通知设置已保存');}
    catch(error){toast(error.message)}finally{$('configSave').disabled=!state.mailNotificationsAvailable;}
  }

  function modal(title, build, okText = '确定') {
    const dialog=$('modal'), body=$('modalBody'); $('modalTitle').textContent=title; $('modalOk').textContent=okText; body.replaceChildren(); const value=build(body);
    return new Promise(resolve => { const done=()=>{dialog.removeEventListener('close',done);resolve(dialog.returnValue==='default'?(typeof value==='function'?value():value):null);};dialog.addEventListener('close',done);dialog.showModal(); });
  }
  const field = (body, label, value='', type='text') => { const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.type=type;input.value=value;l.append(input);body.append(l);return input; };
  let agentContextTarget=null;
  function showItemContextMenu(event,kind,item){event.preventDefault();event.stopPropagation();agentContextTarget={kind,item};const archive=$('menuArchiveAgent'),active=kind==='agent'&&['starting','streaming','waiting_for_user','stopping'].includes(item.status),binding=kind==='agent'&&sessionKeyboard.getBinding(item.agentId);archive.hidden=kind!=='agent';archive.disabled=active;archive.title=active?'Agent 执行期间不能 Archive':'';$('menuBindKeyboard').hidden=kind!=='agent'||!!binding;$('menuBindKeyboard').disabled=!binding&&sessionKeyboard.getBindings().length>=6;$('menuBindKeyboard').title=$('menuBindKeyboard').disabled?'六个按键均已绑定':'';$('menuKeyboardColor').hidden=kind!=='agent'||!binding;$('menuUnbindKeyboard').hidden=kind!=='agent'||!binding;$('menuCloseTerminal').hidden=kind!=='terminal';const menu=$('agentContextMenu');menu.hidden=false;menu.style.left=`${Math.min(event.clientX,innerWidth-210)}px`;menu.style.top=`${Math.min(event.clientY,innerHeight-190)}px`;}
  async function bindKeyboardAgent(agent){
    const free=sessionKeyboard.getFreeSlots();
    if(!free.length)return toast('六个键盘按键均已绑定');
    const result=await modal('绑定键盘按键',body=>{const slotLabel=document.createElement('label');slotLabel.textContent='按键';const select=document.createElement('select');for(const slot of free){const option=document.createElement('option');option.value=String(slot);option.textContent=`按键 ${slot+1} / AG0${slot}`;select.append(option);}slotLabel.append(select);body.append(slotLabel);const color=field(body,'灯光颜色',sessionKeyboard.nextColor(),'color');return()=>({slot:Number(select.value),color:color.value});},'绑定');
    if(!result)return;sessionKeyboard.bind(agent.agentId,result.slot,result.color);toast(`已绑定到按键 ${result.slot+1}`);
  }
  async function changeKeyboardColor(agent){
    const binding=sessionKeyboard.getBinding(agent.agentId);if(!binding)return;
    const color=await modal('更换按键颜色',body=>{const input=field(body,`按键 ${binding.slot+1} 的颜色`,binding.color,'color');return()=>input.value;},'应用');
    if(color){sessionKeyboard.setColor(agent.agentId,color);toast(`按键 ${binding.slot+1} 颜色已更新`);}
  }
  async function createAgent() {
    if (!state.workspace) return toast('请先选择 Workspace');
    const cwd=$('agentCwd').value.trim()||'.'; let sessions=[]; try { sessions=await api(`/api/v1/sessions?workspaceId=${state.workspace.id}&path=${encodeURIComponent(cwd)}`); } catch(e){return toast(e.message);}
    const result=await modal('新建 Agent',body=>{const c=field(body,'工作路径',cwd);const l=document.createElement('label');l.textContent='Session';const s=document.createElement('select');s.innerHTML='<option value="">新 Session</option>'+sessions.map(x=>`<option value="${esc(x.path)}">${esc(x.name||x.sessionName||x.id||x.path)} · ${esc(x.modified||'')}</option>`).join('');l.append(s);body.append(l);return()=>({cwd:c.value.trim()||'.',sessionFile:s.value||undefined});},'创建');
    if (!result) return; try { const agent=await post('/api/v1/agents',{workspaceId:state.workspace.id,relativeCwd:result.cwd,sessionFile:result.sessionFile}),binding=result.sessionFile?null:autoBindNewSession(agent);await refreshAgents();await selectAgent(agent);if(binding)toast(`新 Session 已自动绑定到按键 ${binding.slot+1}`);}catch(e){toast(e.message);}
  }
  async function navigateAgent(entryId) {
    const agent=state.agent;if(!agent)return;
    const result=await post(`/api/v1/agents/${agent.agentId}/navigate`,{entryId});
    await selectAgent(agent);
    if(result.editorText!==undefined)$('input').value=result.editorText;
    toast(result.editorText!==undefined?'已回退到该用户输入，可编辑后重新发送':'已回退到所选输出');
  }
  async function showSessionTree() {
    if (!state.agent) return toast('请选择 Agent'); const session=await api(`/api/v1/agents/${state.agent.agentId}/session`); const entries=session.entries||[];
    const choice=await modal('Session Tree',body=>{const actionLabel=document.createElement('label');actionLabel.textContent='操作';const action=document.createElement('select');action.innerHTML='<option value="navigate">Navigate 到条目</option><option value="fork">从用户消息 Fork 新 Agent</option>';actionLabel.append(action);body.append(actionLabel);const list=document.createElement('div');list.className='modal-list';let selected='';for(const e of entries){const b=document.createElement('button');b.type='button';b.className='choice';const text=textContent(e.message?.content||e.content)||e.type;b.innerHTML=`${e.id===session.leafId?'● ':'○ '}${esc(text.slice(0,100))}<small>${esc(e.id)}</small>`;b.onclick=()=>{selected=e.id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>selected?{entryId:selected,action:action.value}:null;},'执行');
    if(choice){if(choice.action==='fork'){const result=await post(`/api/v1/agents/${state.agent.agentId}/fork`,{entryId:choice.entryId}),binding=autoBindNewSession(result.agent);await refreshAgents();await selectAgent(result.agent);if(binding)toast(`Fork Session 已自动绑定到按键 ${binding.slot+1}`);}else await navigateAgent(choice.entryId);}
  }
  async function revert() {
    if(!state.agent)return toast('请选择 Agent');const session=await api(`/api/v1/agents/${state.agent.agentId}/session`);
    const messages=(session.entries||[]).filter(e=>e.type==='message'&&['user','assistant'].includes(e.message?.role));
    if(!messages.length)return toast('当前 Session 没有可回退的消息');
    const selected=await modal('Undo（Session Tree）',body=>{const note=document.createElement('p');note.className='muted';note.textContent='选择用户输入会回到输入前并恢复文字；选择 Agent 输出会保留该输出、移除后续上下文。文件改动不会撤销。';body.append(note);const list=document.createElement('div');list.className='modal-list';let value=null;for(const e of [...messages].reverse()){const role=e.message.role==='user'?'You':'Agent',text=textContent(e.message.content)||'(空消息)';const b=document.createElement('button');b.type='button';b.className='choice';b.innerHTML=`<b>${role}</b> ${esc(text.slice(0,160))}<small>${esc(e.id)}${e.id===session.leafId?' · 当前':''}</small>`;b.onclick=()=>{value=e.id;list.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};list.append(b);}body.append(list);return()=>value;},'回退');
    if(selected)await navigateAgent(selected);
  }
  async function modelControls() {
    if(!state.agent)return toast('请选择 Agent');const cap=await api(`/api/v1/agents/${state.agent.agentId}/capabilities`);
    const result=await modal('模型与 Thinking',body=>{const ml=document.createElement('label');ml.textContent='模型';const m=document.createElement('select');for(const x of cap.models||[]){const o=document.createElement('option');o.value=JSON.stringify([x.provider,x.id]);o.textContent=`${x.provider} / ${x.name||x.id}`;o.selected=x.provider===cap.model?.provider&&x.id===cap.model?.id;m.append(o);}ml.append(m);body.append(ml);const tl=document.createElement('label');tl.textContent='Thinking level';const t=document.createElement('select');for(const x of cap.thinkingLevels||[]){const o=document.createElement('option');o.value=x;o.textContent=x;o.selected=x===cap.thinkingLevel;t.append(o);}tl.append(t);body.append(tl);return()=>({model:m.value?JSON.parse(m.value):null,thinking:t.value});});
    if(result){if(result.model)await post(`/api/v1/agents/${state.agent.agentId}/model`,{provider:result.model[0],modelId:result.model[1]});if(result.thinking)await post(`/api/v1/agents/${state.agent.agentId}/thinking`,{level:result.thinking});toast('设置已更新');}
  }

  $('pairCancel').onclick=()=>$('pairDialog').close();
  $('modalCancel').onclick=()=>$('modal').close('cancel');
  $('pairForm').onsubmit=async event=>{event.preventDefault();$('pairSubmit').disabled=true;try{await connect($('pairBase').value,$('pairToken').value);}catch(e){$('status').className='bad';$('status').textContent='连接失败';toast(e.message);}finally{$('pairSubmit').disabled=false;}};
  $('openConfig').onclick=openConfig;$('configClose').onclick=()=>$('configDialog').close();$('configSave').onclick=saveMailSettings;$('connect').onclick=openPair;$('keyboardConnect').onclick=async()=>{try{$('keyboardConnect').disabled=true;await sessionKeyboard.connect();}catch(error){toast(`键盘连接失败：${error.message}`);}finally{$('keyboardConnect').disabled=false;}};$('keyboardDisconnect').onclick=()=>sessionKeyboard.disconnect().catch(error=>toast(`键盘断开失败：${error.message}`));$('notifications').onclick=enableNotifications;$('voicePlayback').onclick=toggleVoicePlayback;$('voiceInput').onclick=toggleVoiceInput;$('api').onchange=()=>{state.base=$('api').value.replace(/\/$/,'');localStorage.rpBase=state.base;openPair();};
  $('refreshWs').onclick=()=>refreshWs().catch(e=>toast(e.message));$('addWs').onclick=async()=>{if(!requireConnection())return;const result=await modal('添加 Workspace',body=>{const n=field(body,'名称');const p=field(body,'主机绝对路径');return()=>({label:n.value.trim(),rootPath:p.value.trim()});},'添加');if(result?.label&&result.rootPath){await post('/api/v1/workspaces',result);await refreshWs();}};
  $('workspaces').onchange=selectWorkspace;$('agentPageSize').value=String(state.agentPageSize);$('agentPageSize').onchange=()=>{state.agentPageSize=Number($('agentPageSize').value)||10;state.agentVisibleCount=state.agentPageSize;localStorage.rpAgentPageSize=String(state.agentPageSize);renderAgentList();};$('loadMoreAgents').onclick=()=>{state.agentVisibleCount+=state.agentPageSize;renderAgentList();};$('treeRoot').onclick=()=>openDirectory('.');$('treeUp').onclick=()=>openDirectory(parentPath(state.treePath));$('mentionCurrent').onclick=()=>insertMention(state.treePath);$('terminalCurrent').onclick=()=>openTerminal(state.treePath);
  $('treePath').oncontextmenu=e=>showContextMenu(e,{relativePath:state.treePath,type:'directory'});enableLongPressMenu($('treePath'),e=>showContextMenu(e,{relativePath:state.treePath,type:'directory'}));$('filePrev').onclick=()=>openFile(state.filePath,Math.max(0,state.fileOffset-state.fileLimit),false);$('fileNext').onclick=()=>openFile(state.filePath,state.fileOffset+state.fileLimit,false);
  $('menuStartAgent').onclick=()=>startAgent(state.contextTarget.relativePath);$('menuOpenTerminal').onclick=()=>openTerminal(state.contextTarget.relativePath);$('menuSetCwd').onclick=()=>{$('agentCwd').value=state.contextTarget.relativePath;$('contextMenu').hidden=true;};$('menuMention').onclick=()=>{insertMention(state.contextTarget.relativePath);$('contextMenu').hidden=true;};$('menuBindKeyboard').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent)void bindKeyboardAgent(agent).catch(error=>toast(error.message));};$('menuKeyboardColor').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent)void changeKeyboardColor(agent).catch(error=>toast(error.message));};$('menuUnbindKeyboard').onclick=()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(agent&&sessionKeyboard.unbind(agent.agentId))toast('已取消键盘按键绑定');};$('menuCloseTerminal').onclick=()=>{const terminal=agentContextTarget?.kind==='terminal'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(terminal&&confirm('关闭这个 Terminal？正在运行的进程会被终止。'))void closeTerminal(terminal);};$('menuArchiveAgent').onclick=async()=>{const agent=agentContextTarget?.kind==='agent'?agentContextTarget.item:null;$('agentContextMenu').hidden=true;if(!agent||!confirm('Archive 这个 Agent？Pi Session 文件不会被修改。'))return;try{await post(`/api/v1/agents/${agent.agentId}/archive`);sessionKeyboard.unbind(agent.agentId);if(state.agent?.agentId===agent.agentId){state.agent=null;localStorage.removeItem('rpAgentId');$('agentTitle').textContent='请选择 Agent';$('agentStatus').textContent='';$('agentStateBadge').textContent='未选择';$('agentStateBadge').className='state-badge state-none';$('contextUsage').hidden=true;$('messages').innerHTML='<div class="empty">选择或创建 Agent 开始对话</div>'}await refreshAgents();toast('Agent 已 Archive')}catch(e){toast(e.message)}};document.addEventListener('click',e=>{if(!$('contextMenu').contains(e.target))$('contextMenu').hidden=true;if(!$('agentContextMenu').contains(e.target))$('agentContextMenu').hidden=true;});
  $('newAgent').onclick=createAgent;$('newTerminal').onclick=()=>openTerminal($('agentCwd').value.trim()||'.');$('abort').onclick=()=>{if(!state.agent)return;const id=state.agent.agentId;Promise.all([post(`/api/v1/agents/${id}/abort`),post(`/api/v1/agents/${id}/bash-abort`)]).catch(e=>toast(e.message));};$('stop').onclick=async()=>{if(state.agent&&confirm('停止这个 Agent？之后再次使用时会按需启动。')){await api(`/api/v1/agents/${state.agent.agentId}`,{method:'DELETE'});setAgentStatus(state.agent.agentId,'unloaded');}};
  $('sessionName').onclick=async()=>{if(!state.agent)return;const result=await modal('Session 名称',body=>{const n=field(body,'名称',state.agent.sessionName||'');return()=>n.value.trim();});if(result){const s=await post(`/api/v1/agents/${state.agent.agentId}/session-name`,{name:result});state.agent.sessionName=s.sessionName||result;updateAgentHeader();await refreshAgents();}};
  $('sessionTree').onclick=()=>showSessionTree().catch(e=>toast(e.message));$('undo').onclick=()=>revert().catch(e=>toast(e.message));$('controls').onclick=()=>modelControls().catch(e=>toast(e.message));$('compact').onclick=async()=>{if(!state.agent)return;const instructions=await modal('Compact',body=>{const n=field(body,'可选指令');return()=>n.value;},'开始');if(instructions!==null){await post(`/api/v1/agents/${state.agent.agentId}/compact`,{instructions:instructions||undefined});toast('Compact 完成');}};
  $('prompt').onsubmit=async event=>{event.preventDefault();if(!state.agent)return toast('请先创建或选择 Agent');const text=$('input').value.trim();if(!text)return;closeCommandPicker();const mode=$('sendMode').value,agentId=state.agent.agentId,sequenceBefore=localStorage[`rpSeq:${agentId}`];$('messages').querySelector('.empty')?.remove();
    // `!cmd` runs inside the Agent session (output is recorded in the Session); `!!cmd` keeps the output out of the model context.
    if(text.startsWith('!')){const excludeFromContext=text.startsWith('!!'),command=text.slice(excludeFromContext?2:1).trim();if(!command)return toast('请输入要执行的命令');addCard(null,text,'user');$('input').value='';
      try{await post(`/api/v1/agents/${agentId}/bash`,{command,excludeFromContext});if(state.agent?.agentId===agentId&&localStorage[`rpSeq:${agentId}`]===sequenceBefore){await loadMessagePage(agentId,undefined,true);state.toolCards.clear();}}catch(e){toast(`命令失败：${e.message}`);}return;}
    addCard(null,text,'user');$('input').value='';try{await post(`/api/v1/agents/${agentId}/${mode}`,{message:text});if(mode==='prompt'&&state.agent?.agentId===agentId&&localStorage[`rpSeq:${agentId}`]===sequenceBefore){await loadMessagePage(agentId,undefined,true);state.streams.clear();}}catch(e){addCard('发送失败',e.message,'error',true);}};
  $('input').onkeydown=event=>{if(!$('commandPicker').hidden){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setCommandSelection(state.commandIndex+(event.key==='ArrowDown'?1:-1));return;}if(event.key==='Tab'||(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)){event.preventDefault();chooseCommand(state.commandFiltered[state.commandIndex]);return;}if(event.key==='Escape'){event.preventDefault();closeCommandPicker();return;}}if(!$('mentionPicker').hidden){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setMentionSelection(state.mentionIndex+(event.key==='ArrowDown'?1:-1));return;}if(event.key==='Tab'||event.key==='Enter'){event.preventDefault();chooseMention(state.mentionFiltered[state.mentionIndex],event.key==='Enter');return;}if(event.key==='Escape'){event.preventDefault();closeMention();return;}}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){$('prompt').requestSubmit();}};$('input').oninput=()=>{const command=commandContext();if(command){if(!$('mentionPicker').hidden)closeMention();void openCommandPicker(command.query);return;}if(!$('commandPicker').hidden)closeCommandPicker();const context=mentionContext();if(!context){if(!$('mentionPicker').hidden)closeMention();return;}const fresh=$('mentionPicker').hidden||state.mentionStart!==context.start;state.mentionStart=context.start;state.mentionEnd=context.replacementEnd;if(fresh){state.mentionPrefix='';void openMention(state.treePath,context.query);return;}const filter=state.mentionPrefix&&context.query.startsWith(state.mentionPrefix)?context.query.slice(state.mentionPrefix.length):context.query;renderMentionItems(filter);};
  $('commandClose').onclick=closeCommandPicker;
  $('mentionUp').onclick=()=>browseMention(parentPath(state.mentionPath));$('mentionClose').onclick=closeMention;
  $('workspaceBack').onclick=()=>mobileBack('home');$('fileBack').onclick=()=>mobileBack('workspace');$('agentBack').onclick=()=>mobileBack('home');$('terminalBack').onclick=()=>mobileBack('home');$('terminalClear').onclick=()=>state.terminalEmulator?.clear();$('terminalClose').onclick=()=>{if(state.terminal&&confirm('关闭这个 Terminal？正在运行的进程会被终止。'))void closeTerminal();};
  $('mobileAgentActions').onclick=()=>$('mobileAgentActions').closest('.toolbar').classList.toggle('actions-open');
  document.querySelectorAll('.agent-action').forEach(button=>button.addEventListener('click',()=>button.closest('.toolbar').classList.remove('actions-open')));
  window.addEventListener('popstate',event=>setMobileView(event.state?.rpView||'home'));
  mobileMedia.addEventListener?.('change',event=>{if(event.matches)setMobileView('home',{replace:true});});
  window.addEventListener('beforeunload',()=>{state.manuallyClosed=true;state.ws?.close();state.terminalWs?.close();state.mediaRecorder?.state==='recording'&&state.mediaRecorder.stop();stopVoiceAudio();});
  window.addEventListener('focus',updateNotificationButton);
  setMobileView('home', {replace:true}); updateConfigUi(); updateKeyboardUi();void sessionKeyboard.restoreAuthorized();openPair();
})();
