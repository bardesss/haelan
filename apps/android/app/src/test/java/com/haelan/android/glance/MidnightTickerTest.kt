package com.haelan.android.glance

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The midnight wait follows the wall clock. The fake delay counts uptime: it moves the wall clock by
 * what it was asked to wait, and once, when the phone is set to sleep, by the whole sleep on top,
 * as a Handler delay spanning deep sleep does.
 */
class MidnightTickerTest {

    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private fun at(instant: String) = Instant.parse(instant).toEpochMilli()

    private var wallMs = at("2026-09-27T21:00:00Z") // 23:00 in Amsterdam
    private var sleepAtMs: Long? = null
    private var sleepMs = 0L
    private val waits = mutableListOf<Long>()

    private val ticker = MidnightTicker(clock = { wallMs }, delay = { ms ->
        waits += ms
        val sleepAt = sleepAtMs
        wallMs += ms
        if (sleepAt != null && wallMs >= sleepAt) {
            wallMs += sleepMs
            sleepAtMs = null
        }
    })

    private class Stop : CancellationException("stop")

    /** Runs the ticker until its first fire, and answers the wall clock it fired at. */
    private fun firstFire(): Long {
        var firedAt = -1L
        runBlocking {
            try {
                ticker.run(amsterdam) {
                    firedAt = wallMs
                    throw Stop()
                }
            } catch (e: Stop) {
                // The first fire is all the test wants.
            }
        }
        return firedAt
    }

    @Test
    fun `no single wait is longer than a slice`() {
        val firedAt = firstFire()
        assertEquals(at("2026-09-27T22:00:00Z"), firedAt)
        assertTrue(waits.all { it <= MidnightTicker.SLICE_MS })
    }

    @Test
    fun `a sleep that stops uptime still fires within a slice of waking past midnight`() {
        // Asleep from 23:30 until 09:30 the next morning; one uptime-counted wait of an hour would
        // end at 10:00, half an hour of "Log for today" on yesterday.
        sleepAtMs = at("2026-09-27T21:30:00Z")
        sleepMs = 10 * 3_600_000L
        val wokeAt = at("2026-09-28T07:30:00Z")
        val firedAt = firstFire()
        assertTrue("fired at ${Instant.ofEpochMilli(firedAt)}", firedAt in wokeAt..wokeAt + MidnightTicker.SLICE_MS)
    }

    @Test
    fun `a midnight that passed while the wait was cancelled fires at once when it runs again`() {
        // The first run is cancelled mid-wait, as the screen going to the background does ...
        var slices = 0
        val cancelling = MidnightTicker(clock = { wallMs }, delay = { ms ->
            waits += ms
            wallMs += ms
            if (++slices == 3) throw Stop()
        })
        runBlocking {
            try {
                cancelling.run(amsterdam) { error("fired before midnight") }
            } catch (e: Stop) {
                // Cancelled.
            }
        }
        // ... the phone sleeps through midnight, and the screen comes back at 07:00 and runs it again.
        wallMs = at("2026-09-28T05:00:00Z")
        waits.clear()
        var firedAt = -1L
        runBlocking {
            try {
                cancelling.run(amsterdam) {
                    firedAt = wallMs
                    throw Stop()
                }
            } catch (e: Stop) {
                // First fire only.
            }
        }
        assertEquals(at("2026-09-28T05:00:00Z"), firedAt)
        assertEquals(emptyList<Long>(), waits)
    }

    @Test
    fun `the + goes at the tick, before the new day is asked for`() {
        val confirmed = GlanceUiState(
            shownDay = null, glance = null, fetchedAtMs = wallMs, reachable = true, loading = false,
            problem = null, confirmed = true,
        )
        var nowAtFire = -1L
        runBlocking {
            try {
                ticker.run(amsterdam) {
                    nowAtFire = ticker.now.value
                    throw Stop()
                }
            } catch (e: Stop) {
                // First fire only.
            }
        }
        assertEquals(at("2026-09-27T22:00:00Z"), nowAtFire)
        assertFalse(confirmedNow(confirmed, ticker.now.value, amsterdam))
    }
}
