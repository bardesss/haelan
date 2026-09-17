package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The timestamps T5.2 shows per row, pinned where a JVM test can reach them: the keys the
 * screen and the worker share, and the day count that says a gap is a gap.
 */
class SyncStatusTest {

    @Test
    fun `each toggle keeps its own timestamp under its own key`() {
        assertEquals("last_sync_steps", SyncStatus.lastKey("steps"))
        assertEquals("last_sync_sleep", SyncStatus.lastKey("sleep"))
    }

    @Test
    fun `the empty flag lives beside the timestamp and never on a toggle key`() {
        assertEquals("last_sync_empty_steps", SyncStatus.emptyKey("steps"))
        for (key in SyncTypes.KEYS) {
            assertFalse(SyncStatus.lastKey(key) == "sync_$key")
            assertFalse(SyncStatus.emptyKey(key) == "sync_$key")
            assertFalse(SyncStatus.lastKey(key) == SyncStatus.emptyKey(key))
        }
    }

    @Test
    fun `the day count is whole days with no partial day rounded up`() {
        val now = 1_756_000_000_000L
        val day = 24L * 60L * 60L * 1000L
        assertEquals(0L, SyncStatus.daysSince(now, now))
        assertEquals(0L, SyncStatus.daysSince(now - (day - 1), now))
        assertEquals(1L, SyncStatus.daysSince(now - day, now))
        assertEquals(2L, SyncStatus.daysSince(now - (2 * day + 1), now))
    }

    @Test
    fun `a clock that moved backwards is not a gap`() {
        assertEquals(0L, SyncStatus.daysSince(2000L, 1000L))
    }

    @Test
    fun `never synced is stale and today is not`() {
        val now = 1_756_000_000_000L
        assertTrue(SyncStatus.isStale(null, now))
        assertTrue(SyncStatus.isStale(0L, now))
        assertFalse(SyncStatus.isStale(now, now))
    }

    @Test
    fun `a run from yesterday is stale and one from an hour ago is not`() {
        val now = 1_756_000_000_000L
        val day = 24L * 60L * 60L * 1000L
        assertTrue(SyncStatus.isStale(now - day, now))
        assertFalse(SyncStatus.isStale(now - 60L * 60L * 1000L, now))
    }

    @Test
    fun `the absolute time names day month and hour`() {
        val zone = java.time.ZoneId.of("Europe/Rome")
        val at = java.time.Instant.parse("2026-09-14T10:00:00Z").toEpochMilli()
        assertEquals("14 Sep 12:00", SyncStatus.formatAt(at, zone))
    }
}
