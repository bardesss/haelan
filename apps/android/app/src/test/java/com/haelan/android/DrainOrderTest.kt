package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.random.Random

/**
 * A change feed hands records over in the order they changed, not the order they happened, and
 * chunkEnds compares neighbouring points: its span ceiling and the heart rate minute alignment
 * both assume ascending instants. The engine puts each identity's points in time order first.
 */
class DrainOrderTest {

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
    fun `a heart rate buffer in drain order chunks the same as its sorted copy`() {
        // Two dense hours of heart rate, a reading a second, each with a size of its own so a
        // reorder that lost track of which size belongs to which reading would show.
        val start = 1_700_000_000_000L
        val sorted = (0 until 7_200).map { start + it * 1_000L }
        val sizeOf = { t: Long -> 90 + ((t / 1_000L) % 7).toInt() }
        val shuffled = sorted.shuffled(Random(42))

        val order = SyncEngine.ascendingOrder(shuffled)
        val reorderedTimes = order.map { shuffled[it] }
        val reorderedSizes = order.map { sizeOf(shuffled[it]) }

        fun cut(times: List<Long>, sizes: List<Int>) =
            SyncEngine.chunkEnds(sizes, 64 * 1024, times, SyncEngine.MAX_CHUNK_SPAN_MS, SyncEngine.MAX_CHUNK_POINTS, alignToMinute = true)

        assertEquals(sorted, reorderedTimes)
        assertEquals(cut(sorted, sorted.map(sizeOf)), cut(reorderedTimes, reorderedSizes))
    }
}
