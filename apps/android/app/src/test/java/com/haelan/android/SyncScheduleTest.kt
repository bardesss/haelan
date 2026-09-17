package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The background cadence T5.1 promises, pinned where a JVM test can reach it: [SyncSchedule]
 * is the only place the interval, the network requirement and the backoff are decided, so a
 * change to any of the three fails here instead of silently moving the sync.
 */
class SyncScheduleTest {

    @Test
    fun `the background sync goes twice a day`() {
        assertEquals(12L, SyncSchedule.policy().repeatHours)
    }

    @Test
    fun `the background sync waits for a network instead of failing without one`() {
        assertTrue(SyncSchedule.policy().requiresNetwork)
    }

    @Test
    fun `a failed background sync backs off patiently rather than hammering`() {
        assertEquals(10L, SyncSchedule.policy().backoffMinutes)
    }

    @Test
    fun `the work has one name, so every start keeps the same schedule`() {
        assertEquals("haelan-background-sync", SyncSchedule.UNIQUE_NAME)
    }
}
