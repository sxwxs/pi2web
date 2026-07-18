package com.remotepi.app

import com.remotepi.app.data.MentionPaths
import org.junit.Assert.assertEquals
import org.junit.Test

class MentionPathsTest {
    @Test fun `starts at agent cwd and creates relative references`() {
        assertEquals("packages/app", MentionPaths.initialPath("/repo", "/repo/packages/app"))
        assertEquals("@src/Main.kt", MentionPaths.reference("/repo", "/repo/packages/app", "packages/app/src/Main.kt"))
    }
    @Test fun `uses absolute quoted path outside cwd and supports parent`() {
        assertEquals("@\"/repo/shared dir/file.txt\"", MentionPaths.reference("/repo", "/repo/packages/app", "shared dir/file.txt"))
        assertEquals("packages", MentionPaths.parent("packages/app"))
        assertEquals(".", MentionPaths.parent("packages"))
    }
}
