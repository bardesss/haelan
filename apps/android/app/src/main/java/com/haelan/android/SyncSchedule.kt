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

    const val UNIQUE_NAME = "haelan-background-sync"

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
     * Idempotent: the first enqueue wins and later ones keep it, so the screen can call this on
     * every start without rescheduling. A signed-out phone enqueues too, and the worker no-ops
     * until a sign-in gives it a session.
     */
    fun enqueue(context: Context) {
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, request())
    }
}
