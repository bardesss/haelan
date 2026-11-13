package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * A change feed hands records over in the order they changed, not the order they happened, and
 * chunkEnds compares neighbouring points: its span ceiling and the heart rate minute alignment
 * both assume ascending instants. The engine puts each identity's points in time order first.
 */
class DrainOrderTest {

    /** A heart rate point as the cut sees it: its instant and what it costs a request. */
    private data class Sample(val atMs: Long, val bytes: Int)

    private val start = 1_700_000_000_000L

    /** Two dense hours of heart rate, a reading a second, each with a size of its own. */
    private val sorted = (0 until 7_200).map { Sample(start + it * 1_000L, 90 + it % 7) }
    private val shuffled = sorted.shuffled(Random(42))

    @Test
    fun `points are put in time order, stable, with unreadable instants last`() {
        val times = listOf(30L, null, 10L, 20L, 10L, null)
        assertEquals(listOf(2, 4, 3, 0, 1, 5), SyncEngine.ascendingOrder(times))
    }

    @Test
    fun `an ascending buffer keeps its order`() {
        val times = listOf(1L, 2L, 2L, 3L)
        assertEquals(listOf(0, 1, 2, 3), SyncEngine.ascendingOrder(times))
    }

    @Test
    fun `a heart rate buffer in drain order cuts like its sorted copy once ordered, and not before`() {
        fun cut(points: List<Sample>) = SyncEngine.chunkEnds(
            points.map { it.bytes }, 64 * 1024, points.map { it.atMs },
            SyncEngine.MAX_CHUNK_SPAN_MS, SyncEngine.MAX_CHUNK_POINTS, alignToMinute = true,
        )
        val reordered = SyncEngine.ascendingOrder(shuffled.map { it.atMs }).map { shuffled[it] }

        // The order matters: the same points cut in change order land on other boundaries.
        assertNotEquals(cut(sorted), cut(shuffled))
        assertEquals(cut(sorted), cut(reordered))
    }

    @Test
    fun `uploadType's buffering sends a drained feed in the same chunks as a sorted read`() {
        fun chunks(batch: List<Sample>): List<List<Sample>> {
            val buffer = mutableListOf<Sample>()
            val sizeOf = { s: Sample -> s.bytes }
            val timeOf = { s: Sample -> s.atMs }
            val ready = SyncEngine.readyChunks(buffer, batch, true, sizeOf, timeOf)
            return ready + SyncEngine.chunksInTimeOrder(buffer, true, sizeOf, timeOf)
        }
        val fromSorted = chunks(sorted)
        val fromDrain = chunks(shuffled)

        assertTrue("seven thousand points of ~93 bytes are more than one chunk", fromSorted.size > 1)
        assertEquals(fromSorted, fromDrain)
        for (chunk in fromDrain) {
            assertEquals(chunk.sortedBy { it.atMs }, chunk)
        }
    }
}
