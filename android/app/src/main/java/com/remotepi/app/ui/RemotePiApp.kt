@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.remotepi.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.remotepi.app.data.*

@Composable fun RemotePiApp(vm: RemotePiViewModel) {
    val state by vm.state.collectAsState()
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
        Surface(Modifier.fillMaxSize()) {
            when (state.screen) {
                Screen.SERVERS -> ServerListScreen(state, vm)
                Screen.HOME -> HomeScreen(state, vm)
                Screen.BROWSER -> BrowserScreen(state, vm)
                Screen.CONVERSATION -> ConversationScreen(state, vm)
            }
            state.extensionRequest?.let { ExtensionDialog(it, vm::respondExtension) }
            state.error?.let { error -> AlertDialog(onDismissRequest = vm::clearError, confirmButton = { TextButton(onClick = vm::clearError) { Text("确定") } }, title = { Text("操作失败") }, text = { Text(error) }) }
        }
    }
}

@Composable private fun ServerListScreen(state: AppState, vm: RemotePiViewModel) {
    var editing by remember { mutableStateOf<ServerProfile?>(null) }; var adding by remember { mutableStateOf(false) }
    Scaffold(topBar = { TopAppBar(title = { Text("Remote Pi Servers") }, actions = { IconButton(onClick = { adding = true }) { Icon(Icons.Default.Add, "添加") } }) }) { padding ->
        if (state.profiles.isEmpty()) Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { Button(onClick = { adding = true }) { Text("添加 Server") } }
        else LazyColumn(Modifier.padding(padding)) { items(state.profiles, key = { it.id }) { profile ->
            ListItem(headlineContent = { Text(profile.name, fontWeight = FontWeight.SemiBold) }, supportingContent = { Text(profile.baseUrl) },
                leadingContent = { Icon(Icons.Default.Dns, null) }, trailingContent = { Row { IconButton(onClick = { editing = profile }) { Icon(Icons.Default.Edit, "编辑") }; IconButton(onClick = { vm.deleteServer(profile) }) { Icon(Icons.Default.Delete, "删除") } } },
                modifier = Modifier.fillMaxWidth().combinedClickable(onClick = { vm.connect(profile) }, onLongClick = { editing = profile }))
            HorizontalDivider()
        } }
        if (state.connecting) LinearProgressIndicator(Modifier.fillMaxWidth().padding(padding))
    }
    if (adding || editing != null) ServerDialog(editing, { adding = false; editing = null }) { id, name, url, token -> adding = false; editing = null; vm.saveServer(id, name, url, token) }
}

@Composable private fun ServerDialog(profile: ServerProfile?, dismiss: () -> Unit, save: (String?, String, String, String) -> Unit) {
    var name by remember { mutableStateOf(profile?.name.orEmpty()) }; var url by remember { mutableStateOf(profile?.baseUrl ?: "https://") }; var token by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = dismiss, title = { Text(if (profile == null) "添加 Server" else "编辑 Server") }, text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("名称") }, singleLine = true)
        OutlinedTextField(url, { url = it }, label = { Text("Server URL") }, singleLine = true)
        OutlinedTextField(token, { token = it }, label = { Text(if (profile == null) "Access Token" else "Access Token（重新输入）") }, singleLine = true)
        Text("Release 版本仅允许 HTTPS。Token 由 Android Keystore 加密保存。", style = MaterialTheme.typography.bodySmall)
    } }, confirmButton = { Button(enabled = url.isNotBlank() && token.isNotBlank(), onClick = { save(profile?.id, name, url, token) }) { Text("测试并保存") } }, dismissButton = { TextButton(onClick = dismiss) { Text("取消") } })
}

