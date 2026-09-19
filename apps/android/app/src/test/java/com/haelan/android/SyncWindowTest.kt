package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * The window is the permission's own rule, so what is asserted here is the rule and not a
 * preference: 30 days without the history permission, the entire history with it.
 */
class SyncWindowTest {

    private val end: Instant = Instant.parse("2026-09-14T12:00:00Z")

    @Test
    fun `without the history permission the window is the thirty days the provider will answer`() {
        assertEquals(end.minus(30, ChronoUnit.DAYS), SyncWindow.forHistoryGranted(false, end))
    }

    @Test
    fun `with the history permission the window reaches back past anything the phone holds`() {
        val start = SyncWindow.forHistoryGranted(true, end)

        assertEquals(Instant.EPOCH, start)
        // The claim, in the terms the permission states it: no reading this phone can hold is
        // older than the window, so nothing is left out by the window itself.
        assertTrue(start.isBefore(end.minus(3650, ChronoUnit.DAYS)))
    }
}
