package com.haelan.android.glance.geometry

import com.haelan.android.glance.CalendarDay
import com.haelan.android.glance.CalendarSleep
import com.haelan.android.glance.CalendarSteps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarGridTest {

    private fun cell(grid: List<List<CalendarCell?>>, date: String) = grid.flatten().filterNotNull().single { it.localDate == date }

    @Test
    fun `a month starting on a Sunday opens on six blanks`() {
        // March 2026 begins on a Sunday and has 31 days: six blanks, then five more weeks.
        val grid = calendarGrid("2026-03", emptyList(), today = "2026-09-27", firstDay = null)
        assertEquals(6, grid.size)
        assertEquals(listOf(null, null, null, null, null, null), grid[0].take(6))
        assertEquals(1, grid[0][6]?.dayOfMonth)
        assertEquals(2, grid[1][0]?.dayOfMonth)
        assertEquals(31, grid[5][1]?.dayOfMonth)
        assertEquals(listOf(null, null, null, null, null), grid[5].drop(2))
        assertTrue(grid.all { it.size == 7 })
    }

    @Test
    fun `a month starting on a Monday has no leading blank`() {
        // June 2026 begins on a Monday.
        val grid = calendarGrid("2026-06", emptyList(), today = "2026-09-27", firstDay = null)
        assertEquals(1, grid[0][0]?.dayOfMonth)
        assertEquals(5, grid.size)
    }

    @Test
    fun `a listed day is enabled with the server's two dots`() {
        val days = listOf(
            CalendarDay("2026-09-10", CalendarSleep.OUTSIDE, CalendarSteps.REACHED),
            CalendarDay("2026-09-11", null, CalendarSteps.BELOW),
            CalendarDay("2026-09-12", CalendarSleep.WITHIN, null),
        )
        val grid = calendarGrid("2026-09", days, today = "2026-09-27", firstDay = "2026-01-04")
        assertEquals(CalendarCell("2026-09-10", 10, true, false, SleepDot.OUTSIDE, StepsDot.REACHED), cell(grid, "2026-09-10"))
        assertEquals(CalendarCell("2026-09-11", 11, true, false, SleepDot.NOT_JUDGED, StepsDot.BELOW), cell(grid, "2026-09-11"))
        assertEquals(CalendarCell("2026-09-12", 12, true, false, SleepDot.WITHIN, StepsDot.NOT_JUDGED), cell(grid, "2026-09-12"))
    }

    @Test
    fun `a day not listed is grey, with no dots`() {
        val grid = calendarGrid("2026-09", emptyList(), today = "2026-09-27", firstDay = "2026-01-04")
        assertEquals(CalendarCell("2026-09-13", 13, false, false, null, null), cell(grid, "2026-09-13"))
    }

    @Test
    fun `a listed day after today is not enabled`() {
        val days = listOf(CalendarDay("2026-09-27", null, null), CalendarDay("2026-09-28", CalendarSleep.WITHIN, null))
        val grid = calendarGrid("2026-09", days, today = "2026-09-27", firstDay = "2026-01-04")
        assertTrue(cell(grid, "2026-09-27").enabled)
        assertTrue(cell(grid, "2026-09-27").isToday)
        assertFalse(cell(grid, "2026-09-28").enabled)
        assertNull(cell(grid, "2026-09-28").sleep)
    }

    @Test
    fun `a listed day before the first day is not enabled`() {
        val days = listOf(CalendarDay("2026-01-03", CalendarSleep.WITHIN, null), CalendarDay("2026-01-04", null, null))
        val grid = calendarGrid("2026-01", days, today = "2026-09-27", firstDay = "2026-01-04")
        assertFalse(cell(grid, "2026-01-03").enabled)
        assertTrue(cell(grid, "2026-01-04").enabled)
    }

    @Test
    fun `with no first day known, only today bounds the listing`() {
        val grid = calendarGrid("2026-01", listOf(CalendarDay("2026-01-03", null, null)), today = "2026-09-27", firstDay = null)
        assertTrue(cell(grid, "2026-01-03").enabled)
    }

    @Test
    fun `the month arrows reach from the first day's month to today's`() {
        assertTrue(monthReachable("2026-01", "2026-01-04", "2026-09-27"))
        assertTrue(monthReachable("2026-09", "2026-01-04", "2026-09-27"))
        assertFalse(monthReachable("2025-12", "2026-01-04", "2026-09-27"))
        assertFalse(monthReachable("2026-10", "2026-01-04", "2026-09-27"))
        assertFalse(monthReachable("2026-05", null, "2026-09-27"))
    }

    @Test
    fun `a month arrow pages one month, across the turn of the year`() {
        assertEquals("2026-08", shiftMonth("2026-09", -1))
        assertEquals("2026-10", shiftMonth("2026-09", 1))
        assertEquals("2025-12", shiftMonth("2026-01", -1))
        assertEquals("2027-01", shiftMonth("2026-12", 1))
    }
}
