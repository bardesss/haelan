package com.haelan.android

import org.junit.Assert.assertEquals
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
    fun `a cursor past the end clamps to the end instead of reading backwards`() {
        // Past the end by more than the overlap: the candidate would start after the
        // end, so the read clamps to an empty window rather than going backwards.
        val cursor = end.plus(25, ChronoUnit.HOURS).toEpochMilli()
        assertEquals(end, SyncCursors.startFor(cursor, fallback, end))
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
}
