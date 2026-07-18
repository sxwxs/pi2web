package com.remotepi.app

import com.remotepi.app.network.EventCursor
import com.remotepi.app.network.ReconnectPolicy
import com.remotepi.app.network.SequenceDecision
import org.junit.Assert.assertEquals
import org.junit.Test

class EventCursorTest {
    @Test fun `deduplicates and detects gaps`() {
        val cursor = EventCursor()
        assertEquals(SequenceDecision.ACCEPT, cursor.accept(1))
        assertEquals(SequenceDecision.DUPLICATE, cursor.accept(1))
        assertEquals(SequenceDecision.GAP, cursor.accept(3))
        assertEquals(SequenceDecision.ACCEPT, cursor.accept(4))
        assertEquals(4, cursor.value)
    }

    @Test fun `reconnect delay is bounded exponential`() {
        assertEquals(listOf(1L, 2L, 4L, 8L, 15L, 30L, 30L), (0..6).map(ReconnectPolicy::delaySeconds))
    }
}
