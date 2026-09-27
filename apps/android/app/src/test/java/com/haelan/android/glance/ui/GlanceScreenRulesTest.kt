package com.haelan.android.glance.ui

import com.haelan.android.glance.Glance
import com.haelan.android.glance.GlanceParser
import com.haelan.android.glance.GlanceUiState
import com.haelan.android.glance.GlanceUiState.Problem
import com.haelan.android.glance.GlanceWeek
import com.haelan.android.glance.GlanceWeekFigure
import com.haelan.android.glance.figure
import com.haelan.android.glance.glance
import com.haelan.android.glance.glanceFixture
import com.haelan.android.glance.recovery
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which cards the glance shows and in what order: the web's dashboardRows.ts cases, read for a
 * phone where each card has the row to itself, and the page's body around them.
 */
class GlanceScreenRulesTest {

    private val week = GlanceWeek(steps = GlanceWeekFigure(8205.0, 6, 57432.0), activeMinutes = null, asleep = null)
    private val noWeek = GlanceWeek(steps = null, activeMinutes = null, asleep = null)
    private val unscored = recovery(index = figure("recovery_index", null), band = null)
    private val noRecovery = unscored.copy(restingHeartRate = figure("resting_heart_rate", null), hrv = figure("daily_hrv", null))

    private val night = CardSlot(CardKind.NIGHT)
    private val today = CardSlot(CardKind.TODAY)
    private val weekCard = CardSlot(CardKind.WEEK)

    @Test
    fun `a night and recovery lead, today and the week follow`() {
        assertEquals(
            listOf(night, CardSlot(CardKind.RECOVERY, wide = false), today, weekCard),
            cardRows(glance(week = week)),
        )
    }

    @Test
    fun `with no night recovery leads alone and goes wide`() {
        assertEquals(listOf(CardSlot(CardKind.RECOVERY, wide = true), today, weekCard), cardRows(glance(sleep = null, week = week)))
    }

    @Test
    fun `with no recovery reading at all the night leads alone`() {
        assertEquals(listOf(night, today, weekCard), cardRows(glance(recovery = noRecovery, week = week)))
    }

    @Test
    fun `with neither a night nor recovery the top row is left out`() {
        assertEquals(listOf(today, weekCard), cardRows(glance(sleep = null, recovery = noRecovery, week = week)))
    }

    @Test
    fun `an unscored day still shows recovery for the readings beside the index`() {
        assertEquals(CardSlot(CardKind.RECOVERY), cardRows(glance(recovery = unscored)).getOrNull(1))
        val hrvOnly = noRecovery.copy(hrv = figure("daily_hrv", 48.0))
        assertEquals(CardSlot(CardKind.RECOVERY), cardRows(glance(recovery = hrvOnly)).getOrNull(1))
    }

    @Test
    fun `a breathing rate alone is not a recovery card`() {
        // The web's hasRecovery reads the index and the two gauges; the breathing note has no dial.
        val breathing = noRecovery.copy(respiratoryRate = figure("respiratory_rate", 16.4))
        assertEquals(listOf(night, today), cardRows(glance(recovery = breathing, week = noWeek)))
    }

    @Test
    fun `with no week figure there is no week card`() {
        assertEquals(listOf(night, CardSlot(CardKind.RECOVERY), today), cardRows(glance(week = noWeek)))
        val asleepOnly = GlanceWeek(steps = null, activeMinutes = null, asleep = GlanceWeekFigure(400.0, 7, 2800.0))
        assertEquals(weekCard, cardRows(glance(week = asleepOnly)).last())
    }

    @Test
    fun `the seeded fixtures show the cards they hold`() {
        val todayGlance = GlanceParser.parse(glanceFixture("today.json"))
        assertEquals(listOf(night, CardSlot(CardKind.RECOVERY), today, weekCard), cardRows(todayGlance))
    }

    private fun state(glance: Glance?, problem: Problem? = null) =
        GlanceUiState(shownDay = null, glance = glance, fetchedAtMs = null, reachable = true, loading = false, problem = problem)

    @Test
    fun `the first run is the repository's verdict, said once instead of the cards`() {
        // empty.json is the person with nothing at all; the repository marks it FirstRun.
        val empty = GlanceParser.parse(glanceFixture("empty.json"))
        assertEquals(GlanceBody.Empty, bodyOf(state(empty, Problem.FirstRun)))
        // Without that verdict the same glance draws its cards: the rule is not decided twice.
        assertEquals(GlanceBody.Cards(empty, cardRows(empty)), bodyOf(state(empty)))
    }

    @Test
    fun `nothing to draw waits, and a glance draws its cards`() {
        assertEquals(GlanceBody.Waiting, bodyOf(null))
        assertEquals(GlanceBody.Waiting, bodyOf(state(null, Problem.TooOld)))
        val shown = glance(week = week)
        assertEquals(GlanceBody.Cards(shown, cardRows(shown)), bodyOf(state(shown, Problem.TooOld)))
    }

    private fun unreachable(glance: Glance?, fetchedAtMs: Long? = 100L, loading: Boolean = false) =
        GlanceUiState(shownDay = null, glance = glance, fetchedAtMs = fetchedAtMs, reachable = false, loading = loading, problem = null)

    @Test
    fun `nothing kept and nothing reached is the unreachable page, not a spinner`() {
        assertEquals(GlanceBody.Unreachable, bodyOf(unreachable(null, fetchedAtMs = null)))
        // Try again is in flight: the page waits for its answer instead.
        assertEquals(GlanceBody.Waiting, bodyOf(unreachable(null, fetchedAtMs = null, loading = true)))
        val shown = glance(week = week)
        assertEquals(GlanceBody.Cards(shown, cardRows(shown)), bodyOf(unreachable(shown)))
    }

    @Test
    fun `a glance the instance could not confirm is dated, and nothing shown has nothing to date`() {
        val shown = glance(week = week)
        assertEquals(GlanceNotice.Offline(100L), noticeOf(unreachable(shown)))
        assertEquals(null, noticeOf(unreachable(null, fetchedAtMs = null)))
        assertEquals(null, noticeOf(state(shown)))
        assertEquals(null, noticeOf(null))
    }

    @Test
    fun `what the instance says about itself is the line, over the cards or over nothing`() {
        val shown = glance(week = week)
        assertEquals(GlanceNotice.TooOld, noticeOf(state(shown, Problem.TooOld)))
        assertEquals(GlanceNotice.TooOld, noticeOf(state(null, Problem.TooOld)))
        assertEquals(GlanceNotice.Refused("no person p9"), noticeOf(state(shown, Problem.Refused("no person p9"))))
        assertEquals(null, noticeOf(state(shown, Problem.FirstRun)))
    }
}
