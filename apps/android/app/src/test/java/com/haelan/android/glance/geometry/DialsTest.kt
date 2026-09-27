package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.baseline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DialsTest {

    private val delta = 1e-4f

    @Test
    fun `the arc runs two and a half half-widths either side of the centre`() {
        // 50 to 60 around 55: half-width 5, the arc from 42.5 to 67.5, the band 0.3 to 0.7 of it.
        val gauge = gaugeLayout(55.0, baseline(50.0, 60.0, center = 55.0), GlanceStanding.WITHIN)
        assertEquals(42.5, gauge.min, 1e-9)
        assertEquals(67.5, gauge.max, 1e-9)
        val band = checkNotNull(gauge.band)
        assertEquals(234f, band.startDegrees, delta)
        assertEquals(72f, band.sweepDegrees, delta)
        assertEquals(270f, band.markerDegrees, delta)
        assertFalse(gauge.outside)
    }

    @Test
    fun `a zero-width band still gets an arc, 10 percent of the centre`() {
        val gauge = gaugeLayout(55.0, baseline(50.0, 50.0, center = 50.0), GlanceStanding.ABOVE)
        // Half-width 5: from 37.5 to 62.5, the band a point at noon, 55 to the right of it.
        assertEquals(37.5, gauge.min, 1e-9)
        assertEquals(62.5, gauge.max, 1e-9)
        val band = checkNotNull(gauge.band)
        assertEquals(270f, band.startDegrees, delta)
        assertEquals(0f, band.sweepDegrees, delta)
        assertEquals(306f, band.markerDegrees, delta)
    }

    @Test
    fun `a zero-width band near zero falls back to a half-width of 1`() {
        val gauge = gaugeLayout(2.0, baseline(3.0, 3.0, center = 3.0), GlanceStanding.BELOW)
        assertEquals(0.5, gauge.min, 1e-9)
        assertEquals(5.5, gauge.max, 1e-9)
    }

    @Test
    fun `the marker stops at the arc's ends`() {
        val gauge = gaugeLayout(500.0, baseline(50.0, 60.0, center = 55.0), GlanceStanding.ABOVE)
        assertEquals(360f, checkNotNull(gauge.band).markerDegrees, delta)
    }

    @Test
    fun `outside is the server's standing, wherever the marker sits`() {
        val inside = baseline(50.0, 60.0, center = 55.0)
        assertTrue(gaugeLayout(55.0, inside, GlanceStanding.ABOVE).outside)
        assertTrue(gaugeLayout(55.0, inside, GlanceStanding.BELOW).outside)
        assertFalse(gaugeLayout(90.0, inside, GlanceStanding.WITHIN).outside)
        assertFalse(gaugeLayout(90.0, inside, null).outside)
    }

    @Test
    fun `no band and no marker without a usual, or with a thin one`() {
        assertNull(gaugeLayout(55.0, null, null).band)
        assertNull(gaugeLayout(55.0, baseline(50.0, 60.0, thin = true), GlanceStanding.ABOVE).band)
    }

    @Test
    fun `the ring fills its share of 100 from noon`() {
        assertEquals(RingSweep(-90f, 223.2f), ringSweep(62.0))
        assertEquals(RingSweep(-90f, 360f), ringSweep(100.0))
        assertNull(ringSweep(null))
    }
}
