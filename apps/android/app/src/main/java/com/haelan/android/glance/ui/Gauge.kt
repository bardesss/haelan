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
import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.geometry.gaugeLayout
import kotlin.math.cos
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * A reading with no natural top (resting heart rate, HRV) against its usual, drawn from
 * [gaugeLayout]: a half arc, the usual's stretch shaded on it, today's marker on the stretch, and
 * the rounded value with its unit in the bowl (the web's UsualGauge). With no usual to stand on the
 * layout has no band, and the gauge is the number on a plain arc with no marker claimed. The
 * marker takes the warning colour on the server's verdict, never on where it happens to sit.
 *
 * The proportions are the web's: the stroke 9% of [size], the arc's centre one stroke below the
 * middle, and the whole half a size plus three strokes tall.
 */
@Composable
internal fun Gauge(
    value: Double,
    baseline: GlanceBaseline?,
    standing: GlanceStanding?,
    unit: String,
    description: String,
    modifier: Modifier = Modifier,
    size: Dp = 96.dp,
) {
    val colors = LocalGlanceColors.current
    val measurer = rememberTextMeasurer()
    val valueStyle = MaterialTheme.typography.titleMedium.copy(color = colors.textPrimary, fontWeight = FontWeight.Bold)
    val unitStyle = MaterialTheme.typography.labelSmall.copy(color = colors.textMuted)
    val layout = gaugeLayout(value, baseline, standing)
    val stroke = size * 0.09f
    Canvas(modifier.size(size, size / 2 + stroke * 3).clearAndSetSemantics { contentDescription = description }) {
        val w = this.size.width
        val s = w * 0.09f
        val cx = w / 2
        val cy = w / 2 + s
        val r = w / 2 - s
        val topLeft = Offset(cx - r, cy - r)
        val box = Size(r * 2, r * 2)
        drawArc(colors.surfaceInset, 180f, 180f, useCenter = false, topLeft = topLeft, size = box, style = Stroke(s, cap = StrokeCap.Round))
        layout.band?.let { band ->
            drawArc(colors.borderChosen, band.startDegrees, band.sweepDegrees, useCenter = false, topLeft = topLeft, size = box, style = Stroke(s))
            val angle = Math.toRadians(band.markerDegrees.toDouble())
            val marker = Offset(cx + r * cos(angle).toFloat(), cy + r * sin(angle).toFloat())
            drawCircle(if (layout.outside) colors.negative else colors.textPrimary, radius = s * 0.75f, center = marker)
            drawCircle(colors.surfaceCard, radius = s * 0.75f, center = marker, style = Stroke(2.5.dp.toPx()))
        }
        val number = measurer.measure(value.roundToLong().toString(), valueStyle)
        drawText(number, topLeft = Offset(cx - number.size.width / 2f, cy - s * 0.4f - number.size.height * 0.8f))
        val unitText = measurer.measure(unit, unitStyle)
        drawText(unitText, topLeft = Offset(cx - unitText.size.width / 2f, cy + s * 1.4f - unitText.size.height * 0.8f))
    }
}
