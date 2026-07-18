package com.remotepi.app

import android.app.Application
import com.remotepi.app.data.ProfileStore
import com.remotepi.app.security.SecureTokenStore
import com.remotepi.app.notifications.AgentNotifier

class RemotePiApplication : Application() {
    val profiles by lazy { ProfileStore(this) }
    val tokens by lazy { SecureTokenStore(this) }
    val notifier by lazy { AgentNotifier(this) }
}
