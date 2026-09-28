package com.haelan.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.haelan.android.glance.GlanceViewModel
import com.haelan.android.glance.ui.GlanceScreen
import com.haelan.android.glance.ui.GlanceTheme
import com.haelan.android.glance.ui.rememberCardText
import kotlinx.coroutines.launch

/**
 * The screen after sign-in: the web dashboard, drawn natively. The sync screen, which used to be
 * the whole app, is one tap away in the top bar and is where the phone's own settings still live.
 *
 * The glance's state lives in [GlanceViewModel], which outlives a rotation: the day on screen, the
 * open calendar and the reads in flight all carry over, and the repository is closed when the
 * screen is gone for good (the model's onCleared), not each time the Activity is rebuilt.
 */
class GlanceActivity : ComponentActivity() {

    /** Who the glance is for; refreshed from the store whenever the app acts on it. */
    private lateinit var session: SessionStore.Session

    private lateinit var model: GlanceViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The same order MainActivity reads it in: what sign-in handed over, then what was saved,
        // and with neither there is nobody to show a glance for.
        session = sessionOf(intent) ?: SessionStore.loadSession(SessionStore.prefs(this)) ?: run {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        // The factory runs only the first time: a rotation hands back the model already built.
        model = ViewModelProvider(this, GlanceViewModel.factory(application, session))[GlanceViewModel::class.java]

        // The 401 waits in a conflated channel until the screen is started, so an expiry met while
        // the sync screen is on top is acted on when the glance comes back, not from behind.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { model.signedOut.collect { sessionExpired() } }
        }
        // Back from the sync screen, from another app, or from the phone asleep: ask again.
        lifecycle.addObserver(LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) model.resumed() })

        // Scaffold pads for the system bars itself, so the glance asks for the whole window
        // instead of borrowing padForSystemBars from the view screens.
        enableEdgeToEdge()
        setContent {
            GlanceTheme {
                val state by model.state.collectAsStateWithLifecycle()
                val zone by model.zone.collectAsStateWithLifecycle()
                val calendar by model.calendar.collectAsStateWithLifecycle()
                val logSheet by model.logSheet.collectAsStateWithLifecycle()
                // Read so a midnight tick recomposes, and the + goes with the day it logs to.
                val tick by model.now.collectAsStateWithLifecycle()
                GlanceScreen(
                    state = state,
                    text = rememberCardText(zone),
                    nowMs = maxOf(tick, System.currentTimeMillis()),
                    onOpenSync = ::openSync,
                    onOpenDay = model::open,
                    onOpenPage = ::openPage,
                    calendar = calendar,
                    onToday = model::showToday,
                    onRefresh = model::refresh,
                    onOpenCalendar = model::openCalendar,
                    onShowMonth = model::showMonth,
                    onCloseCalendar = model::closeCalendar,
                    logSheet = logSheet,
                    logActions = model.logActions,
                    onOpenLog = model::openLog,
                )
            }
        }
    }

    /**
     * Sign-in reuses the glance already in the task (FLAG_ACTIVITY_CLEAR_TOP with SINGLE_TOP) rather
     * than stacking a second. Every path that changes who is signed in clears the task first, so
     * the session here is normally the one already shown.
     *
     * A different person or server gets a fresh screen: this one finishes, taking its model and
     * repository with it, and a new one starts from the incoming intent. Not recreate(), which may
     * rebuild from the intent this screen was first launched with and draw the old person again.
     * The same person with a new cookie keeps the screen and moves the reads to the new session,
     * so no read goes on sending a cookie the instance has already let go.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val incoming = sessionOf(intent) ?: return
        if (incoming.personId != session.personId || incoming.server != session.server) {
            finish()
            startActivity(Intent(this, GlanceActivity::class.java).putExtras(intent))
            return
        }
        setIntent(intent)
        session = incoming
        model.useCookie(incoming.cookie)
    }

    /** The session sign-in handed over in [intent], or null when it did not carry a whole one. */
    private fun sessionOf(intent: Intent): SessionStore.Session? = SessionStore.Session(
        intent.getStringExtra(LoginActivity.EXTRA_SERVER) ?: "",
        intent.getStringExtra(LoginActivity.EXTRA_PERSON_ID) ?: "",
        intent.getStringExtra(LoginActivity.EXTRA_COOKIE) ?: "",
        intent.getStringExtra(LoginActivity.EXTRA_USERNAME) ?: "",
    ).takeIf {
        it.server.isNotEmpty() && it.personId.isNotEmpty() && it.cookie.isNotEmpty() && it.username.isNotEmpty()
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
     * The session is read again here rather than taken from the launch ([currentSession]).
     */
    private fun openSync() {
        val current = currentSession() ?: return
        startActivity(Intent(this, MainActivity::class.java).withSession(current))
    }

    /**
     * The web page behind a card or a workout row, on top of the glance so back returns to it. The
     * session is read again for the same reason as the sync screen's: a cookie the instance has
     * already let go would only open the web app's sign-in. [title] is the tapped card's heading,
     * for the page's top bar.
     */
    private fun openPage(path: String, title: String) {
        val current = currentSession() ?: return
        startActivity(
            Intent(this, WebPageActivity::class.java).withSession(current)
                .putExtra(WebPageActivity.EXTRA_PATH, path)
                .putExtra(WebPageActivity.EXTRA_TITLE, title),
        )
    }

    /**
     * The session as the store has it now, for a screen started on top of the glance, or null after
     * sending the person to sign in again.
     *
     * Read again rather than taken from the launch: a sync that met a 401 while the glance was up
     * has already forgotten the cookie, and handing the old one on would only have it meet the same
     * 401. An empty store means exactly that, since sign-in saves the session before the glance ever
     * starts, so it is the expired notice.
     */
    private fun currentSession(): SessionStore.Session? {
        val current = SessionStore.loadSession(SessionStore.prefs(this))
        if (current == null) {
            startActivity(Intent(this, LoginActivity::class.java).apply {
                putExtra(LoginActivity.EXTRA_EXPIRED, true)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            })
            finish()
            return null
        }
        // The store is the newer word on the cookie; the glance's reads follow it too.
        if (current.personId == session.personId && current.server == session.server) model.useCookie(current.cookie)
        session = current
        return current
    }

    /** The session in the extras sign-in uses, which every screen after it reads. */
    private fun Intent.withSession(current: SessionStore.Session): Intent = apply {
        putExtra(LoginActivity.EXTRA_SERVER, current.server)
        putExtra(LoginActivity.EXTRA_PERSON_ID, current.personId)
        putExtra(LoginActivity.EXTRA_COOKIE, current.cookie)
        putExtra(LoginActivity.EXTRA_USERNAME, current.username)
    }
}
