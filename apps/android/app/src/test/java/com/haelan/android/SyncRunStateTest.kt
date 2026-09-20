package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The state the sync screen draws, and what becomes of it while no screen is there.
 *
 * The case behind this file is a phone turned sideways. That destroys the activity that started
 * the run, and a run cancelled on the way out is not a pause: what landed has already moved the
 * instance's cursor for that type, so a screen that owns the run can lose the rest of a window
 * nothing reads again. Three answers are pinned here, all of them decidable without Android:
 * the state outlives the screen, a screen that arrives paints what it finds, and a run that ended
 * for any reason leaves no row spinning.
 */
class SyncRunStateTest {

    /** A screen that keeps what it was told, so a case can say exactly what it got. */
    private class Fake : SyncRunState.Screen {
        val painted = mutableListOf<SyncRunState.Status>()
        var expiries = 0
        val failures = mutableListOf<Throwable>()

        override fun paint(status: SyncRunState.Status) {
            painted += status
        }

        override fun sessionExpired() {
            expiries++
        }

        override fun runFailed(error: Throwable) {
            failures += error
        }

        /** What this screen shows now, which is the last state it was handed. */
        fun shown(): SyncRunState.Status = painted.last()
    }

    @Test
    fun `a second tap while a run is going does not open a second one`() {
        val state = SyncRunState()
        assertTrue(state.begin(setOf("steps", "sleep")))
        assertFalse("a run is already going", state.begin(setOf("heart_rate")))
        assertEquals(setOf("steps", "sleep"), state.status().sending)
    }

    /**
     * The 401 early return and a run cancelled by the framework both end here, and neither leaves
     * a spinning row behind: the run is over, so a row that was still going goes back to neutral.
     */
    @Test
    fun `a run that ends leaves no row spinning`() {
        val state = SyncRunState()
        val screen = Fake().also { state.attach(it) }
        state.begin(setOf("steps", "sleep", "heart_rate"))
        state.mark("steps", SyncRunState.Mark.RUNNING)
        state.mark("sleep", SyncRunState.Mark.SENT)

        state.finish()

        assertEquals(SyncRunState.Mark.IDLE, screen.shown().marks["steps"])
        assertEquals("an answer already given survives the end of the run", SyncRunState.Mark.SENT, screen.shown().marks["sleep"])
        assertFalse(screen.shown().running)
    }

    /**
     * The rotation: the activity that started the run is destroyed, and the one that replaces it
     * has to show the run that is still going rather than a button that looks idle.
     */
    @Test
    fun `a screen created after a rotation paints the run that is still going`() {
        val state = SyncRunState()
        val first = Fake().also { state.attach(it) }
        state.begin(setOf("steps", "sleep"))
        state.mark("steps", SyncRunState.Mark.SENT)
        state.mark("sleep", SyncRunState.Mark.RUNNING)

        state.detach(first)
        val second = Fake().also { state.attach(it) }

        assertTrue(second.shown().running)
        assertEquals(SyncRunState.Mark.SENT, second.shown().marks["steps"])
        assertEquals(SyncRunState.Mark.RUNNING, second.shown().marks["sleep"])
        // And the run carries on into the screen that arrived, which is the point of the handover.
        state.mark("sleep", SyncRunState.Mark.FAILED)
        assertEquals(SyncRunState.Mark.FAILED, second.shown().marks["sleep"])
    }

    /**
     * The screen the system took away: nothing cancels the run, nothing is painted at a screen
     * that is gone, and the marks are still there for whoever comes back.
     */
    @Test
    fun `a screen that is gone is not painted and the run goes on without it`() {
        val state = SyncRunState()
        val screen = Fake().also { state.attach(it) }
        state.begin(setOf("steps"))
        val told = screen.painted.size

        state.detach(screen)
        state.mark("steps", SyncRunState.Mark.SENT)
        state.finish()

        assertEquals("a detached screen is told nothing more", told, screen.painted.size)
        assertEquals(SyncRunState.Mark.SENT, state.status().marks["steps"])
        assertFalse(state.status().running)
        val back = Fake().also { state.attach(it) }
        assertEquals("and the screen that comes back reads what happened", SyncRunState.Mark.SENT, back.shown().marks["steps"])
    }

    /** A run that ended is what a screen attaching much later paints, marks included. */
    @Test
    fun `the marks of a finished run are what the next screen paints`() {
        val state = SyncRunState()
        state.begin(setOf("steps", "sleep"))
        state.mark("steps", SyncRunState.Mark.SENT)
        state.mark("sleep", SyncRunState.Mark.FAILED)
        state.finish()

        val screen = Fake().also { state.attach(it) }

        assertEquals(SyncRunState.Mark.SENT, screen.shown().marks["steps"])
        assertEquals(SyncRunState.Mark.FAILED, screen.shown().marks["sleep"])
        assertFalse(screen.shown().running)
    }

    /** The two one-shot answers reach the screen that is up, once each. */
    @Test
    fun `expiry and a failure reach the screen that is up`() {
        val state = SyncRunState()
        val screen = Fake().also { state.attach(it) }
        state.begin(setOf("steps"))
        val boom = IllegalStateException("boom")

        state.failed(boom)
        state.expired()

        assertEquals(listOf(boom), screen.failures)
        assertEquals(1, screen.expiries)
    }

    /**
     * The same two answers with nobody attached: a run that outlives the screen can meet a 401 or
     * throw while the app is in the background, and neither may throw on its way out.
     */
    @Test
    fun `a run with no screen attached ends quietly`() {
        val state = SyncRunState()
        state.begin(setOf("steps"))

        state.expired()
        state.failed(IllegalStateException("boom"))
        state.finish()

        assertFalse(state.status().running)
        assertTrue(
            "a type the run never reached carries no mark at all",
            state.status().marks.isEmpty(),
        )
    }

    /** What a card's bar counts as done: an answer, and not a type the run is still carrying. */
    @Test
    fun `only an answer counts as done`() {
        assertTrue(SyncRunState.Mark.SENT.answered)
        assertTrue(SyncRunState.Mark.EMPTY.answered)
        assertTrue(SyncRunState.Mark.FAILED.answered)
        assertFalse(SyncRunState.Mark.RUNNING.answered)
        assertFalse(SyncRunState.Mark.IDLE.answered)
    }
}
