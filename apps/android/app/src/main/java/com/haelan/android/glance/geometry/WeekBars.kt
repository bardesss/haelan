package com.haelan.android.glance.geometry

// The week card's seven small bars (apps/web/src/pages/dashboard/WeekBars.tsx): oldest first, the
// day shown last and highlighted, a silent day a gap rather than a bar of no height.

/** One bar: its [height] as a share of the tallest (0 to 1), and whether it is the day shown. */
data class WeekBar(val index: Int, val height: Float, val shownDay: Boolean)

/**
 * The bars for [values], null where a day has none. Heights are each value over the week's largest,
 * and over at least 1, so a week of zeros draws flat bars rather than dividing by nothing.
 */
fun weekBars(values: List<Double?>): List<WeekBar?> {
    val max = maxOf(1.0, values.filterNotNull().maxOrNull() ?: 1.0)
    return values.mapIndexed { index, value ->
        value?.let { WeekBar(index, (it / max).toFloat(), shownDay = index == values.lastIndex) }
    }
}
