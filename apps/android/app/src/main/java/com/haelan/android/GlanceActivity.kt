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

    /** Who the glance is for; refreshed from the store whenever the app acts on it. */
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

    /**
     * Started on top rather than instead: back from the sync screen returns to the glance.
     *
     * The session is read again here rather than taken from the launch: a sync that met a 401
     * while the glance was up has already forgotten the cookie, and handing the old one to the
     * sync screen would only have it meet the same 401. An empty store means exactly that, since
     * sign-in saves the session before the glance ever starts, so it is the expired notice.
     */
    private fun openSync() {
        val current = SessionStore.loadSession(SessionStore.prefs(this))
        if (current == null) {
            startActivity(Intent(this, LoginActivity::class.java).apply {
                putExtra(LoginActivity.EXTRA_EXPIRED, true)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            })
            finish()
            return
        }
        session = current
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra(LoginActivity.EXTRA_SERVER, current.server)
            putExtra(LoginActivity.EXTRA_PERSON_ID, current.personId)
            putExtra(LoginActivity.EXTRA_COOKIE, current.cookie)
            putExtra(LoginActivity.EXTRA_USERNAME, current.username)
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
