package com.remotepi.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import android.Manifest
import android.os.Build
import androidx.lifecycle.viewmodel.compose.viewModel
import com.remotepi.app.ui.RemotePiApp
import com.remotepi.app.ui.RemotePiViewModel
import com.remotepi.app.ui.RemotePiViewModelFactory

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as RemotePiApplication
        if (Build.VERSION.SDK_INT >= 33) registerForActivityResult(ActivityResultContracts.RequestPermission()) {}.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent { RemotePiApp(viewModel(factory = RemotePiViewModelFactory(app.profiles, app.tokens, app.notifier))) }
    }
}
