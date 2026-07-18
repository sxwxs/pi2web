package com.remotepi.app

import com.remotepi.app.data.NotificationTimes
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

class NotificationTimesTest {
    @Test fun `converts unix timestamp to requested local timezone`() {
        assertEquals("2024-01-01 08:00:00 GMT+08:00", NotificationTimes.formatLocal(1704067200, ZoneId.of("GMT+08:00")))
    }
}
