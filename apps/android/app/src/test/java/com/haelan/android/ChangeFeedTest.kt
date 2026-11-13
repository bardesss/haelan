package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

class ChangeFeedTest {

    private val end: Instant = Instant.parse("2026-09-14T12:00:00Z")
    private val history: Instant = Instant.EPOCH

    private fun daysBefore(days: Long): Long = end.minus(days, ChronoUnit.DAYS).toEpochMilli()

    @Test
    fun `a token is drained when the instance holds the type`() =
        assertEquals(
            ChangeFeed.Mode.Drain("t1"),
            ChangeFeed.modeFor(ChangeFeed.Saved("t1", daysBefore(2)), daysBefore(1), history, end),
        )

    @Test
    fun `a token is not trusted for a type the instance has never seen`() =
        assertEquals(
            ChangeFeed.Mode.Bootstrap(history),
            ChangeFeed.modeFor(ChangeFeed.Saved("t1", daysBefore(2)), null, history, end),
        )

    @Test
    fun `a token is not trusted once the instance went back behind the cursor it was saved with`() =
        assertEquals(
            ChangeFeed.Mode.Bootstrap(end.minus(30, ChronoUnit.DAYS)),
            ChangeFeed.modeFor(ChangeFeed.Saved("t1", daysBefore(2)), daysBefore(9), history, end),
        )

    @Test
    fun `a token saved with the same cursor the instance holds now is still drained`() =
        assertEquals(
            ChangeFeed.Mode.Drain("t1"),
            ChangeFeed.modeFor(ChangeFeed.Saved("t1", daysBefore(2)), daysBefore(2), history, end),
        )

    @Test
    fun `a token saved before its cursor was kept beside it is trusted as before`() =
        assertEquals(
            ChangeFeed.Mode.Drain("t1"),
            ChangeFeed.modeFor(ChangeFeed.Saved("t1", null), daysBefore(9), history, end),
        )

    @Test
    fun `no token with a recent cursor reads the last thirty days, not the whole history`() =
        assertEquals(
            ChangeFeed.Mode.Bootstrap(end.minus(30, ChronoUnit.DAYS)),
            ChangeFeed.modeFor(null, daysBefore(2), history, end),
        )

    @Test
    fun `no token with a cursor older than thirty days reads from the cursor, so the gap is not skipped`() =
        assertEquals(
            ChangeFeed.Mode.Bootstrap(Instant.ofEpochMilli(daysBefore(60) - SyncCursors.OVERLAP_MS)),
            ChangeFeed.modeFor(null, daysBefore(60), history, end),
        )

    @Test
    fun `an expired token reads the permission's whole window, not the last thirty days`() =
        assertEquals(ChangeFeed.Mode.Bootstrap(history), ChangeFeed.fallbackAfterExpiry(history))

    @Test
    fun `tokens are kept per owner and type`() =
        assertNotEquals(ChangeFeed.keyFor("a|p1", "weight"), ChangeFeed.keyFor("a|p2", "weight"))

    @Test
    fun `the cursor a token was saved with is kept under its own key, per owner and type`() {
        assertNotEquals(ChangeFeed.keyFor("a|p1", "weight"), ChangeFeed.cursorKeyFor("a|p1", "weight"))
        assertNotEquals(ChangeFeed.cursorKeyFor("a|p1", "weight"), ChangeFeed.cursorKeyFor("a|p2", "weight"))
    }

    private fun upsert(id: String) = ChangeFeed.Change(id, deleted = false)
    private fun delete(id: String) = ChangeFeed.Change(id, deleted = true)

    @Test
    fun `a record written and then deleted in one drain is deleted`() =
        assertEquals(listOf("a"), ChangeFeed.deletionsAfter(emptyList(), listOf(upsert("a"), delete("a"))))

    @Test
    fun `a record deleted and then restored in one drain is kept, and no deletion is posted for it`() =
        assertEquals(emptyList<String>(), ChangeFeed.deletionsAfter(emptyList(), listOf(delete("a"), upsert("a"))))

    @Test
    fun `a record only deleted is deleted`() =
        assertEquals(listOf("a"), ChangeFeed.deletionsAfter(emptyList(), listOf(delete("a"), upsert("b"))))

    @Test
    fun `a restore on a later page undoes a deletion from an earlier page`() {
        val first = ChangeFeed.deletionsAfter(emptyList(), listOf(delete("a"), delete("b")))
        assertEquals(listOf("b"), ChangeFeed.deletionsAfter(first, listOf(upsert("a"))))
    }

    @Test
    fun `a deletion on a later page of a record written earlier still deletes it`() {
        val first = ChangeFeed.deletionsAfter(emptyList(), listOf(upsert("a")))
        assertEquals(listOf("a"), ChangeFeed.deletionsAfter(first, listOf(delete("a"))))
    }
}
