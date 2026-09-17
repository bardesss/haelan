package com.haelan.android

/**
 * When each type last reached the instance, in a form the screen can read.
 *
 * A background run that Doze stops leaves no failure behind, so the only trace of a silent
 * gap is a timestamp that stops moving. The timestamps live in the same preferences as the
 * toggles, under keys no toggle uses, and the worker writes them the same way the button
 * does, so a day without any run reads as stale on every row.
 */
object SyncStatus {

    private const val DAY_MS = 24L * 60L * 60L * 1000L

    /** Where the last finished run for one toggle is kept, as epoch millis, zero when never. */
    fun lastKey(key: String): String = "last_sync_$key"

    /** Whether that run found nothing to send, kept beside the timestamp above. */
    fun emptyKey(key: String): String = "last_sync_empty_$key"

    /**
     * Whole days between a stored timestamp and now. Zero for the same day and for a clock
     * that moved backwards, because neither is a gap.
     */
    fun daysSince(lastMs: Long, nowMs: Long): Long {
        if (nowMs <= lastMs) return 0L
        return (nowMs - lastMs) / DAY_MS
    }

    /**
     * Whether a row has no run to show or its last run is at least a day old. The background
     * goes twice a day, so a day without a run is the gap this task makes visible rather than
     * a rounding choice.
     */
    fun isStale(lastMs: Long?, nowMs: Long): Boolean {
        if (lastMs == null || lastMs <= 0L) return true
        return daysSince(lastMs, nowMs) >= 1L
    }

    /**
     * The absolute time a row names beside its relative sentence, so "today" still says
     * when. Day and hour in the device zone, no year: a sync timestamp older than a year
     * is a gap the day count already names.
     */
    fun formatAt(lastMs: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
        val at = java.time.Instant.ofEpochMilli(lastMs).atZone(zone)
        val day = at.dayOfMonth.toString()
        val month = at.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH)
        val time = at.toLocalTime().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
        return "$day $month $time"
    }
}
