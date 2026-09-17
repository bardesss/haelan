package com.haelan.android

import java.time.Instant

/**
 * What the instance already holds for each type, so a sync reads what is new.
 *
 * The server answers one cursor per ingestible data type, null when never sent.
 * A null means the full window, a value means the delta back to that instant minus
 * an overlap. The overlap is what keeps a late watch reading, a corrected weight
 * and a night spanning midnight from falling between two runs: the archive
 * deduplicates the repeated day, so resending it costs rows the server discards
 * rather than a second copy.
 *
 * No org.json here on purpose: that class is a stub in a JVM unit test, so the
 * parse below reads the wire shape with a pattern instead.
 */
object SyncCursors {

    /** How far before the cursor a delta read starts, in milliseconds. */
    const val OVERLAP_MS: Long = 24L * 60L * 60L * 1000L

    /** The route below, spelled once so the screen and the worker ask the same thing. */
    fun pathFor(personId: String): String = "/api/v1/p/$personId/companion/cursors?platform=android"

    /** dataTypeId to lastWindowEndMs, nulls dropped. */
    fun parseCursorEnds(body: String): Map<String, Long> {
        val out = mutableMapOf<String, Long>()
        val item = Regex("\"dataTypeId\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"lastWindowEndMs\"\\s*:\\s*(null|\\d+)")
        for (match in item.findAll(body)) {
            val id = match.groupValues[1]
            val raw = match.groupValues[2]
            if (raw != "null") out[id] = raw.toLong()
        }
        return out
    }

    /**
     * Where one type starts reading. A first sync keeps the fallback window, a later
     * one starts at the cursor minus the overlap, clamped inside the fallback: never
     * before what the permission will answer, never past the end.
     */
    fun startFor(lastWindowEndMs: Long?, fallbackStart: Instant, end: Instant): Instant {
        if (lastWindowEndMs == null) return fallbackStart
        val candidate = Instant.ofEpochMilli(lastWindowEndMs - OVERLAP_MS)
        if (candidate.isBefore(fallbackStart)) return fallbackStart
        if (candidate.isAfter(end)) return end
        return candidate
    }
}