@Composable private fun HomeScreen(state: AppState, vm: RemotePiViewModel) {
    var createFor by remember { mutableStateOf<Workspace?>(null) }
    var addingWorkspace by remember { mutableStateOf(false) }
    var choosingWorkspace by remember { mutableStateOf(false) }
    LaunchedEffect(createFor) { createFor?.let { vm.loadSessions(it,".") } }
    fun startAgentCreation() { if (state.workspaces.size == 1) createFor = state.workspaces.first() else choosingWorkspace = true }
    Scaffold(
        topBar = { TopAppBar(title = { Column { Text(state.activeProfile?.name ?: "Remote Pi"); Text(state.activeProfile?.baseUrl.orEmpty(), style = MaterialTheme.typography.labelSmall) } }, actions = {
            IconButton(onClick = { addingWorkspace = true }) { Icon(Icons.Default.CreateNewFolder, "添加 Workspace") }
            IconButton(onClick = vm::refresh) { Icon(Icons.Default.Refresh, "刷新") }
            IconButton(onClick = vm::showServers) { Icon(Icons.Default.Storage, "Servers") }
        }) },
        floatingActionButton = { if (state.workspaces.isNotEmpty()) ExtendedFloatingActionButton(onClick = ::startAgentCreation, icon = { Icon(Icons.Default.Add, null) }, text = { Text("创建 Agent") }) }
    ) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item { SectionTitle("Workspaces") }
            if (state.workspaces.isEmpty()) item { Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) { Text("还没有 Workspace"); Button(onClick = { addingWorkspace = true }, modifier = Modifier.padding(top = 12.dp)) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(8.dp)); Text("添加 Workspace") } } }
            items(state.workspaces, key = { it.id }) { workspace -> ListItem(headlineContent = { Text(workspace.label) }, supportingContent = { Text(workspace.rootPath) }, leadingContent = { Icon(Icons.Default.Folder, null) }, trailingContent = { IconButton(onClick = { createFor = workspace }) { Icon(Icons.Default.AddCircle, "创建 Agent") } }, modifier = Modifier.fillMaxWidth().combinedClickable(onClick = { vm.browse(workspace) }, onLongClick = { createFor = workspace })); HorizontalDivider() }
            item { SectionTitle("Agents") }
            if (state.agents.isEmpty()) item { Text(if (state.workspaces.isEmpty()) "请先添加 Workspace。" else "暂无 Agent，点击右下角按钮创建。", Modifier.padding(16.dp, 16.dp, 16.dp, 96.dp)) }
            items(state.agents, key = { it.agentId }) { agent -> ListItem(headlineContent = { Text(state.agentNames[agent.agentId] ?: agent.agentId.take(20)) }, supportingContent = { Text("${agent.agentId.take(16)} · ${agent.status} · ${agent.cwd}") }, leadingContent = { StatusDot(agent.status) }, trailingContent = { IconButton(onClick = { vm.stopAgent(agent) }) { Icon(Icons.Default.Stop, "停止 Agent") } }, modifier = Modifier.fillMaxWidth().combinedClickable(onClick = { vm.openAgent(agent) }, onLongClick = { vm.stopAgent(agent) })); HorizontalDivider() }
        }
    }
    if (addingWorkspace) WorkspaceDialog({ addingWorkspace = false }) { label, path -> addingWorkspace = false; vm.addWorkspace(label, path) }
    if (choosingWorkspace) AlertDialog(onDismissRequest = { choosingWorkspace = false }, title = { Text("选择 Workspace") }, text = { Column { state.workspaces.forEach { workspace -> TextButton(onClick = { choosingWorkspace = false; createFor = workspace }) { Text("${workspace.label}\n${workspace.rootPath}") } } } }, confirmButton = {})
    createFor?.let { workspace -> CwdDialog(workspace,state.sessions, { createFor = null }) { cwd,session -> createFor = null; vm.createAgent(workspace, cwd,session) } }
}

@Composable private fun WorkspaceDialog(dismiss: () -> Unit, add: (String,String) -> Unit) { var label by remember { mutableStateOf("") }; var path by remember { mutableStateOf("") }; AlertDialog(onDismissRequest = dismiss, title = { Text("添加 Workspace") }, text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { OutlinedTextField(label, { label = it }, label = { Text("名称") }, singleLine = true); OutlinedTextField(path, { path = it }, label = { Text("Remote 主机绝对路径") }, supportingText = { Text("例如 /home/user/project") }, singleLine = true) } }, confirmButton = { Button(enabled = label.isNotBlank() && path.startsWith('/'), onClick = { add(label.trim(), path.trim()) }) { Text("添加") } }, dismissButton = { TextButton(onClick = dismiss) { Text("取消") } }) }

