package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ceiling the sync has to stay under, measured instead of assumed.
 *
 * The app splits a type's points by size (SyncEngine.chunksBySize, half a mebibyte) while the
 * route refuses a request carrying more than 10000 points (ingest.ts, MAX_POINTS). Two different
 * units bounding one request is only safe while the smaller one bites first, and the window
 * stopped being 30 days, which is the change that turns that from a thought into a fact worth
 * holding: the number below is what the densest type actually costs.
 *
 * Measured on the wire shape rather than through JSONObject, which is a stub in a JVM unit test
 * ("Method put in org.json.JSONObject not mocked") and would have measured a fabricated string
 * anyway. These literals are the same UTF-8 bytes a server's JSON.stringify produces for the
 * point toHeartRatePoints builds: the keys and braces around a nested sampleTime, the instant the
 * phone writes, and the offset as a number.
 */
class IngestChunkSizeTest {
    private val pointBytes = """
        {"heartRate":{"sampleTime":{"physicalTime":"2026-09-14T10:40:00Z","utcOffset":7200},"beatsPerMinute":62}}
    """.trimIndent().toByteArray(Charsets.UTF_8).size

    @Test
    fun `a full chunk of the densest type stays under the point ceiling the route enforces`() {
        // One more byte per point for the separator between them in the array.
        val perChunk = (512 * 1024) / (pointBytes + 1)

        println("measured: $pointBytes bytes per heart rate point, $perChunk points per 512 KiB chunk")
        assertTrue("a $perChunk point chunk must stay under the route's 10000", perChunk <= 10_000)
    }

    @Test
    fun `the point shape is the one the mapper writes`() {
        // A guard against this measurement drifting from the mapper: a point that stopped carrying
        // one of these three keys would be a different payload, not a smaller one.
        val point = """
            {"heartRate":{"sampleTime":{"physicalTime":"2026-09-14T10:40:00Z","utcOffset":7200},"beatsPerMinute":62}}
        """.trimIndent()

        assertTrue(point.contains("\"heartRate\""))
        assertTrue(point.contains("\"sampleTime\""))
        assertTrue(point.contains("\"beatsPerMinute\""))
        assertTrue(pointBytes > 100)
    }

    /**
     * The cut policy the streaming sync flushes by, in per-point byte costs including the
     * separator. Pure integers, because JSONObject is a stub here: this pins where one
     * request ends and the next begins, which is what keeps a phone's heap bounded.
     */
    @Test
    fun `cuts cover every point exactly once`() {
        assertEquals(listOf(2, 3), SyncEngine.chunkEnds(listOf(200, 200, 200), 512))
    }

    @Test
    fun `a point over the ceiling travels alone rather than being dropped`() {
        assertEquals(listOf(1), SyncEngine.chunkEnds(listOf(600), 512))
    }

    @Test
    fun `an exact fit does not split`() {
        assertEquals(listOf(2), SyncEngine.chunkEnds(listOf(256, 256), 512))
    }

    @Test
    fun `empty stays empty`() {
        assertEquals(emptyList<Int>(), SyncEngine.chunkEnds(emptyList(), 512))
    }

    // ---- The reach of a chunk, which the byte ceiling cannot express ----

    private val hourMs = 60L * 60L * 1000L

    /**
     * A source that writes little never fills the byte budget, so before this ceiling existed its
     * whole window travelled as one request and a refusal took all of it. The instance's cursor
     * cannot be made to notice: it is the newest end that landed, whichever source carried it, and
     * the next sync re-reads from it minus the overlap. So the chunk's own reach is what bounds the
     * loss, and it is bounded to half the overlap (SyncEngine.MAX_CHUNK_SPAN_MS).
     */
    @Test
    fun `a buffer small in bytes still splits once it covers more than the span ceiling`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        // Six readings of one byte each, eight hours apart: nowhere near any byte budget, and
        // forty hours of window across them. The cut lands where the ceiling is exceeded, and the
        // point that exceeds it opens the next chunk.
        val sizes = List(6) { 1 }
        val times = listOf(0L, 8 * hourMs, 16 * hourMs, 24 * hourMs, 32 * hourMs, 40 * hourMs)

        assertEquals(listOf(2, 4, 6), SyncEngine.chunkEnds(sizes, 1024, times, span))
    }

    @Test
    fun `a chunk that reaches exactly the ceiling is not split`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        // The ceiling is a ceiling, not a target: the pair that spans it exactly still travels
        // together, which is what leaves the whole overlap as margin rather than half of it.
        assertEquals(listOf(2), SyncEngine.chunkEnds(listOf(1, 1), 1024, listOf(0L, span), span))
    }

    @Test
    fun `the byte ceiling still bites first when it comes first`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        // A dense source: two points a second apart, each over half the byte budget. Time says
        // nothing here, and the cut has to stay where it always was.
        assertEquals(
            listOf(1, 2),
            SyncEngine.chunkEnds(listOf(600, 600), 1024, listOf(0L, 1000L), span),
        )
    }

    @Test
    fun `a point with no readable instant is bounded by bytes alone`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        // The second instant is unreadable, which measures no span rather than a span of zero:
        // a boundary drawn over a reading the instance will drop anyway would be a boundary over
        // nothing.
        assertEquals(
            listOf(2),
            SyncEngine.chunkEnds(listOf(1, 1), 1024, listOf(0L, null), span),
        )
    }

    @Test
    fun `a single point wider than the span still travels alone`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        // Two points a week apart: neither can be dropped, and neither can be paired.
        assertEquals(listOf(1, 2), SyncEngine.chunkEnds(listOf(1, 1), 1024, listOf(0L, 7 * 24 * hourMs), span))
    }

    /**
     * Why the read asks for ascending order instead of trusting the provider's default.
     *
     * The ceiling measures a chunk's reach as the last point's instant minus the first point's, so a
     * list that is not in time order measures a span no reader ever experienced. Nineteen points
     * across sixteen hours, listed newest first, look like a four hour reach from the first to the
     * last and are cut as one chunk - which is a chunk that leaves behind sixteen hours of readings
     * for a refusal to lose, which is exactly what the ceiling exists to prevent.
     *
     * SyncEngine.uploadType passes `ascendingOrder = true` for this reason: connect-client defaults
     * to it, and the default being right today is not the same as this file being allowed to assume
     * it. A contract worth resting on is worth writing down at the call site.
     */
    @Test
    fun `an out of order buffer defeats the span ceiling, which is why the read asks for order`() {
        val span = SyncEngine.MAX_CHUNK_SPAN_MS
        val ordered = List(17) { it * hourMs }
        val newestFirst = ordered.reversed()

        assertEquals(
            "in order, sixteen hours split at the ceiling",
            listOf(13, 17),
            SyncEngine.chunkEnds(List(17) { 1 }, 1024, ordered, span),
        )
        assertEquals(
            "reversed, it looks like a four hour reach and is not split at all",
            listOf(17),
            SyncEngine.chunkEnds(List(17) { 1 }, 1024, newestFirst, span),
        )
    }
}
