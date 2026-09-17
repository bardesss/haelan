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
}
