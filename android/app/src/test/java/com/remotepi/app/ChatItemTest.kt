package com.remotepi.app

import com.remotepi.app.data.ChatItem
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatItemTest {
    @Test fun `collapsed cards show useful short titles`() {
        assertEquals("read", ChatItem("1", "tool", "read\n{path:x}", ChatItem.Kind.TOOL).collapsedTitle())
        assertEquals("Thinking", ChatItem("2", "assistant", "long reasoning", ChatItem.Kind.THINKING).collapsedTitle())
        assertEquals("first second", ChatItem("3", "assistant", "first\nsecond").collapsedTitle())
    }
}
