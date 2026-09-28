package com.haelan.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The glance model's decisions, over the screen's state: which read a day request becomes, whether
 * a finished sync asks again, and which resumes do.
 */
class GlanceRequestsTest {

    private val today = "2026-08-20"

    private fun on(shownDay: String?, known: String? = today) =
        GlanceUiState(shownDay, glance = null, fetchedAtMs = null, reachable = true, loading = false, problem = null, today = known)

    @Test
    fun `a past day is read as that day`() {
        assertEquals(DayRequest.Day("2026-08-18"), DayRequest.of(on(null), "2026-08-18"))
        assertEquals(DayRequest.Day("2026-08-17"), DayRequest.of(on("2026-08-18"), "2026-08-17"))
    }

    @Test
    fun `the person's today from a past day goes back to today, not to a day read`() {
        assertEquals(DayRequest.Today, DayRequest.of(on("2026-08-18"), today))
    }

    @Test
    fun `the day already on screen or on its way is not asked again`() {
        assertEquals(DayRequest.None, DayRequest.of(on("2026-08-18"), "2026-08-18"))
        assertEquals(DayRequest.None, DayRequest.of(on(null), today))
    }

    @Test
    fun `before today is known a day is read as a day`() {
        assertEquals(DayRequest.Day(today), DayRequest.of(on("2026-08-18", known = null), today))
    }

    @Test
    fun `Today goes back only from a past day`() {
        assertEquals(DayRequest.Today, DayRequest.today(on("2026-08-18")))
        assertEquals(DayRequest.None, DayRequest.today(on(null)))
    }

    @Test
    fun `a finished sync asks again on today and leaves a past day alone`() {
        assertTrue(shouldRefreshOnSync(on(null)))
        assertFalse(shouldRefreshOnSync(on("2026-08-18")))
    }

    @Test
    fun `the first resume is the open's and does not ask again, every later one does`() {
        val rule = ResumeRule()
        assertFalse(rule.onResume())
        assertTrue(rule.onResume())
        assertTrue(rule.onResume())
    }
}
