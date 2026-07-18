package com.remotepi.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.google.gson.JsonElement
import com.remotepi.app.BuildConfig
import com.remotepi.app.data.*
import com.remotepi.app.network.AgentSocket
import com.remotepi.app.network.RemotePiClient
import com.remotepi.app.security.SecureTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.util.UUID

enum class Screen { SERVERS, HOME, BROWSER, CONVERSATION }
data class AppState(
    val screen: Screen = Screen.SERVERS, val profiles: List<ServerProfile> = emptyList(), val activeProfile: ServerProfile? = null,
    val connecting: Boolean = false, val error: String? = null, val workspaces: List<Workspace> = emptyList(),
    val workspace: Workspace? = null, val treePath: String = ".", val entries: List<TreeEntry> = emptyList(),
    val file: FileContent? = null, val agents: List<AgentSummary> = emptyList(), val agent: AgentSummary? = null,
    val messages: List<ChatItem> = emptyList(), val socketStatus: String = "disconnected",
    val capabilities: AgentCapabilities? = null, val sessionDetails: SessionDetails? = null, val sessions: List<SessionInfo> = emptyList(),
    val extensionRequest: ExtensionRequest? = null, val extensionStatus: String? = null, val extensionTitle: String? = null, val extensionWidgets: Map<String,List<String>> = emptyMap()
)

class RemotePiViewModel(private val profiles: ProfileStore, private val tokens: SecureTokenStore) : ViewModel() {
    private val mutable = MutableStateFlow(AppState(profiles = profiles.list()))
    val state = mutable.asStateFlow()
    private var client: RemotePiClient? = null
    private var socket: AgentSocket? = null
    private var streamKey = UUID.randomUUID().toString()

    init { profiles.selectedId()?.let { id -> mutable.value.profiles.find { it.id == id }?.let(::connect) } }
    private fun update(block: (AppState) -> AppState) { mutable.value = block(mutable.value) }
    private fun fail(error: Throwable) { update { it.copy(connecting = false, error = error.message ?: "Request failed") } }
    fun clearError() = update { it.copy(error = null) }

