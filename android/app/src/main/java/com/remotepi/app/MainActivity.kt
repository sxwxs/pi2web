package com.remotepi.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.remotepi.app.ui.RemotePiApp
import com.remotepi.app.ui.RemotePiViewModel
import com.remotepi.app.ui.RemotePiViewModelFactory

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as RemotePiApplication
        setContent { RemotePiApp(viewModel(factory = RemotePiViewModelFactory(app.profiles, app.tokens))) }
    }
}
