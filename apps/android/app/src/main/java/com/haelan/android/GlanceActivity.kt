package com.haelan.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import com.haelan.android.glance.ui.GlanceTheme

/**
 * The screen after sign-in: the web dashboard, drawn natively. The sync screen, which used to be
 * the whole app, is one tap away in the top bar and is where the phone's own settings still live.
 */
class GlanceActivity : ComponentActivity() {

    private lateinit var session: SessionStore.Session

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The same order MainActivity reads it in: what sign-in handed over, then what was saved,
        // and with neither there is nobody to show a glance for.
        session = SessionStore.Session(
            intent.getStringExtra(LoginActivity.EXTRA_SERVER) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_PERSON_ID) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_COOKIE) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_USERNAME) ?: "",
        ).takeIf {
            it.server.isNotEmpty() && it.personId.isNotEmpty()
                && it.cookie.isNotEmpty() && it.username.isNotEmpty()
        } ?: SessionStore.loadSession(SessionStore.prefs(this)) ?: run {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        // Scaffold pads for the system bars itself, so the glance asks for the whole window
        // instead of borrowing padForSystemBars from the view screens.
        enableEdgeToEdge()
        setContent {
            GlanceTheme {
                GlanceScreen(onOpenSync = ::openSync)
            }
        }
    }

    /** Started on top rather than instead: back from the sync screen returns to the glance. */
    private fun openSync() {
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra(LoginActivity.EXTRA_SERVER, session.server)
            putExtra(LoginActivity.EXTRA_PERSON_ID, session.personId)
            putExtra(LoginActivity.EXTRA_COOKIE, session.cookie)
            putExtra(LoginActivity.EXTRA_USERNAME, session.username)
        })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GlanceScreen(onOpenSync: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                // A placeholder until the day navigation takes this slot.
                title = { Text(stringResource(R.string.app_name)) },
                actions = {
                    IconButton(onClick = onOpenSync) {
                        Icon(
                            painter = painterResource(R.drawable.ic_sync),
                            contentDescription = stringResource(R.string.glance_sync_open),
                        )
                    }
                },
            )
        },
    ) { padding ->
        // Empty until the cards arrive; they go inside the Scaffold's padding, below the bar.
        Box(Modifier.fillMaxSize().padding(padding))
    }
}
