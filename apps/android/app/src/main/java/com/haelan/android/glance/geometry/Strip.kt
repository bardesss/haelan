package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.GlanceStripDay

// A figure's seven-day strip as the web's Sparkline draws it in `dots` mode with its per-day
// `bands` (apps/web/src/charts/Sparkline.tsx, pages/dashboard/cardShared.tsx's stripBands): a slot
// per day, a dot on each day with a value, the line broken at a silent day, each day's own usual as
// a step behind its dot, and the figure's own usual labelled at its two edges.

/** How a strip dot is coloured: outside its day's usual, the latest day, or any other day. */
enum class DotRole { NORMAL, LATEST, OUTSIDE }

data class StripPoint(val x: Float, val y: Float)

/**
 * One day's dot. [large] is the latest day with a value, drawn larger whatever its [role]: a latest
 * day outside its usual keeps the size and takes the warning colour, as the web draws it.
 */
data class StripDot(val index: Int, val x: Float, val y: Float, val role: DotRole, val large: Boolean)

/** One day's usual as a step: its whole slot wide, from its own low ([bottom]) to its own high ([top]). */
data class StripBand(val index: Int, val left: Float, val right: Float, val top: Float, val bottom: Float)

/**
 * The figure's own usual, labelled at its edges on the strip's left, by the first day's slot centre
 * [x] and away from the latest dot, where the low label read as today's value. The values stay raw
 * numbers: the card formats them the way it formats the figure.
 */
data class StripBandLabels(val low: Double, val high: Double, val lowY: Float, val highY: Float, val x: Float)

data class StripLayout(
    val dots: List<StripDot>,
    /** The line through the dots, one run per stretch of consecutive days with a value. */
    val lines: List<List<StripPoint>>,
    val bands: List<StripBand>,
    val labels: StripBandLabels?,
)

/**
 * The strip laid out in a [width] by [height] plot area (y down), or null when fewer than two days
 * have a value: a single dot is not a shape, and the cards leave the strip out then.
 *
 * Each dot's role is its day's `standing`, the server's verdict; no value is compared with a band
 * here. A day's band is drawn only when it has one that is not thin: a thin usual judges nothing, so
 * shading it would claim a usual the verdict does not stand on. The labels are the figure's own
 * [baseline] under the same rule.
 *
 * The vertical extent is fitted to the values, the labelled edges and every drawn step, so no band
 * runs off the plot; the web's echarts axis widens for the labelled band only and lets a step draw
 * past its grid, which a Canvas would clip.
 */
fun stripLayout(days: List<GlanceStripDay>, baseline: GlanceBaseline?, width: Float, height: Float): StripLayout? {
    if (!showsStrip(days)) return null
    val usual = stripUsual(baseline)
    val dayBands = days.map { day -> day.band?.takeUnless { it.thin } }

    val extent = buildList {
        days.forEach { day -> day.value?.let(::add) }
        dayBands.forEach { band -> band?.let { add(it.low); add(it.high) } }
        usual?.let { add(it.low); add(it.high) }
    }
    var min = extent.min()
    var max = extent.max()
    if (max == min) {
        min -= 1.0
        max += 1.0
    }
    val slot = width / days.size
    fun x(index: Int) = (index + 0.5f) * slot
    fun y(value: Double) = (height - (value - min) / (max - min) * height).toFloat()

    val latest = days.indexOfLast { it.value != null }
    val dots = days.mapIndexedNotNull { index, day ->
        val value = day.value ?: return@mapIndexedNotNull null
        val outside = day.standing == GlanceStanding.ABOVE || day.standing == GlanceStanding.BELOW
        val role = when {
            outside -> DotRole.OUTSIDE
            index == latest -> DotRole.LATEST
            else -> DotRole.NORMAL
        }
        StripDot(index, x(index), y(value), role, large = index == latest)
    }

    val lines = mutableListOf<List<StripPoint>>()
    var run = mutableListOf<StripPoint>()
    days.forEachIndexed { index, day ->
        val value = day.value
        if (value == null) {
            if (run.isNotEmpty()) lines += run
            run = mutableListOf()
        } else {
            run += StripPoint(x(index), y(value))
        }
    }
    if (run.isNotEmpty()) lines += run

    val bands = dayBands.mapIndexedNotNull { index, band ->
        band?.let { StripBand(index, index * slot, (index + 1) * slot, y(it.high), y(it.low)) }
    }
    val labels = usual?.let { StripBandLabels(it.low, it.high, y(it.low), y(it.high), x(0)) }
    return StripLayout(dots, lines, bands, labels)
}

/** Whether a strip is drawn at all: two days with a value make a shape, one dot does not. The cards leave it out otherwise, caption and all. */
fun showsStrip(days: List<GlanceStripDay>): Boolean = days.count { it.value != null } >= 2

/**
 * The usual a strip labels, or null: none, or a thin one, which judges nothing and so is neither
 * shaded nor labelled. The one rule both the layout and the card's label gutter read.
 */
fun stripUsual(baseline: GlanceBaseline?): GlanceBaseline? = baseline?.takeUnless { it.thin }