@Composable private fun SectionTitle(text: String) { Text(text, Modifier.fillMaxWidth().padding(16.dp, 18.dp, 16.dp, 8.dp), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
@Composable private fun StatusDot(status: String) { val color = when (status) { "streaming" -> Color(0xff16a34a); "error" -> Color.Red; "stopped", "unloaded" -> Color.Gray; else -> Color(0xff2563eb) }; Icon(Icons.Default.Circle, status, tint = color, modifier = Modifier.size(14.dp)) }
@Composable private fun CwdDialog(workspace: Workspace, sessions:List<SessionInfo>, dismiss: () -> Unit, create: (String,String?) -> Unit) { var cwd by remember { mutableStateOf(".") };var session by remember { mutableStateOf<String?>(null) }; AlertDialog(onDismissRequest = dismiss, title = { Text("创建或恢复 Agent") }, text = { Column { Text(workspace.label); OutlinedTextField(cwd, { cwd = it }, label = { Text("Workspace 内相对路径") }, singleLine = true);Text("Session",Modifier.padding(top=12.dp),fontWeight=FontWeight.Bold);FilterChip(selected=session==null,onClick={session=null},label={Text("新 Session")});sessions.take(5).forEach { item->FilterChip(selected=session==item.path,onClick={session=item.path},label={Text(item.name?:item.firstMessage.ifBlank { item.id.take(12) })}) } } }, confirmButton = { Button(onClick = { create(cwd.ifBlank { "." },session) }) { Text("打开") } }, dismissButton = { TextButton(onClick = dismiss) { Text("取消") } }) }

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun BrowserScreen(state: AppState, vm: RemotePiViewModel) {
    var createHere by remember { mutableStateOf(false) }; val workspace = state.workspace ?: return
    Scaffold(topBar = { TopAppBar(navigationIcon = { IconButton(onClick = vm::goHome) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }, title = { Column { Text(workspace.label); Text(state.treePath, style = MaterialTheme.typography.labelSmall) } }, actions = { IconButton(onClick = { createHere = true }) { Icon(Icons.Default.SmartToy, "在此创建 Agent") } }) }) { padding ->
        Column(Modifier.padding(padding)) {
            if (state.treePath != ".") ListItem(headlineContent = { Text("..") }, leadingContent = { Icon(Icons.Default.DriveFolderUpload, null) }, modifier = Modifier.combinedClickable(onClick = vm::up, onLongClick = vm::up))
            LazyColumn(Modifier.weight(if (state.file == null) 1f else .45f)) { items(state.entries, key = { it.name }) { entry -> ListItem(headlineContent = { Text(entry.name) }, supportingContent = { if (entry.type != "directory") Text("${entry.size} bytes") }, leadingContent = { Icon(if (entry.type == "directory") Icons.Default.Folder else Icons.Default.Description, null) }, modifier = Modifier.combinedClickable(onClick = { vm.openEntry(entry) }, onLongClick = { vm.openEntry(entry) })); HorizontalDivider() } }
            state.file?.let { file -> FilePreview(file, vm::nextFilePage) }
        }
    }
    if (createHere) AlertDialog(onDismissRequest = { createHere = false }, title = { Text("在当前目录创建 Agent？") }, text = { Text(state.treePath) }, confirmButton = { Button(onClick = { createHere = false; vm.createAgent(workspace, state.treePath) }) { Text("创建") } }, dismissButton = { TextButton(onClick = { createHere = false }) { Text("取消") } })
}

@Composable private fun FilePreview(file: FileContent, next: () -> Unit) { Card(Modifier.fillMaxWidth().padding(8.dp)) { Column(Modifier.padding(12.dp)) { Text("${file.path} · ${file.offset + file.limit}/${file.size} bytes", style = MaterialTheme.typography.labelMedium); HorizontalDivider(Modifier.padding(vertical = 8.dp)); SelectionContainer { Text(if (file.binary) "二进制文件，无法预览" else file.content.orEmpty(), fontFamily = FontFamily.Monospace) }; if (file.offset + file.limit < file.size) TextButton(onClick = next) { Text("下一页") } } } }

@Composable private fun ConversationScreen(state: AppState, vm: RemotePiViewModel) {
    var input by remember { mutableStateOf("") }; var mode by remember { mutableStateOf("prompt") }; var settings by remember { mutableStateOf(false) }; var renaming by remember { mutableStateOf(false) }; var reverting by remember { mutableStateOf(false) }; val list = rememberLazyListState()
    fun applyMention(value: String?) { if (value == null) return; val at=input.lastIndexOf('@');input=(if(at>=0)input.substring(0,at) else input)+value+" ";vm.cancelMention() }
    LaunchedEffect(state.composerDraft) { state.composerDraft?.let { input=it;vm.clearComposerDraft() } }
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text?.length) { if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.lastIndex) }
    Scaffold(topBar = { TopAppBar(navigationIcon = { IconButton(onClick = vm::goHome) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }, title = { Column { Text(state.sessionDetails?.sessionName ?: state.extensionTitle ?: state.agent?.agentId?.take(20) ?: "Agent"); Text("${state.agent?.status} · WS ${state.socketStatus}${state.extensionStatus?.let { " · $it" }?:""}", style = MaterialTheme.typography.labelSmall) } }, actions = { IconButton(onClick = {renaming=true}) {Icon(Icons.Default.Edit,"修改 Session 名称")}; IconButton(onClick = {reverting=true}) {Icon(Icons.AutoMirrored.Filled.Undo,"Revert")}; IconButton(onClick = {settings=true}) {Icon(Icons.Default.Tune,"控制")}; IconButton(onClick = vm::abort) { Icon(Icons.Default.StopCircle, "Abort", tint = MaterialTheme.colorScheme.error) } }) }, bottomBar = { Column(Modifier.imePadding().navigationBarsPadding().padding(8.dp)) {
        if(state.mentionPath!=null) MentionPicker(state,vm,::applyMention)
        Row { listOf("prompt", "steer", "follow-up").forEach { value -> FilterChip(selected = mode == value, onClick = { mode = value }, label = { Text(value) }, modifier = Modifier.padding(end = 6.dp)) } }
        Row(verticalAlignment = Alignment.Bottom) { OutlinedTextField(input, { value->input=value;if(value.endsWith('@'))vm.startMention() }, modifier = Modifier.weight(1f), label = { Text("消息（输入 @ 选择路径）") }, maxLines = 5); IconButton(enabled = input.isNotBlank(), onClick = { val text = input.trim(); input = "";vm.cancelMention(); vm.send(text, mode) }) { Icon(Icons.AutoMirrored.Filled.Send, "发送") } }
    } }) { padding -> LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 8.dp), contentPadding = PaddingValues(vertical = 8.dp)) { if(state.extensionWidgets.isNotEmpty()) item {Card(Modifier.fillMaxWidth().padding(4.dp)){Column(Modifier.padding(8.dp)){state.extensionWidgets.forEach{(key,lines)->Text(key,fontWeight=FontWeight.Bold);lines.forEach{Text(it)}}}}}; items(state.messages, key = { it.key }) { MessageCard(it) } } }
    if(settings) AgentControlsDialog(state,{settings=false},vm)
    if(renaming) SessionNameDialog(state.sessionDetails?.sessionName.orEmpty(),{renaming=false}){name->vm.setSessionName(name);renaming=false}
    if(reverting) RevertDialog(state.sessionDetails?.userMessages.orEmpty(),{reverting=false}){entryId->reverting=false;vm.fork(entryId)}
}

