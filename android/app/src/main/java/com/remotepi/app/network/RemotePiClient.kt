package com.remotepi.app.network

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.remotepi.app.data.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class RemotePiClient(private val baseUrl: String, private val token: String, val http: OkHttpClient = defaultClient) {
    private val gson = Gson()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val root = baseUrl.trimEnd('/').toHttpUrlOrNull() ?: throw RemotePiException("INVALID_URL", "Invalid server URL")
        return root.newBuilder().apply {
            path.trimStart('/').split('/').filter { it.isNotEmpty() }.forEach(::addPathSegment)
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
    }
    private inline fun <reified T> call(method: String, path: String, body: Any? = null, query: Map<String, String> = emptyMap()): T {
        val request = Request.Builder().url(url(path, query)).header("Authorization", "Bearer $token")
            .header("X-Remote-Pi-Protocol", "1").method(method, body?.let { gson.toJson(it).toRequestBody(jsonType) }).build()
        http.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val error = runCatching { gson.fromJson(raw, ErrorEnvelope::class.java).error }.getOrNull()
                throw RemotePiException(error?.code ?: "HTTP_${response.code}", error?.message ?: response.message, error?.requestId, response.code)
            }
            val type = TypeToken.getParameterized(DataEnvelope::class.java, object : TypeToken<T>() {}.type).type
            return (gson.fromJson<DataEnvelope<T>>(raw, type)).data
        }
    }
    fun status(): SystemStatus = call("GET", "/api/v1/system/status")
    fun login(): Boolean = call<JsonObject>("POST", "/api/v1/auth/login", mapOf("token" to token)).get("authenticated").asBoolean
    fun workspaces(): List<Workspace> = call("GET", "/api/v1/workspaces")
    fun addWorkspace(label: String, rootPath: String): Workspace = call("POST", "/api/v1/workspaces", mapOf("label" to label, "rootPath" to rootPath))
    fun tree(id: String, path: String): List<TreeEntry> = call("GET", "/api/v1/workspaces/$id/tree", query = mapOf("path" to path))
    fun file(id: String, path: String, offset: Long = 0, limit: Int = 256 * 1024): FileContent = call("GET", "/api/v1/workspaces/$id/file", query = mapOf("path" to path, "offset" to "$offset", "limit" to "$limit"))
    fun agents(): List<AgentSummary> = call("GET", "/api/v1/agents")
    fun sessions(workspaceId: String, path: String): List<SessionInfo> = call("GET", "/api/v1/sessions", query = mapOf("workspaceId" to workspaceId, "path" to path))
    fun createAgent(workspaceId: String, relativeCwd: String, sessionFile: String? = null): AgentSummary = call("POST", "/api/v1/agents", mapOf("workspaceId" to workspaceId, "relativeCwd" to relativeCwd, "sessionFile" to sessionFile))
    fun messages(id: String): List<JsonElement> = call("GET", "/api/v1/agents/$id/messages")
    fun capabilities(id: String): AgentCapabilities = call("GET", "/api/v1/agents/$id/capabilities")
    fun session(id: String): SessionDetails = call("GET", "/api/v1/agents/$id/session")
    fun setModel(id: String, provider: String, modelId: String): AgentCapabilities = call("POST", "/api/v1/agents/$id/model", mapOf("provider" to provider, "modelId" to modelId))
    fun setThinking(id: String, level: String): AgentCapabilities = call("POST", "/api/v1/agents/$id/thinking", mapOf("level" to level))
    fun compact(id: String, instructions: String = ""): JsonElement = call("POST", "/api/v1/agents/$id/compact", mapOf("instructions" to instructions))
    fun navigate(id: String, entryId: String): JsonElement = call("POST", "/api/v1/agents/$id/navigate", mapOf("entryId" to entryId))
    fun fork(id: String, entryId: String): AgentSummary = call("POST", "/api/v1/agents/$id/fork", mapOf("entryId" to entryId))
    fun extensionResponse(id: String, requestId: String, value: Any?): Boolean = call<JsonObject>("POST", "/api/v1/agents/$id/extension-response", mapOf("requestId" to requestId, "value" to value)).get("success").asBoolean
    fun command(id: String, command: String, message: String = ""): Boolean = call<JsonObject>("POST", "/api/v1/agents/$id/$command", mapOf("message" to message)).get("success").asBoolean
    fun stop(id: String): Boolean = call<JsonObject>("DELETE", "/api/v1/agents/$id").get("stopped").asBoolean
    /** OkHttp's WebSocket API expects an HTTP(S) URL and performs the WS(S) upgrade itself. */
    fun wsUrl(): HttpUrl = url("/api/v1/ws")
    fun wsRequest(): Request = Request.Builder().url(wsUrl()).header("Authorization", "Bearer $token").header("X-Remote-Pi-Protocol", "1").build()

    companion object {
        val defaultClient: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()
    }
}
