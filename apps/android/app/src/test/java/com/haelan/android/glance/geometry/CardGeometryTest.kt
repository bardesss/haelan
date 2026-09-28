package com.haelan.android.glance.geometry

import com.haelan.android.glance.baseline
import com.haelan.android.glance.stripDay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The small rules the cards place their charts by: when a strip shows, the trace's window, the dials' sizes. */
class CardGeometryTest {

    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun `a strip shows from two valued days, and one dot is not a strip`() {
        assertFalse(showsStrip(listOf(stripDay("2026-08-19", null), stripDay("2026-08-20", 5.0))))
        assertTrue(showsStrip(listOf(stripDay("2026-08-18", 4.0), stripDay("2026-08-19", null), stripDay("2026-08-20", 5.0))))
        assertFalse(showsStrip(emptyList()))
    }

    @Test
    fun `a thin usual is neither shaded nor labelled`() {
        assertNull(stripUsual(baseline(1.0, 2.0, thin = true)))
        assertNull(stripUsual(null))
        assertEquals(baseline(1.0, 2.0), stripUsual(baseline(1.0, 2.0)))
    }

    @Test
    fun `today's trace runs from local midnight to the last reading`() {
        assertEquals(TraceWindow(ms("2026-08-19T22:00:00Z"), null), traceWindow("2026-08-20", finished = false, zone = amsterdam))
    }

    @Test
    fun `a finished day's trace runs to the next local midnight, however long the day was`() {
        assertEquals(
            TraceWindow(ms("2026-08-19T22:00:00Z"), ms("2026-08-20T22:00:00Z")),
            traceWindow("2026-08-20", finished = true, zone = amsterdam),
        )
        // The clocks go back on 25 October 2026: that day is 25 hours long.
        val autumn = traceWindow("2026-10-25", finished = true, zone = amsterdam)
        assertEquals(25 * 3_600_000L, autumn.endMs!! - autumn.startMs)
    }

    @Test
    fun `the three dials fit a 360dp phone's card and keep the web's sizes on a wider one`() {
        val narrow = dialSizes(296f)
        assertEquals(1f, narrow.gaugeShare * 2 + narrow.ringShare, 1e-6f)
        assertTrue(narrow.gauge <= 296f * narrow.gaugeShare - DIAL_GAP)
        assertTrue(narrow.ring <= 296f * narrow.ringShare - DIAL_GAP)
        assertTrue("a gauge shrank below its share", narrow.gauge > 80f)
        val wide = dialSizes(400f)
        assertEquals(96f, wide.gauge)
        assertEquals(112f, wide.ring)
    }
}