@Composable private fun MentionPicker(state:AppState,vm:RemotePiViewModel,choose:(String?)->Unit){
    Card(Modifier.fillMaxWidth().heightIn(max=280.dp)){Column {
        Row(verticalAlignment=Alignment.CenterVertically){IconButton(onClick=vm::mentionUp,enabled=state.mentionPath!="."){Icon(Icons.Default.ArrowUpward,"上级")};Text(state.mentionPath?:".",Modifier.weight(1f),maxLines=1);TextButton(onClick={choose(vm.mentionText())}){Text("选择目录")};IconButton(onClick=vm::cancelMention){Icon(Icons.Default.Close,"取消")}}
        LazyColumn {items(state.mentionEntries,key={it.name}){entry->
            val open:()->Unit=if(entry.type=="directory"){{vm.openMentionDirectory(entry.name)}}else{{choose(vm.mentionText(entry.name))}}
            ListItem(headlineContent={Text(entry.name)},leadingContent={Icon(if(entry.type=="directory")Icons.Default.Folder else Icons.Default.Description,null)},trailingContent={if(entry.type=="directory")IconButton(onClick={choose(vm.mentionText(entry.name))}){Icon(Icons.Default.Add,"引用目录")}},modifier=Modifier.fillMaxWidth().combinedClickable(onClick=open,onLongClick={choose(vm.mentionText(entry.name))}))
        }}
    }}
}

@Composable private fun AgentControlsDialog(state:AppState,dismiss:()->Unit,vm:RemotePiViewModel){val caps=state.capabilities;var name by remember(state.sessionDetails?.sessionId){mutableStateOf(state.sessionDetails?.sessionName.orEmpty())};AlertDialog(onDismissRequest=dismiss,title={Text("Agent 控制")},text={LazyColumn {item{Text("Session 名称",fontWeight=FontWeight.Bold);Row(verticalAlignment=Alignment.CenterVertically){OutlinedTextField(name,{name=it},Modifier.weight(1f),singleLine=true);IconButton(enabled=name.isNotBlank(),onClick={vm.setSessionName(name)}){Icon(Icons.Default.Save,"保存名称")}};Text("Model",Modifier.padding(top=12.dp),fontWeight=FontWeight.Bold)};items(caps?.models.orEmpty()){model->FilterChip(selected=model.provider==caps?.model?.provider&&model.id==caps.model?.id,onClick={vm.setModel(model)},label={Text("${model.provider}/${model.name?:model.id}")})};item{Text("Thinking",Modifier.padding(top=12.dp),fontWeight=FontWeight.Bold);Row {caps?.thinkingLevels.orEmpty().forEach {level->FilterChip(selected=level==caps?.thinkingLevel,onClick={vm.setThinking(level)},label={Text(level)},modifier=Modifier.padding(end=4.dp))}};Button(onClick={vm.compact()}){Text("Compact")};Text("Session tree",Modifier.padding(top=12.dp),fontWeight=FontWeight.Bold)};items(state.sessionDetails?.entries.orEmpty().takeLast(20)){entry->val obj=entry.asJsonObject;val id=obj.get("id")?.asString.orEmpty();Row {TextButton(enabled=id.isNotEmpty(),onClick={vm.navigate(id)}){Text("${obj.get("type")?.asString}: ${id.take(10)}")};TextButton(enabled=id.isNotEmpty(),onClick={vm.fork(id)}){Text("Fork")}}}}},confirmButton={TextButton(onClick=dismiss){Text("关闭")}})}

