package com.remotepi.app

import android.app.Application
import com.remotepi.app.data.ProfileStore
import com.remotepi.app.security.SecureTokenStore

class RemotePiApplication : Application() {
    val profiles by lazy { ProfileStore(this) }
    val tokens by lazy { SecureTokenStore(this) }
}
