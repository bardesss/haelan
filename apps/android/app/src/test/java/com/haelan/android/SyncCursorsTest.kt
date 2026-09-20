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
        assertEquals(mapOf("com.haelan.android" to 1787040000000L, "com.samsung.health" to 1786953600000L), bySource["steps"])
        // The legacy item's own lastWindowEndMs never leaks into a source's map: it has no
        // dataSource field for the pattern to capture.
        assertEquals(2, bySource["steps"]?.size)
    }

    @Test
    fun `the type's cursor is the minimum across its sources, not the phone's own`() {
        // The watch lags two days behind the phone: a cursor keyed on whichever source is
        // busiest would hide exactly what Finding A describes, so the type reads from the
        // watch's own progress instead.
        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":1787040000000,"lastIngestAtMs":0},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":1786867200000,"lastIngestAtMs":0}
            ],"historyStartMs":0}"""
        assertEquals(1786867200000L, SyncCursors.cursorEndsFor(body)["steps"])
    }
}
