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

    // dataTypeId directly followed by lastWindowEndMs: the legacy item's own shape, which
    // 0.1.0 already parses this way. The per source items below put dataSource between the
    // two on purpose -- companion.ts's own comment says so -- which is what keeps this
    // pattern from also matching them.
    private val legacyItem = Regex("\"dataTypeId\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"lastWindowEndMs\"\\s*:\\s*(null|\\d+)")

    /** dataTypeId to lastWindowEndMs, nulls dropped, from the legacy per type items. */
    fun parseCursorEnds(body: String): Map<String, Long> {
        val out = mutableMapOf<String, Long>()
        for (match in legacyItem.findAll(body)) {
            val id = match.groupValues[1]
            val raw = match.groupValues[2]
            if (raw != "null") out[id] = raw.toLong()
        }
        return out
    }

    // dataTypeId, then dataSource, then lastWindowEndMs: the placement that keeps a legacy
    // reader from mistaking this for its own item, and keeps legacyItem above from matching
    // this one either.
    private val sourceItem = Regex(
        "\"dataTypeId\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"dataSource\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"lastWindowEndMs\"\\s*:\\s*(null|\\d+)",
    )

    /** dataTypeId to dataSource to that source's own lastWindowEndMs, nulls dropped. */
    fun parseSourceCursorEnds(body: String): Map<String, Map<String, Long>> {
        val out = mutableMapOf<String, MutableMap<String, Long>>()
        for (match in sourceItem.findAll(body)) {
            val dataTypeId = match.groupValues[1]
            val dataSource = match.groupValues[2]
            val raw = match.groupValues[3]
            if (raw == "null") continue
            out.getOrPut(dataTypeId) { mutableMapOf() }[dataSource] = raw.toLong()
        }
        return out
    }

    /**
     * One cursor per type, read the way a shared cursor loses a late writer: the minimum
     * across that type's known sources, not the maximum a single cursor shared between them
     * used to answer. A source that lags pulls the whole type back to its own progress, and
     * the archive deduplicates whatever overlap that reaches into what another source already
     * carried. Computed from the per source items rather than trusted from the legacy field,
     * so a source the legacy field has not folded in yet still pulls the type back; a type
     * with no per source rows of its own falls back to the legacy field, which is null for a
     * type nothing has sent, same as this answers by being absent.
     */
    fun cursorEndsFor(body: String): Map<String, Long> {
        val bySource = parseSourceCursorEnds(body)
        val fromSources = bySource.mapValues { (_, sources) -> sources.values.min() }
        return parseCursorEnds(body) + fromSources
    }

    /**
     * Where one type starts reading, or null when there is nothing left to read this run.
     *
     * A first sync keeps the fallback window, a later one starts at the cursor minus the
     * overlap, clamped inside the fallback: never before what the permission will answer.
     *
     * A cursor ahead of the phone's own clock is a normal state, not an error: a watch or a
     * phone with a wrong clock at the previous sync can write a point timestamped in the
     * future, and the instance's cursor follows whatever it was sent. Clamping the start to
     * exactly [end] used to build TimeRangeFilter.between(end, end), which connect-client
     * refuses, and every type then failed with a connection error until the wall clock caught
     * up. Answering null instead says what is actually true: nothing to read this run, not a
     * failure, and the caller skips the read rather than asking Health Connect for an empty
     * range.
     */
    fun startFor(lastWindowEndMs: Long?, fallbackStart: Instant, end: Instant): Instant? {
        if (lastWindowEndMs == null) return fallbackStart
        val candidate = Instant.ofEpochMilli(lastWindowEndMs - OVERLAP_MS)
        if (candidate.isBefore(fallbackStart)) return fallbackStart
        if (!candidate.isBefore(end)) return null
        return candidate
    }
}
