package com.haelan.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.haelan.android.glance.GlanceClient
import com.haelan.android.glance.GlanceRepository
import com.haelan.android.glance.GlanceStore
import com.haelan.android.glance.ui.GlanceScreen
import com.haelan.android.glance.ui.GlanceTheme
import com.haelan.android.glance.ui.rememberCardText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.ZoneId

/**
 * The screen after sign-in: the web dashboard, drawn natively. The sync screen, which used to be
 * the whole app, is one tap away in the top bar and is where the phone's own settings still live.
 */
class GlanceActivity : ComponentActivity() {

    /** Who the glance is for; refreshed from the store whenever the app acts on it. */
    private lateinit var session: SessionStore.Session

    /** The glance's state machine, for as long as this screen exists; null before a session is known. */
    private var repository: GlanceRepository? = null

    companion object {
        /**
         * The repository of the glance screen that is up, if one is; main thread only. Held so
         * that [closeForSignOut] can reach it from the sync screen, which sits on top of it.
         * A repository holds no Context (the store keeps the application's), so this leaks nothing.
         */
        private var open: GlanceRepository? = null

        /**
         * **Sign-out closes the glance before the store is deleted.** Called by the sync screen's
         * sign-out on the main thread, before it deletes the stored glance off the main thread: a
         * today read still blocked in the client can answer 200 after the delete, and only a closed
         * repository is sure not to write that answer back (GlanceRepository's KDoc). The glance
         * screen is underneath the sync screen and is not destroyed until the sign-out clears the
         * task, which is after the delete has been started, so its own onDestroy is too late to be
         * the guarantee. Closing twice is harmless: onDestroy closes again.
         */
        fun closeForSignOut() {
            open?.close()
            open = null
        }
    }

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

        val repo = GlanceRepository(
            reads = GlanceClient(session.server, session.personId, session.cookie),
            store = GlanceStore.encrypted(this),
            server = session.server,
            personId = session.personId,
            clock = System::currentTimeMillis,
            dispatcher = Dispatchers.IO,
        )
        repository = repo
        open = repo
        // The 401 waits in the repository's channel until the screen is started, so an expiry met
        // while the sync screen is on top is acted on when the glance comes back, not from behind.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { repo.signedOut.collect { sessionExpired() } }
        }
        repo.open()

        // Scaffold pads for the system bars itself, so the glance asks for the whole window
        // instead of borrowing padForSystemBars from the view screens.
        enableEdgeToEdge()
        setContent {
            GlanceTheme {
                val state by repo.state.collectAsStateWithLifecycle()
                GlanceScreen(
                    state = state,
                    // The payload names no timezone and the session does not keep the person's, so
                    // the phone's zone reads the clock times; the payload's dates need none.
                    text = rememberCardText(ZoneId.systemDefault()),
                    nowMs = System.currentTimeMillis(),
                    onOpenSync = ::openSync,
                    // Task 8 opens a day here and Task 9 a page of the web; until then a tap is a no-op.
                    onOpenDay = {},
                    onOpenPage = {},
                )
            }
        }
    }

    override fun onDestroy() {
        repository?.let { repo ->
            repo.close()
            if (open === repo) open = null
        }
        super.onDestroy()
    }

    /**
     * The instance refused the session. The cookie is forgotten and the person signs in again; the
     * stored glance stays, keyed by server and person, so the same person gets it back and nobody
     * else ever reads it (only an explicit sign-out deletes it).
     */
    private fun sessionExpired() {
        SessionStore.clearSession(SessionStore.prefs(this))
        startActivity(Intent(this, LoginActivity::class.java).apply {
            putExtra(LoginActivity.EXTRA_EXPIRED, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        })
        finish()
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
