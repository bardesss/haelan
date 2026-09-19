package com.haelan.android

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * The button's sync: the cursors, the engine, and the scope the run lives in.
 *
 * That scope is this process's rather than the screen's. Rotating the phone destroys the activity
 * that tapped the button, and the system destroys it too when it reclaims memory while somebody
 * checks another app. A run cancelled there is not a pause: what landed has already moved the
 * instance's cursor for that type, and the rest of its window sits behind that cursor, where the
 * next run only reads back to the overlap. So the activity attaches to this ([SyncRunState] holds
 * what a screen paints) instead of owning it, and a screen going away stops nothing.
 *
 * One run at a time, which is the state's own rule: a second tap during a run is not a second
 * upload of the same window.
 */
object SyncRun {

    private const val TAG = SyncEngine.TAG

    // Main, because the engine reports on its caller's thread and every callback below ends up on
    // a view. The blocking halves switch dispatchers themselves, as they did when the screen owned
    // this coroutine.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val state = SyncRunState()

    fun attach(screen: SyncRunState.Screen) = state.attach(screen)

    fun detach(screen: SyncRunState.Screen) = state.detach(screen)

    /**
     * Starts the run for [sending], the types whose toggles are on, unless one is already going.
     *
     * [context] is read for the prefs a finished type writes and for the package name the request
     * carries. Only its application context is used, so the run holds no activity and outlives one.
     */
    fun start(
        context: Context,
        client: HealthConnectClient,
        session: SyncEngine.Session,
        sending: Set<String>,
    ) {
        val appContext = context.applicationContext
        if (!state.begin(sending)) return
        scope.launch {
            try {
                run(appContext, client, session)
            } catch (e: CancellationException) {
                // Not a failure, and not a row's: a cancelled coroutine keeps cancelling, and the
                // finally below closes the run exactly as it does for an answer that arrived.
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "sync stopped: ${e.message ?: e.javaClass.simpleName}")
                state.failed(e)
            } finally {
                state.finish()
            }
        }
    }

    /**
     * One run: what the instance already holds, then every type whose toggle is on. The reporter
     * draws nothing itself - it moves [state] and writes what a type did where the rows read it,
     * so a run with no screen attached leaves the same trail a watched one does.
     */
    private suspend fun run(context: Context, client: HealthConnectClient, session: SyncEngine.Session) {
        val prefs = SessionStore.prefs(context)
        val runEnd = Instant.now()
        val runEndMs = runEnd.toEpochMilli()
        val report = object : SyncEngine.Reporter {
            override fun typeStarted(key: String) = state.mark(key, SyncRunState.Mark.RUNNING)

            override fun typeOk(key: String) {
                state.mark(key, SyncRunState.Mark.SENT)
                record(prefs, key, runEndMs, empty = false)
            }

            override fun typeEmpty(key: String) {
                // A finished read with nothing behind it: no tick, because nothing was sent, and
                // its own sentence, because never ran and nothing there are two answers.
                state.mark(key, SyncRunState.Mark.EMPTY)
                record(prefs, key, runEndMs, empty = true)
            }

            override fun typeFailed(key: String, error: Throwable) {
                Log.w(TAG, "${SyncTypes.forKey(key).dataTypeId} not sent: ${reasonFor(context, error)}")
                state.mark(key, SyncRunState.Mark.FAILED)
            }

            // The one answer that concerns every type: the cookie is dead and every later type
            // would answer 401. The engine already stopped the rest, so this stops the run.
            override fun sessionExpired() = expire(context)
        }
        // What the instance already holds, so each type reads its delta. A fetch that fails is not
        // a sync failure: every type then keeps the full window instead of skipping.
        val cursors = withContext(Dispatchers.IO) {
            InstanceClient.get(session.server, SyncCursors.pathFor(session.personId), session.cookie) {
                SyncCursors.parseCursorEnds(it.body)
            }
        }
        if (cursors is InstanceClient.Outcome.Failed) {
            val error = cursors.error
            if (error is InstanceClient.InstanceHttpException && error.status == 401) {
                expire(context)
                return
            }
            Log.w(TAG, "cursors not read, full window instead: ${reasonFor(context, error)}")
        }
        SyncEngine.syncAll(
            client = client,
            session = session,
            packageName = context.packageName,
            prefs = prefs,
            end = runEnd,
            post = { path, payload ->
                // The whole exchange stays off the main thread: even reading the status line
                // counts as network I/O down here and throws on the UI thread.
                withContext(Dispatchers.IO) {
                    InstanceClient.post(session.server, path, payload, session.cookie) { }
                }
            },
            report = report,
            cursorEnds = (cursors as? InstanceClient.Outcome.Ok)?.value ?: emptyMap(),
        )
    }

    /**
     * The session is over: the instance forgot the cookie (a reset wipes sessions) or it was
     * replaced elsewhere. Forgotten here rather than by the screen, because a stored dead cookie
     * replays itself through auto-login, which reads as the sync button bouncing between the two
     * screens - and because the screen that started this run may be gone by now.
     */
    private fun expire(context: Context) {
        SessionStore.clearSession(SessionStore.prefs(context))
        state.expired()
    }

    /**
     * What one type's run left behind, under the same two keys the background worker writes, so
     * that a row cannot tell which of the two moved it.
     */
    private fun record(prefs: SharedPreferences, key: String, atMs: Long, empty: Boolean) {
        prefs.edit()
            .putLong(SyncStatus.lastKey(key), atMs)
            .putBoolean(SyncStatus.emptyKey(key), empty)
            .apply()
    }

    /**
     * The sentence for a failure, in the language the phone is set to. What the instance actually
     * answered goes to logcat, where a developer looks and a person does not.
     *
     * The status is passed as the sentence's own argument when the answer carried one, because the
     * generic sentence is written with a placeholder and printing it unformatted says "%1$d" to
     * whoever reads the toast.
     */
    internal fun reasonFor(context: Context, error: Throwable): String {
        Log.w(TAG, error.message ?: error.javaClass.simpleName)
        val sentence = InstanceError.forThrowable(error)
        return if (error is InstanceClient.InstanceHttpException) {
            context.getString(sentence, error.status)
        } else {
            context.getString(sentence)
        }
    }
}
