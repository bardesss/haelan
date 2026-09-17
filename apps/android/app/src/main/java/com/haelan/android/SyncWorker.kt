package com.haelan.android

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Instant

/**
 * The sync without a screen (T5.1). Same engine the button runs, with a reporter that logs
 * instead of drawing rows: a worker cannot touch a view, and a sync that needs one open is
 * the manual sync this task stops depending on.
 *
 * Silent by design: no notification, no toast. A background attempt that fails is retried with
 * the schedule's backoff when the failure is transient (no network, instance asleep), and
 * filed as done when it is not (a refusal would answer the same on retry). Which types went
 * and which did not is visible in the app (T5.2), not in the shade.
 */
class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        // Signed out is not a failure and has nothing to retry: the next sign-in enqueues again.
        val session = SessionStore.loadSession(SessionStore.prefs(context)) ?: return Result.success()
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            return Result.retry()
        }
        val client = HealthConnectClient.getOrCreate(context)
        val engineSession = SyncEngine.Session(session.server, session.personId, session.cookie)
        var transient = false
        var expired = false
        val runEnd = Instant.now()
        val prefs = SessionStore.prefs(context)
        // Same cursors the screen reads: a background run that cannot reach them sends
        // the full window rather than skipping, except on 401 which ends the session.
        val cursorEnds = withContext(Dispatchers.IO) {
            when (val fetched = InstanceClient.get(engineSession.server, SyncCursors.pathFor(engineSession.personId), engineSession.cookie) {
                SyncCursors.parseCursorEnds(it.body)
            }) {
                is InstanceClient.Outcome.Ok -> fetched.value
                is InstanceClient.Outcome.Failed -> {
                    val error = fetched.error
                    if (error is InstanceClient.InstanceHttpException && error.status == 401) {
                        expired = true
                        return@withContext emptyMap()
                    }
                    if (error is IOException) transient = true
                    Log.w(SyncEngine.TAG, "cursors not read, full window instead: ${error.message}")
                    emptyMap()
                }
            }
        }
        if (expired) {
            SessionStore.clearSession(SessionStore.prefs(context))
            return Result.success()
        }
        SyncEngine.syncAll(
            client = client,
            session = engineSession,
            packageName = context.packageName,
            prefs = prefs,
            end = runEnd,
            post = { path, payload ->
                withContext(Dispatchers.IO) {
                    InstanceClient.post(engineSession.server, path, payload, engineSession.cookie) { }
                }
            },
            cursorEnds = cursorEnds,
            report = object : SyncEngine.Reporter {
                override fun typeStarted(key: String) = Unit
                override fun typeOk(key: String) {
                    // The same timestamp the screen reads, so a background run moves the rows
                    // even when nobody watched it go (T5.2).
                    prefs.edit()
                        .putLong(SyncStatus.lastKey(key), runEnd.toEpochMilli())
                        .putBoolean(SyncStatus.emptyKey(key), false)
                        .apply()
                }
                override fun typeEmpty(key: String) {
                    prefs.edit()
                        .putLong(SyncStatus.lastKey(key), runEnd.toEpochMilli())
                        .putBoolean(SyncStatus.emptyKey(key), true)
                        .apply()
                }
                override fun typeFailed(key: String, error: Throwable) {
                    Log.w(SyncEngine.TAG, "${SyncTypes.forKey(key).dataTypeId} not sent: ${error.message}")
                    // A socket is weather; a refusal is an answer. Only weather is worth waking
                    // for again, because the answer would be the same on retry.
                    if (error is IOException) transient = true
                }
                override fun sessionExpired() {
                    expired = true
                }
            },
        )
        if (expired) {
            // The cookie is dead and every later run would answer 401 the same way: forgetting
            // it stops the bleeding, and the next sign-in enqueues again. The screen does the
            // noisy half of this (back to login); here there is no screen.
            SessionStore.clearSession(SessionStore.prefs(context))
            return Result.success()
        }
        return if (transient) Result.retry() else Result.success()
    }
}
