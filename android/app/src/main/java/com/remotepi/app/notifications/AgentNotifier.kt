package com.remotepi.app.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.remotepi.app.MainActivity
import com.remotepi.app.R
import java.time.Instant
import com.remotepi.app.data.NotificationTimes

class AgentNotifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val channelId = "agent_completion"
    init { manager.createNotificationChannel(NotificationChannel(channelId, "Agent 完成", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Remote Pi session 工作完成通知" }) }

    fun completed(agentId: String, sessionName: String?, unixTimestamp: Long) {
        val instant = Instant.ofEpochSecond(unixTimestamp)
        val localTime = NotificationTimes.formatLocal(unixTimestamp)
        val intent = PendingIntent.getActivity(context, agentId.hashCode(), Intent(context, MainActivity::class.java).apply { putExtra("agentId", agentId); flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("${sessionName?.takeIf { it.isNotBlank() } ?: agentId} 已完成")
            .setContentText("$localTime · Unix $unixTimestamp")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Session 已转为空闲状态\n本地时间：$localTime\nUnix 时间戳：$unixTimestamp"))
            .setWhen(instant.toEpochMilli()).setShowWhen(true).setContentIntent(intent).setAutoCancel(true).build()
        manager.notify(agentId.hashCode(), notification)
    }
}
