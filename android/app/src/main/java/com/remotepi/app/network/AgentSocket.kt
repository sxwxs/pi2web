package com.remotepi.app.network

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.remotepi.app.data.AgentEventEnvelope
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class AgentSocket(
    private val client: RemotePiClient,
    private val agentId: String,
    initialSequence: Long,
    private val onEvent: (AgentEventEnvelope) -> Unit,
    private val onSnapshot: (AgentEventEnvelope) -> Unit,
    private val onGap: () -> Unit,
    private val onStatus: (String) -> Unit
) {
    private val gson = Gson()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var socket: WebSocket? = null
    private var retry: ScheduledFuture<*>? = null
    private var stopped = false
    private var attempt = 0
    private val cursor = EventCursor(initialSequence)
    val lastSequence: Long get() = cursor.value

    fun connect() {
        if (stopped) return
        onStatus(if (attempt == 0) "connecting" else "reconnecting")
        val request = try { client.wsRequest() } catch (_: IllegalArgumentException) { reconnect(); return }
        socket = client.http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0; onStatus("connected")
                val command = JsonObject().apply { addProperty("type", "subscribe"); addProperty("agentId", agentId); addProperty("lastSequence", lastSequence) }
                webSocket.send(gson.toJson(command))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { gson.fromJson(text, AgentEventEnvelope::class.java) }.getOrNull() ?: return
                if (message.agentId != agentId) return
                if (message.type == "agent_snapshot") { message.lastSequence?.let(cursor::reset); onSnapshot(message); return }
                if (message.type != "agent_event") return
                val sequence = message.sequence ?: return
                when (cursor.accept(sequence)) {
                    SequenceDecision.DUPLICATE -> return
                    SequenceDecision.GAP -> onGap()
                    SequenceDecision.ACCEPT -> Unit
                }
                onEvent(message)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { reconnect() }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { reconnect() }
        })
    }
    @Synchronized private fun reconnect() {
        if (stopped || retry?.isDone == false) return
        onStatus("disconnected")
        val delay = ReconnectPolicy.delaySeconds(attempt)
        attempt++
        retry = scheduler.schedule(::connect, delay, TimeUnit.SECONDS)
    }
    fun close() { stopped = true; retry?.cancel(true); socket?.close(1000, "screen closed"); scheduler.shutdownNow() }
}