    fun saveServer(id: String?, name: String, url: String, token: String) {
        val normalized = url.trim().trimEnd('/')
        if (!BuildConfig.DEBUG && !normalized.startsWith("https://")) { fail(IllegalArgumentException("Release builds require HTTPS")); return }
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) { fail(IllegalArgumentException("URL must start with http:// or https://")); return }
        val profile = ServerProfile(id ?: UUID.randomUUID().toString(), name.trim().ifBlank { normalized }, normalized)
        profiles.save(profile); tokens.put(profile.id, token); update { it.copy(profiles = profiles.list()) }; connect(profile)
    }
    fun deleteServer(profile: ServerProfile) {
        if (mutable.value.activeProfile?.id == profile.id) disconnect()
        profiles.delete(profile.id); tokens.remove(profile.id); update { it.copy(profiles = profiles.list()) }
    }
    fun connect(profile: ServerProfile) {
        val token = tokens.get(profile.id) ?: return fail(IllegalStateException("Access token is missing"))
        update { it.copy(connecting = true, error = null) }
        viewModelScope.launch { runCatching {
            val api = RemotePiClient(profile.baseUrl, token)
            withContext(Dispatchers.IO) { api.login(); val status=api.status();if(status.protocolVersion!=1)throw RemotePiException("PROTOCOL_INCOMPATIBLE","Server protocol ${status.protocolVersion} is not supported") }
            val (workspaces, agents) = withContext(Dispatchers.IO) { api.workspaces() to api.agents() }
            client = api; profiles.select(profile.id)
            update { it.copy(screen = Screen.HOME, activeProfile = profile.copy(lastConnectedAt = Instant.now().toString()), connecting = false, workspaces = workspaces, agents = agents) }
        }.onFailure(::fail) }
    }
    fun disconnect() { socket?.close(); socket = null; client = null; update { AppState(profiles = profiles.list()) } }
    fun goHome() { socket?.close(); socket = null; update { it.copy(screen = Screen.HOME, file = null) }; refresh() }
    fun showServers() = update { it.copy(screen = Screen.SERVERS) }
    fun refresh() { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.workspaces() to api.agents() } }.onSuccess { pair -> update { it.copy(workspaces = pair.first, agents = pair.second) } }.onFailure(::fail) } }

    fun addWorkspace(label: String, rootPath: String) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.addWorkspace(label, rootPath) } }.onSuccess { workspace -> update { it.copy(workspaces = it.workspaces + workspace) } }.onFailure(::fail) } }
    fun browse(workspace: Workspace, path: String = ".") {
        val api = client ?: return
        update { it.copy(screen = Screen.BROWSER, workspace = workspace, treePath = path, file = null) }
        viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.tree(workspace.id, path) } }.onSuccess { entries -> update { it.copy(entries = entries) } }.onFailure(::fail) }
    }
    fun openEntry(entry: TreeEntry) {
        val current = mutable.value; val workspace = current.workspace ?: return
        val path = if (current.treePath == ".") entry.name else "${current.treePath}/${entry.name}"
        if (entry.type == "directory") browse(workspace, path) else loadFile(workspace, path)
    }
    fun up() { val s = mutable.value; val workspace = s.workspace ?: return; browse(workspace, s.treePath.substringBeforeLast('/', ".")) }
    private fun loadFile(workspace: Workspace, path: String, offset: Long = 0) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.file(workspace.id, path, offset) } }.onSuccess { file -> update { it.copy(file = file) } }.onFailure(::fail) } }
    fun nextFilePage() { val s = mutable.value; val f = s.file ?: return; val ws = s.workspace ?: return; if (f.offset + f.limit < f.size) loadFile(ws, f.path, f.offset + f.limit) }

    fun createAgent(workspace: Workspace, cwd: String, sessionFile: String? = null) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.createAgent(workspace.id, cwd, sessionFile) } }.onSuccess { agent -> update { it.copy(agents = it.agents + agent) }; openAgent(agent) }.onFailure(::fail) } }
    fun loadSessions(workspace: Workspace, cwd: String) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.sessions(workspace.id, cwd) } }.onSuccess { sessions -> update { it.copy(sessions = sessions) } }.onFailure(::fail) } }
    fun stopAgent(agent: AgentSummary) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.stop(agent.agentId) } }.onSuccess { refresh() }.onFailure(::fail) } }
    fun openAgent(agent: AgentSummary) {
        val api = client ?: return; socket?.close()
        update { it.copy(screen = Screen.CONVERSATION, agent = agent, messages = emptyList()) }
        viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { Triple(api.messages(agent.agentId),api.capabilities(agent.agentId),api.session(agent.agentId)) } }.onSuccess { loaded ->
            update { it.copy(messages = loaded.first.mapIndexedNotNull(::historyItem),capabilities=loaded.second,sessionDetails=loaded.third) }
            socket = AgentSocket(api, agent.agentId, profiles.cursor(agent.agentId), ::event, ::snapshot, { reloadMessages(agent) }) { status -> update { it.copy(socketStatus = status) } }.also { it.connect() }
        }.onFailure(::fail) }
    }
    private fun snapshot(envelope: AgentEventEnvelope) { envelope.lastSequence?.let { sequence -> envelope.agentId?.let { profiles.setCursor(it,sequence) } }; update { it.copy(messages=envelope.messages.orEmpty().mapIndexedNotNull(::historyItem)) } }
    private fun reloadMessages(agent: AgentSummary) { val api = client ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.messages(agent.agentId) } }.onSuccess { raw -> update { it.copy(messages = raw.mapIndexedNotNull(::historyItem)) } } } }
    private fun historyItem(index: Int, element: JsonElement): ChatItem? { val obj = element.takeIf { it.isJsonObject }?.asJsonObject ?: return null; val role = obj.get("role")?.asString ?: "assistant"; val content = obj.get("content") ?: return null; val text = if (content.isJsonPrimitive) content.asString else content.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { part -> part.asJsonObject.takeIf { it.get("type")?.asString == "text" }?.get("text")?.asString }?.joinToString("\n").orEmpty(); return text.takeIf { it.isNotBlank() }?.let { ChatItem("history-$index", role, it) } }
    private fun event(envelope: AgentEventEnvelope) {
        envelope.sequence?.let { profiles.setCursor(envelope.agentId ?: return, it) }
        val event = envelope.event?.asJsonObject ?: return; val type = event.get("type")?.asString ?: return
        if (type == "extension_ui_request") {
            fun text(key: String): String? = event.get(key)?.let { value -> if (value.isJsonNull) null else value.asString }
            val request = ExtensionRequest(text("requestId").orEmpty(), text("kind").orEmpty(), text("title").orEmpty(), text("message").orEmpty(), text("placeholder"), text("prefill"), event.getAsJsonArray("options")?.map { option -> option.asString }.orEmpty())
            update { state -> state.copy(extensionRequest = request) }
            return
        }
        if(type=="extension_ui_status"){update { it.copy(extensionStatus=event.get("text")?.takeUnless(JsonElement::isJsonNull)?.asString) };return}
        if(type=="extension_ui_title"){update { it.copy(extensionTitle=event.get("title")?.asString) };return}
        if(type=="extension_ui_widget"){val key=event.get("key")?.asString?:return;val content=event.getAsJsonArray("content")?.map { it.asString };update { state->state.copy(extensionWidgets=if(content==null)state.extensionWidgets-key else state.extensionWidgets+(key to content)) };return}
        if(type=="extension_ui_working_message"){update { it.copy(extensionStatus=event.get("message")?.takeUnless(JsonElement::isJsonNull)?.asString) };return}
        update { state ->
            val items = state.messages.toMutableList()
            when (type) {
                "agent_start", "message_start" -> streamKey = UUID.randomUUID().toString()
                "message_update" -> { val detail = event.getAsJsonObject("assistantMessageEvent"); when (detail?.get("type")?.asString) {
                    "text_delta" -> appendDelta(items, "stream", detail.get("delta")?.asString.orEmpty(), ChatItem.Kind.TEXT)
                    "thinking_delta" -> appendDelta(items, "thinking", detail.get("delta")?.asString.orEmpty(), ChatItem.Kind.THINKING)
                } }
                "tool_execution_start" -> items += ChatItem(envelope.eventId ?: UUID.randomUUID().toString(), "tool", "${event.get("toolName")?.asString ?: "tool"}\n${event.get("args") ?: ""}", ChatItem.Kind.TOOL)
                "tool_execution_end" -> items += ChatItem(envelope.eventId ?: UUID.randomUUID().toString(), "system", "✓ ${event.get("toolName")?.asString ?: "tool"}${if (event.get("isError")?.asBoolean == true) " (failed)" else ""}", ChatItem.Kind.SYSTEM)
                "auto_retry_start" -> items += ChatItem(envelope.eventId ?: UUID.randomUUID().toString(), "system", "Retrying: ${event.get("errorMessage")?.asString.orEmpty()}", ChatItem.Kind.SYSTEM)
                "extension_ui_notify" -> items += ChatItem(envelope.eventId ?: UUID.randomUUID().toString(),"system",event.get("message")?.asString.orEmpty(),ChatItem.Kind.SYSTEM)
            }
            state.copy(messages = items, agent = state.agent?.copy(status = if (type == "agent_start") "streaming" else if (type == "agent_end") "idle" else state.agent.status))
        }
    }
    private fun appendDelta(items: MutableList<ChatItem>, prefix: String, delta: String, kind: ChatItem.Kind) { val key = "$prefix-$streamKey"; val i = items.indexOfLast { it.key == key }; if (i >= 0) items[i] = items[i].copy(text = items[i].text + delta) else items += ChatItem(key, "assistant", delta, kind) }
    fun send(message: String, command: String = "prompt") { val api = client ?: return; val agent = mutable.value.agent ?: return; update { it.copy(messages = it.messages + ChatItem(UUID.randomUUID().toString(), "user", message)) }; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.command(agent.agentId, command, message) } }.onFailure(::fail) } }
    fun setModel(model: ModelInfo) { val api=client?:return;val agent=mutable.value.agent?:return;viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.setModel(agent.agentId,model.provider,model.id)} }.onSuccess { value->update { it.copy(capabilities=value) } }.onFailure(::fail) } }
    fun setThinking(level:String) { val api=client?:return;val agent=mutable.value.agent?:return;viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.setThinking(agent.agentId,level)} }.onSuccess { value->update { it.copy(capabilities=value) } }.onFailure(::fail) } }
    fun compact(instructions:String="") { val api=client?:return;val agent=mutable.value.agent?:return;viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.compact(agent.agentId,instructions)} }.onSuccess { reloadMessages(agent) }.onFailure(::fail) } }
    fun navigate(entryId:String) { val api=client?:return;val agent=mutable.value.agent?:return;viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.navigate(agent.agentId,entryId)} }.onSuccess { reloadMessages(agent) }.onFailure(::fail) } }
    fun fork(entryId:String) { val api=client?:return;val agent=mutable.value.agent?:return;viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.fork(agent.agentId,entryId)} }.onSuccess { forked->update { it.copy(agents=it.agents+forked) };openAgent(forked) }.onFailure(::fail) } }
    fun respondExtension(value:Any?) { val request=mutable.value.extensionRequest?:return;val api=client?:return;val agent=mutable.value.agent?:return;update { it.copy(extensionRequest=null) };viewModelScope.launch { runCatching { withContext(Dispatchers.IO){api.extensionResponse(agent.agentId,request.requestId,value)} }.onFailure(::fail) } }
    fun abort() { val api = client ?: return; val agent = mutable.value.agent ?: return; viewModelScope.launch { runCatching { withContext(Dispatchers.IO) { api.command(agent.agentId, "abort") } }.onFailure(::fail) } }
    override fun onCleared() { socket?.close() }
}

class RemotePiViewModelFactory(private val profiles: ProfileStore, private val tokens: SecureTokenStore) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = RemotePiViewModel(profiles, tokens) as T
}
