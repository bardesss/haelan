package com.haelan.android.glance.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WeekBarsTest {

    @Test
    fun `heights are each value over the week's largest, a silent day a gap`() {
        assertEquals(
            listOf(WeekBar(0, 0.5f, false), null, WeekBar(2, 1f, false), WeekBar(3, 0.25f, true)),
            weekBars(listOf(4000.0, null, 8000.0, 2000.0)),
        )
    }

    @Test
    fun `the last bar is the day shown, whatever its height`() {
        assertEquals(listOf(false, false, true), weekBars(listOf(9.0, 3.0, 1.0)).map { it?.shownDay })
    }

    @Test
    fun `a silent last day highlights nothing`() {
        assertEquals(listOf(false, null), weekBars(listOf(5.0, null)).map { it?.shownDay })
    }

    @Test
    fun `each day's tap slot is at least 48dp tall, taller than the bars it holds`() {
        assertTrue(WeekBarBox.TAP_HEIGHT >= 48f)
        assertTrue(WeekBarBox.TAP_HEIGHT >= WeekBarBox.DRAW_HEIGHT)
    }

    @Test
    fun `the seven tap slots are each a whole column, tiling the width with no gap between`() {
        val slots = (0 until 7).map { WeekBarBox.tapSlot(it, 7) }
        assertEquals(0f, slots.first().start)
        assertEquals(WeekBarBox.WIDTH, slots.last().endInclusive, 0.001f)
        for (i in 1 until 7) assertEquals(slots[i - 1].endInclusive, slots[i].start, 0.001f)
        for (slot in slots) assertEquals(WeekBarBox.WIDTH / 7, slot.endInclusive - slot.start, 0.001f)
    }

    @Test
    fun `a week of zeros draws flat bars rather than dividing by nothing`() {
        assertEquals(listOf(0f, 0f), weekBars(listOf(0.0, 0.0)).map { it?.height })
        assertEquals(listOf(0.5f), weekBars(listOf(0.5)).map { it?.height })
    }
}
