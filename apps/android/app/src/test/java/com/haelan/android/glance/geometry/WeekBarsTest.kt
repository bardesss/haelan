package com.haelan.android.glance.geometry

import org.junit.Assert.assertEquals
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
    fun `a week of zeros draws flat bars rather than dividing by nothing`() {
        assertEquals(listOf(0f, 0f), weekBars(listOf(0.0, 0.0)).map { it?.height })
        assertEquals(listOf(0.5f), weekBars(listOf(0.5)).map { it?.height })
    }
}
