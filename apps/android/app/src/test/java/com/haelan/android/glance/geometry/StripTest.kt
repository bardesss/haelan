package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.baseline
import com.haelan.android.glance.stripDay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The seven-day strip's shape. Values and bands are picked on round numbers so every coordinate is
 * one a reader can check by hand: a 70 wide plot is 10 per day, and a 0 to 100 extent over a 100
 * high plot puts a value at y = 100 - value.
 */
class StripTest {

    private val usual = baseline(low = 40.0, high = 60.0)

    // Seven days, 0 to 100 across them so the extent is exactly that.
    private val week = listOf(
        stripDay("2026-08-14", 0.0, usual, GlanceStanding.BELOW),
        stripDay("2026-08-15", 50.0, usual, GlanceStanding.WITHIN),
        stripDay("2026-08-16", null, usual),
        stripDay("2026-08-17", 55.0, baseline(40.0, 60.0, thin = true)),
        stripDay("2026-08-18", 45.0, null),
        stripDay("2026-08-19", 100.0, usual, GlanceStanding.ABOVE),
        stripDay("2026-08-20", 50.0, usual, GlanceStanding.WITHIN),
    )

    private val layout = checkNotNull(stripLayout(week, usual, width = 70f, height = 100f))

    @Test
    fun `a dot per day with a value, on its slot's centre`() {
        assertEquals(listOf(0, 1, 3, 4, 5, 6), layout.dots.map { it.index })
        assertEquals(StripDot(1, 15f, 50f, DotRole.NORMAL, large = false), layout.dots[1])
        assertEquals(StripDot(0, 5f, 100f, DotRole.OUTSIDE, large = false), layout.dots[0])
    }

    @Test
    fun `the latest day is larger, and outside its usual it keeps the warning colour`() {
        assertEquals(StripDot(6, 65f, 50f, DotRole.LATEST, large = true), layout.dots.last())
        val outsideLatest = week.dropLast(1)
        val dots = checkNotNull(stripLayout(outsideLatest, usual, 60f, 100f)).dots
        assertEquals(StripDot(5, 55f, 0f, DotRole.OUTSIDE, large = true), dots.last())
    }

    @Test
    fun `a dot's role is its day's standing, not where its value sits`() {
        // Day 4's 45 is inside 40-60 and day 3's 55 is too; neither is judged here. Mark day 4 above.
        val judged = week.toMutableList().also { it[4] = it[4].copy(standing = GlanceStanding.ABOVE) }
        val dots = checkNotNull(stripLayout(judged, usual, 70f, 100f)).dots
        assertEquals(DotRole.OUTSIDE, dots.single { it.index == 4 }.role)
        assertEquals(DotRole.NORMAL, dots.single { it.index == 3 }.role)
    }

    @Test
    fun `a null middle day breaks the line`() {
        assertEquals(
            listOf(
                listOf(StripPoint(5f, 100f), StripPoint(15f, 50f)),
                listOf(StripPoint(35f, 45f), StripPoint(45f, 55f), StripPoint(55f, 0f), StripPoint(65f, 50f)),
            ),
            layout.lines,
        )
    }

    @Test
    fun `a band step per day with its own usual, none on a thin or missing one`() {
        assertEquals(listOf(0, 1, 2, 5, 6), layout.bands.map { it.index })
        assertEquals(StripBand(1, 10f, 20f, top = 40f, bottom = 60f), layout.bands[1])
    }

    @Test
    fun `the thin day draws no band even with its low and high set`() {
        assertNull(layout.bands.firstOrNull { it.index == 3 })
    }

    @Test
    fun `the labels are the figure's own usual, at the first slot`() {
        assertEquals(StripBandLabels(low = 40.0, high = 60.0, lowY = 60f, highY = 40f, x = 5f), layout.labels)
    }

    @Test
    fun `a thin usual is not labelled`() {
        assertNull(checkNotNull(stripLayout(week, baseline(40.0, 60.0, thin = true), 70f, 100f)).labels)
        assertNull(checkNotNull(stripLayout(week, null, 70f, 100f)).labels)
    }

    @Test
    fun `the extent widens to a band edge no value reaches`() {
        val days = listOf(stripDay("a", 50.0, baseline(40.0, 200.0)), stripDay("b", 100.0))
        val strip = checkNotNull(stripLayout(days, null, 20f, 160f))
        // 40 to 200 over 160: 50 sits at 150, the band's top at 0.
        assertEquals(150f, strip.dots[0].y)
        assertEquals(0f, strip.bands[0].top)
    }

    @Test
    fun `no strip with only one day valued`() {
        val one = listOf(stripDay("a", null), stripDay("b", 5.0), stripDay("c", null))
        assertNull(stripLayout(one, usual, 30f, 10f))
        assertNotNull(stripLayout(one + stripDay("d", 6.0), usual, 40f, 10f))
    }

    @Test
    fun `two equal values still get a height to sit in`() {
        val flat = checkNotNull(stripLayout(listOf(stripDay("a", 5.0), stripDay("b", 5.0)), null, 20f, 10f))
        assertEquals(5f, flat.dots[0].y)
    }
}
