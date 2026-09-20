package com.haelan.android

import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * How far back a sync reads, which is a fact about the permission rather than a number to pick.
 *
 * Health Connect answers this itself (androidx.health.connect.client.permission.HealthPermission,
 * PERMISSION_READ_HEALTH_DATA_HISTORY): without that permission a read returns nothing older than
 * 30 days from the first Health Connect grant to this app, and asking for a single point older than
 * that is an error instead of an empty answer. With it, "read the entire history of health data".
 * So there are two honest windows and no third one, and a fixed 150 days was neither: the request
 * asked for 120 days that could not come back, which is a five times wider range for the provider
 * to walk and the same answer.
 *
 * [Instant.EPOCH] is how "the entire history" is said without an arbitrary number standing in for
 * it. The volume is bounded by what the phone holds rather than by this constant, and the archive
 * deduplicates a repeated window, so a second sync costs rows the server discards rather than a
 * second copy of the history.
 */
object SyncWindow {

    /**
     * The most Health Connect returns without the history permission: 30 days back
     * from the first grant. A platform limit, not a choice, so every window and every
     * sentence about depth reads it from here.
     */
    const val WITHOUT_HISTORY_DAYS = 30L

    fun forHistoryGranted(historyGranted: Boolean, end: Instant): Instant = when {
        historyGranted -> Instant.EPOCH
        else -> end.minus(WITHOUT_HISTORY_DAYS, ChronoUnit.DAYS)
    }
}
