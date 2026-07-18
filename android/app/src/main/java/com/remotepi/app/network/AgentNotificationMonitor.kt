package com.remotepi.app.network

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.remotepi.app.data.AgentEventEnvelope
import com.remotepi.app.data.AgentSummary
import com.remotepi.app.data.ProfileStore
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Maintains one multiplexed socket so completion events from every server Agent can notify Android. */
class AgentNotificationMonitor(
    private val serverId: String,
    private val client: RemotePiClient,
    private val profiles: ProfileStore,
    agents: List<AgentSummary>,
    private val onCompleted: (agentId: String, sessionName: String?, unixTimestamp: Long) -> Unit
) {
    private val gson = Gson(); private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var socket: WebSocket? = null; private var retry: ScheduledFuture<*>? = null; private var attempt = 0; private var stopped = false
    private var agents = agents.associateBy { it.agentId }
    fun connect() { if (stopped || agents.isEmpty()) return; socket = client.http.newWebSocket(client.wsRequest(), Listener()) }
    fun update(value: List<AgentSummary>) { agents = value.associateBy { it.agentId }; val ws=socket; if(ws==null){connect();return};value.forEach { subscribe(ws,it.agentId) } }
    private fun subscribe(ws: WebSocket, agentId: String) { val cursor=profiles.notificationCursor(serverId,agentId);val body=JsonObject().apply { addProperty("type","subscribe");addProperty("agentId",agentId);if(cursor<0)addProperty("fromNow",true)else addProperty("lastSequence",cursor) };ws.send(gson.toJson(body)) }
    private inner class Listener:WebSocketListener(){
        override fun onOpen(webSocket:WebSocket,response:Response){attempt=0;agents.keys.forEach { subscribe(webSocket,it) }}
        override fun onMessage(webSocket:WebSocket,text:String){val message=runCatching { gson.fromJson(text,AgentEventEnvelope::class.java) }.getOrNull()?:return;val id=message.agentId?:return
            if(message.type=="subscribed"){message.currentSequence?.let { profiles.setNotificationCursor(serverId,id,it) };return}
            if(message.type!="agent_event")return;message.sequence?.let { profiles.setNotificationCursor(serverId,id,it) }
            if(message.event?.asJsonObject?.get("type")?.asString=="agent_end")onCompleted(id,agents[id]?.sessionId,message.timestamp?:Instant.now().epochSecond)
        }
        override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?){reconnect()};override fun onClosed(webSocket:WebSocket,code:Int,reason:String){reconnect()}
    }
    @Synchronized private fun reconnect(){if(stopped||retry?.isDone==false)return;val delay=ReconnectPolicy.delaySeconds(attempt++);retry=scheduler.schedule(::connect,delay,TimeUnit.SECONDS)}
    fun close(){stopped=true;retry?.cancel(true);socket?.close(1000,"monitor closed");scheduler.shutdownNow()}
}
