package com.haelan.android

import androidx.work.ExistingPeriodicWorkPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The background cadence, pinned where a JVM test can reach it: [SyncSchedule]
 * is the only place the interval, the network requirement and the backoff are decided, so a
 * change to any of the three fails here instead of silently moving the sync.
 */
class SyncScheduleTest {

    @Test
    fun `the background sync goes every two hours`() {
        // Twelve was right for data that goes stale by the day and wrong for a workout: somebody
        // who has just finished a run wants to see it, and half a day is not an answer. A run with
        // nothing new costs a delta read that finds nothing, because the cursor says where to
        // start.
        assertEquals(2L, SyncSchedule.policy().repeatHours)
    }

    @Test
    fun `the background sync is not the fifteen minute floor WorkManager allows`() {
        // Health Connect gives third parties no push, so this is polling. Polling six times an
        // hour to catch something that happens twice a week spends the battery on the three
        // hundred and thirty runs that find nothing. The manual button and the sync on open cover
        // the moment somebody actually cares.
        assertTrue(SyncSchedule.policy().repeatHours >= 1L)
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

    /**
     * KEEP was right within one version and wrong across two: it keeps whatever the first install
     * enqueued, so a release that changes the interval or the backoff reaches nobody who already
     * has the app. With Obtainium updating over the top rather than reinstalling, that install
     * would keep the old schedule for the life of the phone.
     */
    @Test
    fun `an update replaces the schedule the previous version asked for`() {
        assertEquals(ExistingPeriodicWorkPolicy.UPDATE, SyncSchedule.ENQUEUE_POLICY)
    }

    /** The one name is spelled by the worker, so a rename cannot leave two schedules behind. */
    @Test
    fun `the name and the tag the worker carries are the same string`() {
        assertEquals(SyncWorker.PERIODIC_WORK_NAME, SyncSchedule.UNIQUE_NAME)
    }
}
