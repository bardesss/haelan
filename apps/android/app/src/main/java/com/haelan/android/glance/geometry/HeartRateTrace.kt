package com.haelan.android.glance.geometry

import com.haelan.android.glance.IntradayPoint
import com.haelan.android.glance.WorkoutSession

// The Today card's slim heart rate trace, as the web's IntradayHeartRate draws it with `compact`
// (apps/web/src/charts/IntradayHeartRate.tsx): each source's mean as a line from local midnight to
// the last reading (or to the next midnight on a finished day), broken where a minute has no mean,
// the day's workouts shaded behind it, and an excluded minute marked.

data class TracePoint(val x: Float, val y: Float)

/**
 * One source's line. [sourceIndex] counts sources in the order they first appear, which is how the
 * web picks each one's colour (the series colour, then the alternate, then the scale).
 */
data class TraceLine(val sourceIndex: Int, val sourceId: String, val runs: List<List<TracePoint>>)

/** A workout's stretch, clamped to the plot. */
data class TraceSpan(val left: Float, val right: Float)

data class TraceLayout(
    val lines: List<TraceLine>,
    val spans: List<TraceSpan>,
    /** Where an excluded minute is marked: still folded into the mean, so still on the line. */
    val excluded: List<TracePoint>,
)

/**
 * The trace in a [width] by [height] plot area (y down), or null with no points, where the card
 * draws no trace. x runs from [dayStartMs] (local midnight, from the payload's day) to [endMs], or
 * to the newest reading when [endMs] is null: the day so far and not a moment past it.
 *
 * The vertical extent is fitted to every minute's min, mean and max, as the web's is: its compact
 * form keeps the stacked min and range series, painted invisibly, and they still size the axis.
 * Each source's points are sorted by time, since the response interleaves sources.
 */
fun traceLayout(
    points: List<IntradayPoint>,
    dayStartMs: Long,
    endMs: Long?,
    workouts: List<WorkoutSession>,
    width: Float,
    height: Float,
): TraceLayout? {
    if (points.isEmpty()) return null
    val end = endMs ?: points.maxOf { it.utcMs }
    val spanMs = (end - dayStartMs).coerceAtLeast(1L).toFloat()
    val readings = points.flatMap { listOfNotNull(it.min, it.mean, it.max) }
    var low = readings.minOrNull() ?: 0.0
    var high = readings.maxOrNull() ?: 1.0
    if (high == low) {
        low -= 1.0
        high += 1.0
    }
    fun x(ms: Long) = (ms - dayStartMs) / spanMs * width
    fun y(value: Double) = (height - (value - low) / (high - low) * height).toFloat()

    val bySource = points.groupBy { it.sourceId }
    val lines = bySource.entries.mapIndexed { index, (sourceId, own) ->
        val runs = mutableListOf<List<TracePoint>>()
        var run = mutableListOf<TracePoint>()
        own.sortedBy { it.utcMs }.forEach { point ->
            val mean = point.mean
            if (mean == null) {
                if (run.isNotEmpty()) runs += run
                run = mutableListOf()
            } else {
                run += TracePoint(x(point.utcMs), y(mean))
            }
        }
        if (run.isNotEmpty()) runs += run
        TraceLine(index, sourceId, runs)
    }
    val excluded = points.filter { it.excluded }.mapNotNull { point ->
        (point.mean ?: point.max ?: point.min)?.let { TracePoint(x(point.utcMs), y(it)) }
    }
    val spans = workouts.mapNotNull { workout ->
        val left = x(workout.startMs).coerceIn(0f, width)
        val right = x(workout.endMs).coerceIn(0f, width)
        if (right > left) TraceSpan(left, right) else null
    }
    return TraceLayout(lines, spans, excluded)
}
