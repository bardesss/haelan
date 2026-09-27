package com.haelan.android.glance.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.haelan.android.glance.IntradayPoint
import com.haelan.android.glance.WorkoutSession
import com.haelan.android.glance.geometry.traceLayout

// The workout spans behind the trace, at the band's half strength as the web shades them.
private const val SPAN_ALPHA = 0.5f

/**
 * The Today card's slim heart rate trace, drawn from [traceLayout]: the day's workouts shaded
 * behind, each source's mean as a line broken where a minute has none, and an excluded minute
 * marked on it. The sources take the web's colours in the order they first appear: the series
 * colour, then the alternate, then the scale.
 *
 * [dayStartMs] is local midnight of the payload's day and [endMs] the next midnight on a finished
 * day, null today, so the line stops at the last reading and never runs past now.
 */
@Composable
internal fun HeartRateTrace(
    points: List<IntradayPoint>,
    dayStartMs: Long,
    endMs: Long?,
    workouts: List<WorkoutSession>,
    description: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalGlanceColors.current
    val sourceColors = listOf(colors.series, colors.seriesAlt, colors.scale4)
    Canvas(modifier.fillMaxWidth().height(80.dp).clearAndSetSemantics { contentDescription = description }) {
        val layout = traceLayout(points, dayStartMs, endMs, workouts, size.width, size.height) ?: return@Canvas
        layout.spans.forEach { span ->
            drawRect(colors.band, topLeft = Offset(span.left, 0f), size = Size(span.right - span.left, size.height), alpha = SPAN_ALPHA)
        }
        val width = 1.5.dp.toPx()
        layout.lines.forEach { line ->
            val color = sourceColors[line.sourceIndex % sourceColors.size]
            line.runs.forEach { run ->
                if (run.size == 1) {
                    drawCircle(color, radius = width, center = Offset(run[0].x, run[0].y))
                } else {
                    val path = Path().apply {
                        moveTo(run[0].x, run[0].y)
                        run.drop(1).forEach { lineTo(it.x, it.y) }
                    }
                    drawPath(path, color, style = Stroke(width))
                }
            }
        }
        layout.excluded.forEach { drawCircle(colors.textMuted, radius = 3.dp.toPx(), center = Offset(it.x, it.y)) }
    }
}
