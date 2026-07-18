package com.remotepi.app.data

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object NotificationTimes {
    fun formatLocal(unixTimestamp: Long, zoneId: ZoneId = ZoneId.systemDefault()): String =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z").withZone(zoneId).format(Instant.ofEpochSecond(unixTimestamp))
}
