package com.haelan.android.glance.ui

import com.haelan.android.glance.Glance
import com.haelan.android.glance.GlanceNav
import com.haelan.android.glance.GlanceUiState
import com.haelan.android.glance.glance
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The top bar's day controls, state by state: the web's DayNav cases (pending, finished, a missing
 * neighbour) read off the repository's state instead of the URL.
 */
class DayNavStateTest {

    private val today = "2026-08-20"
    private val nav = GlanceNav(previous = "2026-08-18", next = null)
    private val todayGlance = glance(today = today).copy(nav = nav)
    private val pastGlance = glance(today = "2026-08-18", finished = true).copy(nav = GlanceNav("2026-08-17", "2026-08-19"))

    private fun state(glance: Glance?, shownDay: String? = null, loading: Boolean = false, known: String? = today) =
        GlanceUiState(shownDay, glance, fetchedAtMs = 1L, reachable = true, loading = loading, problem = null, today = known)

    @Test
    fun `today settled - the arrows are the payload's nav, no Today, not dimmed`() {
        assertEquals(
            DayNavState(previous = "2026-08-18", next = null, showToday = false, stepping = false, today = today, selected = today),
            DayNavState.from(state(todayGlance)),
        )
    }

    @Test
    fun `a past day settled - both arrows, Today, the calendar on that day`() {
        assertEquals(
            DayNavState(previous = "2026-08-17", next = "2026-08-19", showToday = true, stepping = false, today = today, selected = "2026-08-18"),
            DayNavState.from(state(pastGlance, shownDay = "2026-08-18")),
        )
    }

    @Test
    fun `stepping to a day - the held glance's nav is the wrong day's, so both arrows wait and the cards dim`() {
        val stepping = DayNavState.from(state(todayGlance, shownDay = "2026-08-18", loading = true))
        assertEquals(
            DayNavState(previous = null, next = null, showToday = true, stepping = true, today = today, selected = "2026-08-18"),
            stepping,
        )
    }

    @Test
    fun `stepping from a past day to another past day waits the same way`() {
        val stepping = DayNavState.from(state(pastGlance, shownDay = "2026-08-17", loading = true))
        assertEquals(true, stepping.stepping)
        assertEquals(null, stepping.previous)
        assertEquals(null, stepping.next)
    }

    @Test
    fun `a refresh of the day on screen is not stepping - its nav still holds`() {
        val refreshingToday = DayNavState.from(state(todayGlance, loading = true))
        assertEquals(false, refreshingToday.stepping)
        assertEquals("2026-08-18", refreshingToday.previous)
        val refreshingPast = DayNavState.from(state(pastGlance, shownDay = "2026-08-18", loading = true))
        assertEquals(false, refreshingPast.stepping)
        assertEquals("2026-08-19", refreshingPast.next)
    }

    @Test
    fun `going back to today while a past day is held dims it, and Today goes as soon as it is asked for`() {
        // showToday sets shownDay to null at once; the held glance is still the finished day's.
        val back = DayNavState.from(state(pastGlance, shownDay = null, loading = true))
        assertEquals(true, back.stepping)
        assertEquals(false, back.showToday)
    }

    @Test
    fun `a past day with no answer yet still offers Today, whatever nav says`() {
        // Opening yesterday: its own nav.next may be null while today has no data, and Today is then the way back.
        val yesterday = pastGlance.copy(nav = GlanceNav("2026-08-17", null))
        val settled = DayNavState.from(state(yesterday, shownDay = "2026-08-18"))
        assertEquals(null, settled.next)
        assertEquals(true, settled.showToday)
    }

    @Test
    fun `nothing on screen - nothing to step from, and no calendar before today is known`() {
        assertEquals(
            DayNavState(previous = null, next = null, showToday = false, stepping = false, today = null, selected = null),
            DayNavState.from(null),
        )
        val opening = DayNavState.from(state(null, loading = true, known = null))
        assertEquals(false, opening.stepping)
        assertEquals(false, opening.calendarEnabled)
    }

    @Test
    fun `the calendar opens once the person's today is known`() {
        assertEquals(true, DayNavState.from(state(todayGlance)).calendarEnabled)
        assertEquals(false, DayNavState.from(state(todayGlance, known = null)).calendarEnabled)
    }

    @Test
    fun `an unreachable day stops loading, so the held glance's arrows come back`() {
        val missed = DayNavState.from(state(pastGlance, shownDay = "2026-08-18", loading = false))
        assertEquals(false, missed.stepping)
        assertEquals("2026-08-17", missed.previous)
    }
}
