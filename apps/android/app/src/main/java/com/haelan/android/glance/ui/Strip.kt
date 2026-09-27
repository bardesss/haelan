package com.haelan.android.glance.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceStripDay
import com.haelan.android.glance.geometry.DotRole
import com.haelan.android.glance.geometry.stripLayout
import com.haelan.android.glance.geometry.stripUsual
import kotlin.math.abs

// The web draws the band at half strength over the card (charts/base.ts, OPACITY.baselineBand).
private const val BAND_ALPHA = 0.5f

/**
 * A figure's seven-day strip, drawn from [stripLayout]: each day's usual as a step behind its dot,
 * the line broken at a silent day, a dot per day with a value, the latest one larger, a day outside
 * its usual in the warning colour, and the figure's own usual labelled at its two edges.
 *
 * The labels sit in a gutter left of the plot, at the heights the layout gives them: the web draws
 * them left of the first day in the same way, and a Canvas has no room outside itself to spill into.
 *
 * Tapping a dot whose day is not [current] (the day the page shows, already open) calls
 * [onOpenDay] with that day; a screen reader gets the same through one custom action per day,
 * named by [openLabel]. [label] and [description] are the web's chart name and the sentence under
 * it (usualLine, or the caption), read together as the strip's description.
 */
@Composable
internal fun Strip(
    days: List<GlanceStripDay>,
    baseline: GlanceBaseline?,
    current: String,
    formatValue: (Double) -> String,
    label: String,
    description: String,
    openLabel: (String) -> String,
    onOpenDay: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalGlanceColors.current
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val labelStyle = MaterialTheme.typography.labelSmall.copy(color = colors.textMuted)
    val usual = stripUsual(baseline)
    val lowText = usual?.let { measurer.measure(formatValue(it.low), labelStyle) }
    val highText = usual?.let { measurer.measure(formatValue(it.high), labelStyle) }
    val gap = with(density) { 6.dp.toPx() }
    val gutter = maxOf(lowText?.size?.width ?: 0, highText?.size?.width ?: 0).let { if (it == 0) 0f else it + gap }
    // Room above and below the plot for the largest dot, so a day at either edge is not cut in half.
    val inset = with(density) { 6.dp.toPx() }

    // The gesture block below restarts only when the layout or the shown day changes, so it reads
    // the newest callback through this rather than keeping the one it started with.
    val openDay by rememberUpdatedState(onOpenDay)
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    val layout = remember(days, baseline, canvasSize, gutter) {
        if (canvasSize == IntSize.Zero) null
        else stripLayout(days, baseline, canvasSize.width - gutter, canvasSize.height - inset * 2)
    }
    val openable = layout?.dots.orEmpty().map { days[it.index].localDate }.filter { it != current }

    Canvas(
        modifier
            .fillMaxWidth()
            .height(64.dp)
            .onSizeChanged { canvasSize = it }
            .semantics {
                contentDescription = "$label, $description"
                customActions = openable.map { day -> CustomAccessibilityAction(openLabel(day)) { openDay(day); true } }
            }
            .pointerInput(layout, current) {
                val dots = layout?.dots ?: return@pointerInput
                val slot = (canvasSize.width - gutter) / days.size
                detectTapGestures { tap ->
                    val hit = dots.minByOrNull { abs(it.x + gutter - tap.x) } ?: return@detectTapGestures
                    val day = days[hit.index].localDate
                    if (abs(hit.x + gutter - tap.x) <= slot / 2 && day != current) openDay(day)
                }
            },
    ) {
        val strip = layout ?: return@Canvas
        val small = 3.dp.toPx()
        val large = 5.dp.toPx()
        val rim = 2.dp.toPx()
        translate(gutter, inset) {
            strip.bands.forEach { band ->
                drawRect(
                    color = colors.band,
                    topLeft = Offset(band.left, band.top),
                    size = Size(band.right - band.left, band.bottom - band.top),
                    alpha = BAND_ALPHA,
                )
            }
            strip.lines.filter { it.size > 1 }.forEach { run ->
                val path = Path().apply {
                    moveTo(run.first().x, run.first().y)
                    run.drop(1).forEach { lineTo(it.x, it.y) }
                }
                drawPath(path, colors.series, style = Stroke(width = 1.5.dp.toPx()))
            }
            strip.dots.forEach { dot ->
                val fill = when (dot.role) {
                    DotRole.OUTSIDE -> colors.negative
                    DotRole.LATEST -> colors.textPrimary
                    DotRole.NORMAL -> colors.series
                }
                val center = Offset(dot.x, dot.y)
                if (dot.large) {
                    drawCircle(colors.surfaceCard, radius = large + rim, center = center)
                    drawCircle(fill, radius = large, center = center)
                } else {
                    drawCircle(fill, radius = small, center = center)
                }
            }
        }
        strip.labels?.let { labels ->
            listOfNotNull(lowText?.let { it to labels.lowY }, highText?.let { it to labels.highY }).forEach { (text, y) ->
                drawText(text, topLeft = Offset(gutter - gap - text.size.width, inset + y - text.size.height / 2f))
            }
        }
    }
}
