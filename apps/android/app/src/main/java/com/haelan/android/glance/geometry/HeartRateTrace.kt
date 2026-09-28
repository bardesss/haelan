package com.haelan.android.glance.geometry

import com.haelan.android.glance.IntradayPoint
import com.haelan.android.glance.WorkoutSession
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

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

/** The stretch of time the trace spans: from [startMs], to [endMs] or, when null, to the newest reading. */
data class TraceWindow(val startMs: Long, val endMs: Long?)

/**
 * The trace's window for the payload's day [today] in the person's [zone]: from its local midnight,
 * and on a finished day to the next local midnight, so the whole day is drawn; today it ends at the
 * last reading (null), never at a moment not yet reached. Midnight is the zone's, so a day that
 * loses or gains an hour to daylight saving is 23 or 25 hours wide, as the web's localMidnightMs
 * makes it. An instant to draw from, never a day to ask for.
 *
 * A finished day with [offsetMinutes] (the offset its readings were recorded under) is reckoned in
 * that offset instead, as the web's TodayCard does: a day lived in Amsterdam still runs midnight to
 * midnight Amsterdam time when the person looks at it from Tokyo. Today keeps [zone], where the
 * person is.
 */
fun traceWindow(today: String, finished: Boolean, zone: ZoneId, offsetMinutes: Int?): TraceWindow {
    val day = LocalDate.parse(today)
    val reckonedIn = if (finished && offsetMinutes != null) ZoneOffset.ofTotalSeconds(offsetMinutes * 60) else zone
    fun midnight(date: LocalDate) = date.atStartOfDay(reckonedIn).toInstant().toEpochMilli()
    return TraceWindow(midnight(day), if (finished) midnight(day.plusDays(1)) else null)
}
