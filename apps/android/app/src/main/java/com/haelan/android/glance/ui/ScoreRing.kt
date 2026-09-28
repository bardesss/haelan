package com.haelan.android.glance.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.haelan.android.glance.geometry.ringSweep
import kotlin.math.roundToLong

/**
 * The recovery index as a filling ring, drawn from [ringSweep]: an empty track, and on a scored day
 * the index's share of it filled clockwise from noon, the rounded index in the middle. An unscored
 * day is the track alone with [emptyText] ("Not scored") in the middle. The ring suits the index and
 * nothing else on the page: 0 to 100 is a real scale with a real top.
 */
@Composable
internal fun ScoreRing(value: Double?, emptyText: String, description: String, modifier: Modifier = Modifier, size: Dp = 112.dp) {
    val colors = LocalGlanceColors.current
    val measurer = rememberTextMeasurer()
    val valueStyle = MaterialTheme.typography.headlineSmall.copy(color = colors.textPrimary, fontWeight = FontWeight.Bold)
    val emptyStyle = MaterialTheme.typography.labelSmall.copy(color = colors.textMuted, fontWeight = FontWeight.Medium)
    val sweep = ringSweep(value)
    Canvas(modifier.size(size).clearAndSetSemantics { contentDescription = description }) {
        val w = this.size.width
        val stroke = w * 0.09f
        val r = w / 2 - stroke / 2 - 1.dp.toPx()
        val center = Offset(w / 2, w / 2)
        drawCircle(colors.surfaceInset, radius = r, center = center, style = Stroke(stroke))
        sweep?.let {
            drawArc(
                colors.positive, it.startDegrees, it.sweepDegrees, useCenter = false,
                topLeft = Offset(center.x - r, center.y - r), size = Size(r * 2, r * 2),
                style = Stroke(stroke, cap = StrokeCap.Round),
            )
        }
        val label = if (value == null) measurer.measure(emptyText, emptyStyle) else measurer.measure(value.roundToLong().toString(), valueStyle)
        drawText(label, topLeft = Offset(center.x - label.size.width / 2f, center.y - label.size.height / 2f))
    }
}
