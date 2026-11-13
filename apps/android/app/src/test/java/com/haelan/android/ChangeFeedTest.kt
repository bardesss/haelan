package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

class ChangeFeedTest {

    private val end: Instant = Instant.parse("2026-09-14T12:00:00Z")
    private val history: Instant = Instant.EPOCH

    @Test
    fun `a token is drained when the instance holds the type`() =
        assertEquals(ChangeFeed.Mode.Drain("t1"), ChangeFeed.modeFor("t1", 5L, history, end))

    @Test
    fun `a token is not trusted for a type the instance has never seen`() =
        assertEquals(ChangeFeed.Mode.Bootstrap(history), ChangeFeed.modeFor("t1", null, history, end))

    @Test
    fun `no token with a cursor reads the last thirty days, not the whole history`() =
        assertEquals(
            ChangeFeed.Mode.Bootstrap(end.minus(30, ChronoUnit.DAYS)),
            ChangeFeed.modeFor(null, 5L, history, end),
        )

    @Test
    fun `an expired token reads the permission's whole window, not the last thirty days`() =
        assertEquals(ChangeFeed.Mode.Bootstrap(history), ChangeFeed.fallbackAfterExpiry(history))

    @Test
    fun `tokens are kept per owner and type`() =
        assertNotEquals(ChangeFeed.keyFor("a|p1", "weight"), ChangeFeed.keyFor("a|p2", "weight"))
}
