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

    /**
     * How long a source may sit silent before [cursorEndsFor] stops letting it hold a type's
     * minimum back. Mirrors companion.ts's STALE_SOURCE_MS, which carries the full reasoning:
     * too short ages out a watch worn only a couple of times a week between wearings, losing its
     * next late reading again -- the exact bug the (type, source) minimum exists to prevent. Too
     * long just leaves the window wider for longer before a truly dead source is dropped. Two
     * weeks is many multiples of this app's twice a day sync, comfortably past the worst case for
     * an intermittent watch, so it errs toward keeping a source rather than dropping one early.
     */
    const val STALE_SOURCE_MS: Long = 14L * 24L * 60L * 60L * 1000L

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

    // dataTypeId, then dataSource, then lastWindowEndMs, then lastIngestAtMs: the placement
    // that keeps a legacy reader from mistaking this for its own item, and keeps legacyItem
    // above from matching this one either. lastIngestAtMs is captured too now, since
    // cursorEndsFor needs it to tell a stale source from a live one.
    private val sourceItem = Regex(
        "\"dataTypeId\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"dataSource\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*" +
            "\"lastWindowEndMs\"\\s*:\\s*(null|\\d+)\\s*,\\s*\"lastIngestAtMs\"\\s*:\\s*(null|\\d+)",
    )

    /** One source's own progress: its newest window end, and when it last sent anything. */
    data class SourceCursor(val lastWindowEndMs: Long, val lastIngestAtMs: Long?)

    /** dataTypeId to dataSource to that source's own cursor, dropped when lastWindowEndMs is null. */
    fun parseSourceCursorEnds(body: String): Map<String, Map<String, SourceCursor>> {
        val out = mutableMapOf<String, MutableMap<String, SourceCursor>>()
        for (match in sourceItem.findAll(body)) {
            val dataTypeId = match.groupValues[1]
            val dataSource = match.groupValues[2]
            val rawEnd = match.groupValues[3]
            val rawIngest = match.groupValues[4]
            if (rawEnd == "null") continue
            val lastIngestAtMs = if (rawIngest == "null") null else rawIngest.toLong()
            out.getOrPut(dataTypeId) { mutableMapOf() }[dataSource] = SourceCursor(rawEnd.toLong(), lastIngestAtMs)
        }
        return out
    }

    /**
     * One cursor per type, read the way a shared cursor loses a late writer: the minimum
     * across that type's known LIVE sources, not the maximum a single cursor shared between
     * them used to answer. A source that lags pulls the whole type back to its own progress,
     * and the archive deduplicates whatever overlap that reaches into what another source
     * already carried. Computed from the per source items rather than trusted from the legacy
     * field, so a source the legacy field has not folded in yet still pulls the type back.
     *
     * "Live" excludes a source whose own lastIngestAtMs is older than [STALE_SOURCE_MS]: see
     * that constant for why a dead source must not pin the type's minimum open forever. A type
     * whose sources are all stale, same as one with no per source rows of its own, falls back
     * to the legacy field -- which the instance has aged the same way, so the fallback cannot
     * reintroduce the source this just excluded.
     */
    fun cursorEndsFor(body: String, nowMs: Long): Map<String, Long> {
        val bySource = parseSourceCursorEnds(body)
        val fromSources = bySource.mapNotNull { (dataTypeId, sources) ->
            val live = sources.values.filter { it.lastIngestAtMs == null || nowMs - it.lastIngestAtMs <= STALE_SOURCE_MS }
            if (live.isEmpty()) null else dataTypeId to live.minOf { it.lastWindowEndMs }
        }.toMap()
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
