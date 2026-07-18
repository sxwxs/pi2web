package com.remotepi.app.data

import com.google.gson.JsonElement

data class ServerProfile(val id: String, val name: String, val baseUrl: String, val lastConnectedAt: String? = null)
data class SystemStatus(val version: String, val protocolVersion: Int, val piVersion: String? = null)
data class Workspace(val id: String, val label: String, val rootPath: String, val createdAt: String = "")
data class TreeEntry(val name: String, val type: String, val size: Long = 0, val modifiedAt: String = "")
data class FileContent(val path: String, val size: Long, val modifiedAt: String, val binary: Boolean, val content: String? = null, val offset: Long = 0, val limit: Long = 0)
data class AgentSummary(
    val agentId: String, val workspaceId: String, val cwd: String, val sessionId: String,
    val status: String, val createdAt: String = "", val lastActiveAt: String = ""
)
data class ApiErrorBody(val code: String = "UNKNOWN", val message: String = "Request failed", val requestId: String? = null)
data class ErrorEnvelope(val error: ApiErrorBody?)
data class DataEnvelope<T>(val data: T)

data class ChatItem(val key: String, val role: String, val text: String, val kind: Kind = Kind.TEXT) {
    enum class Kind { TEXT, THINKING, TOOL, SYSTEM }
}

data class ModelInfo(val provider: String, val id: String, val name: String? = null, val reasoning: Boolean = false)
data class AgentCapabilities(val model: ModelInfo?, val models: List<ModelInfo> = emptyList(), val thinkingLevel: String = "off", val thinkingLevels: List<String> = emptyList(), val supportsThinking: Boolean = false)
data class SessionInfo(val path: String, val id: String, val cwd: String, val name: String? = null, val created: String, val modified: String, val messageCount: Int, val firstMessage: String = "")
data class SessionDetails(val sessionId: String, val sessionFile: String?, val sessionName: String?, val leafId: String?, val entries: List<JsonElement> = emptyList(), val tree: List<JsonElement> = emptyList(), val stats: JsonElement? = null)
data class ExtensionRequest(val requestId: String, val kind: String, val title: String = "", val message: String = "", val placeholder: String? = null, val prefill: String? = null, val options: List<String> = emptyList())

data class AgentEventEnvelope(
    val type: String, val agentId: String?, val eventId: String?, val sequence: Long?, val event: JsonElement?,
    val requestId: String? = null, val success: Boolean? = null, val lastSequence: Long? = null,
    val state: JsonElement? = null, val messages: List<JsonElement>? = null
)

class RemotePiException(val code: String, message: String, val requestId: String? = null, val status: Int? = null) : Exception(message)
