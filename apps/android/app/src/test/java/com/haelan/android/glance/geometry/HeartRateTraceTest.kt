package com.haelan.android.glance.geometry

import com.haelan.android.glance.IntradayPoint
import com.haelan.android.glance.WorkoutSession
import com.haelan.android.glance.WorkoutSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HeartRateTraceTest {

    private val midnight = 1_787_176_800_000L
    private val minute = 60_000L

    private fun point(at: Long, mean: Double?, source: String = "watch", min: Double? = mean, max: Double? = mean, excluded: Boolean = false) =
        IntradayPoint(source, midnight + at * minute, min, mean, max, n = 1, excluded = excluded)

    private fun workout(from: Long, to: Long) = WorkoutSession(
        id = "w$from", sourceId = "watch", startMs = midnight + from * minute, endMs = midnight + to * minute,
        startOffsetMinutes = 120, endOffsetMinutes = 120, localDate = "2026-08-20",
        summary = WorkoutSummary(null, null, null, null, null, null),
        excluded = false, excludeReason = null, sources = listOf("watch"), alternateIds = emptyList(),
    )

    @Test
    fun `the mean runs from midnight to the last reading, broken where a minute has none`() {
        // Means 60 to 100 over a 40 high plot, minutes 0 to 100 over a 100 wide one.
        val points = listOf(point(0, 60.0), point(25, 100.0), point(50, null), point(75, 80.0), point(100, 70.0))
        val trace = checkNotNull(traceLayout(points, midnight, null, emptyList(), 100f, 40f))
        assertEquals(
            listOf(
                listOf(TracePoint(0f, 40f), TracePoint(25f, 0f)),
                listOf(TracePoint(75f, 20f), TracePoint(100f, 30f)),
            ),
            trace.lines.single().runs,
        )
    }

    @Test
    fun `a finished day runs to the next midnight`() {
        val points = listOf(point(0, 60.0), point(60, 100.0))
        val trace = checkNotNull(traceLayout(points, midnight, midnight + 240 * minute, emptyList(), 240f, 40f))
        assertEquals(60f, trace.lines.single().runs.single().last().x)
    }

    @Test
    fun `the extent counts each minute's min and max, not only its mean`() {
        val points = listOf(point(0, 70.0, min = 50.0, max = 90.0), point(10, 70.0))
        val trace = checkNotNull(traceLayout(points, midnight, null, emptyList(), 10f, 40f))
        assertEquals(20f, trace.lines.single().runs.single().first().y)
    }

    @Test
    fun `each source is its own line, in the order it first appears, sorted by time`() {
        val points = listOf(point(10, 60.0, "ring"), point(0, 70.0, "watch"), point(0, 80.0, "ring"), point(10, 90.0, "watch"))
        val trace = checkNotNull(traceLayout(points, midnight, null, emptyList(), 10f, 30f))
        assertEquals(listOf(0 to "ring", 1 to "watch"), trace.lines.map { it.sourceIndex to it.sourceId })
        assertEquals(listOf(0f, 10f), trace.lines[0].runs.single().map { it.x })
        assertEquals(listOf(10f, 30f), trace.lines[0].runs.single().map { it.y })
    }

    @Test
    fun `workouts are shaded, clamped to the day so far`() {
        val points = listOf(point(0, 60.0), point(100, 100.0))
        val trace = checkNotNull(traceLayout(points, midnight, null, listOf(workout(20, 40), workout(90, 130), workout(150, 160)), 100f, 40f))
        assertEquals(listOf(TraceSpan(20f, 40f), TraceSpan(90f, 100f)), trace.spans)
    }

    @Test
    fun `an excluded minute is marked on the line`() {
        val points = listOf(point(0, 60.0), point(50, 80.0, excluded = true), point(100, 100.0))
        val trace = checkNotNull(traceLayout(points, midnight, null, emptyList(), 100f, 40f))
        assertEquals(listOf(TracePoint(50f, 20f)), trace.excluded)
    }

    @Test
    fun `no trace without points`() {
        assertNull(traceLayout(emptyList(), midnight, null, emptyList(), 100f, 40f))
    }
}
