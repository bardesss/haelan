package com.haelan.android.glance.geometry

// The week card's seven small bars (apps/web/src/pages/dashboard/WeekBars.tsx): oldest first, the
// day shown last and highlighted, a silent day a gap rather than a bar of no height.

/** One bar: its [height] as a share of the tallest (0 to 1), and whether it is the day shown. */
data class WeekBar(val index: Int, val height: Float, val shownDay: Boolean)

/**
 * The bars' box, in dp. The bars draw [DRAW_HEIGHT] tall, the web's size, but each day's tap slot is
 * [TAP_HEIGHT] tall, Android's smallest comfortable target, and the whole of its column wide
 * ([tapSlot]), so a thumb that lands between two bars or above a short one still opens a day.
 */
object WeekBarBox {
    const val WIDTH = 112f
    const val DRAW_HEIGHT = 44f
    const val TAP_HEIGHT = 48f

    /** Day [index]'s tap slot of [count], left and right edge: the columns tile the width, no gaps. */
    fun tapSlot(index: Int, count: Int): ClosedFloatingPointRange<Float> {
        val column = WIDTH / count
        return index * column..(index + 1) * column
    }
}

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
