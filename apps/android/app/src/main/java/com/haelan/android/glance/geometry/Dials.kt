package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceStanding
import kotlin.math.abs
import kotlin.math.max

// The Recovery card's three dials: resting heart rate and HRV as half-arc gauges against their usual
// (apps/web/src/pages/dashboard/UsualGauge.tsx), the index as a filling ring (ScoreRing.tsx).
// Angles are in degrees clockwise from three o'clock, the frame Compose's drawArc takes, so the
// gauge's upper half runs from 180 (nine o'clock) through 270 (noon) to 360.

/** The usual's stretch of the gauge and today's marker on it. */
data class GaugeBand(
    val startDegrees: Float,
    val sweepDegrees: Float,
    val markerDegrees: Float,
)

data class GaugeLayout(
    /** The value at the arc's left end and at its right end. */
    val min: Double,
    val max: Double,
    /** Null with no usual to stand on (none, or thin): the number on a plain arc, no marker claimed. */
    val band: GaugeBand?,
    /** From the server's `standing`, the marker's warning colour. */
    val outside: Boolean,
)

/**
 * The gauge for [value] against [baseline]. The arc spans the usual's centre plus or minus 2.5 of its
 * half-widths, so the band holds the middle 40% and "inside" and "outside" read at once (the web's
 * comment says a fifth; its arithmetic, copied here, gives two fifths); a band of
 * zero width (one reading, or a perfectly steady person) still gets an arc, its half-width 10% of the
 * centre and at least 1. The marker is clamped to the arc's ends. [outside] is the server's verdict:
 * where the marker sits is drawing, never judging.
 */
fun gaugeLayout(value: Double, baseline: GlanceBaseline?, standing: GlanceStanding?): GaugeLayout {
    val outside = standing == GlanceStanding.ABOVE || standing == GlanceStanding.BELOW
    val usual = baseline?.takeUnless { it.thin }
    val center = baseline?.center ?: value
    val half = usual?.let { (it.high - it.low) / 2 }?.takeIf { it != 0.0 } ?: max(abs(center) * 0.1, 1.0)
    val min = center - half * 2.5
    val max = center + half * 2.5
    if (usual == null) return GaugeLayout(min, max, null, outside)
    fun fraction(of: Double) = ((of - min) / (max - min)).coerceIn(0.0, 1.0)
    fun degrees(f: Double) = (180 + 180 * f).toFloat()
    val start = degrees(fraction(usual.low))
    return GaugeLayout(
        min = min,
        max = max,
        band = GaugeBand(
            startDegrees = start,
            sweepDegrees = degrees(fraction(usual.high)) - start,
            markerDegrees = degrees(fraction(value)),
        ),
        outside = outside,
    )
}

/** The ring's fill: from noon, clockwise, the index's share of 100. */
data class RingSweep(val startDegrees: Float, val sweepDegrees: Float)

/** The index ring's fill, or null on an unscored day, which draws the empty track and says why. */
fun ringSweep(index: Double?): RingSweep? = index?.let { RingSweep(-90f, (it / 100 * 360).toFloat()) }

/**
 * The recovery row's sizes, in dp, for [width] dp of card: the two gauges each in 30% of the row
 * and the ring in the middle 40%, each dial [DIAL_GAP] narrower than its share so neighbours never
 * touch, and none larger than the web's phone sizes (a 96 gauge, a 112 ring). On a 360dp phone the
 * card leaves about 296dp, where the web's fixed sizes need 304; the shares always sum to the row.
 */
data class DialSizes(val gauge: Float, val ring: Float, val gaugeShare: Float, val ringShare: Float)

const val DIAL_GAP = 4f

fun dialSizes(width: Float): DialSizes {
    val gaugeShare = 0.3f
    val ringShare = 1f - 2 * gaugeShare
    return DialSizes(
        gauge = minOf(96f, width * gaugeShare - DIAL_GAP),
        ring = minOf(112f, width * ringShare - DIAL_GAP),
        gaugeShare = gaugeShare,
        ringShare = ringShare,
    )
}
