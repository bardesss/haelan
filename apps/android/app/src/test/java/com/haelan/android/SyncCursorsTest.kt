package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

class SyncCursorsTest {

    private val end: Instant = Instant.parse("2026-09-14T12:00:00Z")
    private val fallback: Instant = end.minus(30, ChronoUnit.DAYS)

    @Test
    fun `a type never sent keeps the full window`() {
        assertEquals(fallback, SyncCursors.startFor(null, fallback, end))
    }

    @Test
    fun `a recent cursor starts a day before it, not thirty days back`() {
        val cursor = end.minus(2, ChronoUnit.DAYS).toEpochMilli()
        assertEquals(
            Instant.ofEpochMilli(cursor - SyncCursors.OVERLAP_MS),
            SyncCursors.startFor(cursor, fallback, end),
        )
    }

    @Test
    fun `a cursor older than the fallback keeps the fallback`() {
        val cursor = end.minus(60, ChronoUnit.DAYS).toEpochMilli()
        assertEquals(fallback, SyncCursors.startFor(cursor, fallback, end))
    }

    @Test
    fun `a cursor past the end answers null instead of clamping to a degenerate range`() {
        // Past the end by more than the overlap: the candidate would land after the end.
        // TimeRangeFilter.between(end, end) is what clamping to end used to build, and
        // connect-client refuses it; null is how the caller learns to skip the read instead.
        val cursor = end.plus(25, ChronoUnit.HOURS).toEpochMilli()
        assertNull(SyncCursors.startFor(cursor, fallback, end))
    }

    @Test
    fun `a cursor exactly one overlap past the end also answers null, not a zero width range`() {
        // The candidate lands exactly on end -- the precise boundary TimeRangeFilter.between
        // rejects -- so this is the case Finding C's connection error came from.
        val cursor = end.plus(SyncCursors.OVERLAP_MS, ChronoUnit.MILLIS).toEpochMilli()
        assertNull(SyncCursors.startFor(cursor, fallback, end))
    }

    @Test
    fun `the parse keeps values and drops nulls`() {
        val body = """{"items":[
            {"dataTypeId":"weight","lastWindowEndMs":1787047200001,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","lastWindowEndMs":null,"lastIngestAtMs":null}
            ],"historyStartMs":1787047200000}"""
        val parsed = SyncCursors.parseCursorEnds(body)
        assertEquals(1787047200001L, parsed["weight"])
        assertTrue(!parsed.containsKey("steps"))
    }

    @Test
    fun `the per source parse keeps dataSource apart from the legacy item beside it`() {
        // dataSource sits between dataTypeId and lastWindowEndMs, which is what keeps the
        // legacy pattern from also matching it (companion.ts's own comment says why).
        val body = """{"items":[
            {"dataTypeId":"steps","lastWindowEndMs":1787040000000,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":1787040000000,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":1786953600000,"lastIngestAtMs":1769900000000}
            ],"historyStartMs":1786867200000}"""
        val bySource = SyncCursors.parseSourceCursorEnds(body)
        assertEquals(1787040000000L, bySource["steps"]?.get("com.haelan.android")?.lastWindowEndMs)
        assertEquals(1786953600000L, bySource["steps"]?.get("com.samsung.health")?.lastWindowEndMs)
        // The legacy item's own lastWindowEndMs never leaks into a source's map: it has no
        // dataSource field for the pattern to capture.
        assertEquals(2, bySource["steps"]?.size)
    }

    /**
     * Finding A's own scenario, built directly rather than derived from a buffering fixture: two
     * sources for one type whose cursors are more than an overlap apart, and a reading the
     * laggard has not sent yet, sitting between the laggard's own cursor and the leader's.
     *
     * The watch has not synced in three days; its own cursor, watchCursorMs, is stale. The phone
     * synced moments ago; phoneCursorMs is current. A cursor keyed on whichever source is newest
     * -- .max() -- reads the type's next delta starting one overlap behind the phone, which is
     * long after the watch's own last known progress. watchLateReadingMs, timestamped shortly
     * after the watch's stale cursor, then falls before that delta's start and the app never
     * asks for it again: the exact loss Finding A names. Keyed on the minimum, the delta reaches
     * back to the watch's own progress instead, comfortably inside where watchLateReadingMs sits.
     *
     * This lives here rather than in UploadCursorHoleTest because that file's retryStartFor
     * models the minimum in the test's own Kotlin, never calling cursorEndsFor at all -- a
     * fixture built on top of it cannot tell .min() from .max() no matter how it is tuned, which
     * is exactly what going red only for an even reading count turned out to mean. This test
     * calls the production parse and selection directly, the way SyncRun and SyncWorker do.
     */
    @Test
    fun `a laggard's own late reading still falls inside the delta keyed on the minimum, not the maximum`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - 3 * SyncCursors.OVERLAP_MS
        val watchLateReadingMs = watchCursorMs + SyncCursors.OVERLAP_MS / 2
        val nowMs = phoneCursorMs

        // Both sources ingested at their own cursor, three days apart -- nowhere near
        // STALE_SOURCE_MS, so the watch is merely a laggard here, not aged out. That is
        // what distinguishes this test from the ageing ones below: three days is the kind
        // of gap a real intermittent source produces, and it must still hold the minimum.
        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "the type's cursor is the watch's own stale progress, not the phone's fresh one",
            watchCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )

        val start = SyncCursors.startFor(
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
            Instant.EPOCH,
            Instant.ofEpochMilli(phoneCursorMs).plus(1, ChronoUnit.DAYS),
        )
        assertTrue(
            "the watch's own pending reading at ${watchLateReadingMs}ms must still be inside " +
                "the next delta, which starts at ${start?.toEpochMilli()}ms",
            start != null && !start.isAfter(Instant.ofEpochMilli(watchLateReadingMs)),
        )
    }

    /**
     * Finding 1 from the follow-up review: nothing aged a source out of the minimum, so a
     * retired watch's frozen cursor pinned the whole type's read start open forever. These two
     * cases are the proof STALE_SOURCE_MS closes that: a source silent longer than the threshold
     * stops holding the minimum back, and one silent for less than it still does -- otherwise a
     * watch worn only a couple of times a week would lose its next late reading exactly the way
     * Finding A's laggard, tested above, must not.
     */
    @Test
    fun `a source silent longer than STALE_SOURCE_MS stops holding the type's minimum back`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - 60 * SyncCursors.OVERLAP_MS // two months stale
        val nowMs = phoneCursorMs

        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "the retired watch no longer pins the type back once it has been silent past the threshold",
            phoneCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }

    @Test
    fun `a source silent for just under STALE_SOURCE_MS still holds the type's minimum back`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - (SyncCursors.STALE_SOURCE_MS - SyncCursors.OVERLAP_MS)
        val nowMs = phoneCursorMs

        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "a source just inside the threshold is an intermittent one, not a dead one, and still pulls the minimum back to it",
            watchCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }
}
