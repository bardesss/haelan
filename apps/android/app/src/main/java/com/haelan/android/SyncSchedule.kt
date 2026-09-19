package com.haelan.android

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * When the background sync goes. The policy is data so a JVM test pins it; the request
 * is a thin shell over it, verified on the device it runs on rather than in a test that would
 * need the framework to build one.
 */
object SyncSchedule {

    /**
     * The name the work is enqueued under, and the tag it carries. Spelled by the worker rather
     * than written out here: a rename that missed one of the two would leave the old schedule
     * running and add a second one beside it, and nothing would fail loudly.
     */
    const val UNIQUE_NAME = SyncWorker.PERIODIC_WORK_NAME

    /**
     * Twice a day, only online, patient on failure. Online because the instance lives on the
     * home LAN: waking with no network can only fail, and a failure off the LAN is weather
     * rather than news, so the run waits instead of burning battery to learn nothing.
     * Twelve hours because health data goes stale by the day, not by the minute, and a missed
     * window is picked up by the next: the window is trailing, so nothing is skipped, only late.
     */
    data class Policy(val repeatHours: Long, val requiresNetwork: Boolean, val backoffMinutes: Long)

    fun policy(): Policy = Policy(repeatHours = 12, requiresNetwork = true, backoffMinutes = 10)

    fun request(): PeriodicWorkRequest {
        val decided = policy()
        return PeriodicWorkRequestBuilder<SyncWorker>(decided.repeatHours, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(
                        if (decided.requiresNetwork) NetworkType.CONNECTED else NetworkType.NOT_REQUIRED,
                    )
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, decided.backoffMinutes, TimeUnit.MINUTES)
            .addTag(UNIQUE_NAME)
            .build()
    }

    /**
     * How one enqueue meets the request an earlier one left.
     *
     * UPDATE, where this was KEEP. KEEP is right within one version and wrong across two: it keeps
     * whatever the first install enqueued, so a later release that changes [Policy.repeatHours] or
     * the backoff reaches nobody who already has the app. That matters more here than it would on
     * Play, because the app is distributed through Obtainium and updated over the top rather than
     * reinstalled - an install that keeps its schedule keeps it for the life of the phone.
     *
     * UPDATE re-registers the work and leaves a run that is already going alone, which is what the
     * screen calling this on every start needs: enqueue stays idempotent, and the schedule a new
     * release asks for is the schedule every install ends up with.
     */
    val ENQUEUE_POLICY: ExistingPeriodicWorkPolicy = ExistingPeriodicWorkPolicy.UPDATE

    /**
     * Idempotent: the same request enqueued twice is one schedule, so the screen can call this on
     * every start without piling up work. A signed-out phone enqueues too, and the worker no-ops
     * until a sign-in gives it a session.
     */
    fun enqueue(context: Context) {
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(UNIQUE_NAME, ENQUEUE_POLICY, request())
    }
}