@Composable private fun ExtensionDialog(request:ExtensionRequest,respond:(Any?)->Unit){var text by remember(request.requestId){mutableStateOf(request.prefill?:"")};when(request.kind){"select"->AlertDialog(onDismissRequest={respond(null)},title={Text(request.title)},text={Column {request.options.forEach {option->TextButton(onClick={respond(option)}){Text(option)}}}},confirmButton={});"confirm"->AlertDialog(onDismissRequest={respond(false)},title={Text(request.title)},text={Text(request.message)},confirmButton={Button(onClick={respond(true)}){Text("确认")}},dismissButton={TextButton(onClick={respond(false)}){Text("取消")}});else->AlertDialog(onDismissRequest={respond(null)},title={Text(request.title)},text={OutlinedTextField(text,{text=it},label={Text(request.placeholder?:if(request.kind=="editor")"内容" else "输入")},minLines=if(request.kind=="editor")5 else 1)},confirmButton={Button(onClick={respond(text)}){Text("提交")}},dismissButton={TextButton(onClick={respond(null)}){Text("取消")}})}}

@Composable private fun SessionNameDialog(current:String,dismiss:()->Unit,save:(String)->Unit){var name by remember(current){mutableStateOf(current)};AlertDialog(onDismissRequest=dismiss,title={Text(if(current.isBlank())"命名 Session" else "修改 Session 名称")},text={OutlinedTextField(name,{name=it},singleLine=true,label={Text("名称")})},confirmButton={Button(enabled=name.isNotBlank(),onClick={save(name.trim())}){Text("保存")}},dismissButton={TextButton(onClick=dismiss){Text("取消")}})}

@Composable private fun RevertDialog(points:List<RevertPoint>,dismiss:()->Unit,revert:(String)->Unit){AlertDialog(onDismissRequest=dismiss,title={Text("Revert / Fork")},text={if(points.isEmpty())Text("没有可恢复的用户消息")else LazyColumn {items(points.asReversed(),key={it.entryId}){point->ListItem(headlineContent={Text(point.text.take(80))},supportingContent={Text(point.entryId.take(12))},modifier=Modifier.clickable{revert(point.entryId)})}}},confirmButton={TextButton(onClick=dismiss){Text("取消")}})}

@Composable private fun MessageCard(item: ChatItem) {
    var expanded by rememberSaveable(item.key){mutableStateOf(false)};val user=item.role=="user"
    val color=when(item.kind){ChatItem.Kind.TOOL->MaterialTheme.colorScheme.secondaryContainer;ChatItem.Kind.THINKING->MaterialTheme.colorScheme.surfaceVariant;ChatItem.Kind.SYSTEM->MaterialTheme.colorScheme.errorContainer;else->if(user)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant}
    val title=item.collapsedTitle()
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(user)Arrangement.End else Arrangement.Start){Card(colors=CardDefaults.cardColors(containerColor=color),modifier=Modifier.padding(vertical=4.dp).widthIn(max=640.dp).clickable{expanded=!expanded}){Column(Modifier.padding(12.dp)){Row(verticalAlignment=Alignment.CenterVertically){Icon(if(expanded)Icons.Default.ExpandLess else Icons.Default.ExpandMore,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text(if(title.isBlank())item.role else title,Modifier.weight(1f),maxLines=1,fontWeight=FontWeight.SemiBold);Text(item.role,style=MaterialTheme.typography.labelSmall)};if(expanded){HorizontalDivider(Modifier.padding(vertical=8.dp));SelectionContainer{Text(item.text,fontFamily=if(item.kind==ChatItem.Kind.TOOL)FontFamily.Monospace else FontFamily.Default)}}}}}
}
