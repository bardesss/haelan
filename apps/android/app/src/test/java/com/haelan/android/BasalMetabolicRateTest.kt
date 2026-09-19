package com.haelan.android

import androidx.health.connect.client.units.Power
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/**
 * What is proven rather than asserted here: the figure crosses in the unit the
 * catalogue declares. Health Connect's Power carries the same rate twice, so a mapping that read
 * the wrong getter would still compile and still look like a number.
 */
class BasalMetabolicRateTest {

    private val at = Instant.parse("2026-03-08T03:00:00Z")

    private fun reading(rate: Power) = BasalMetabolicRate.Reading(at, ZoneOffset.ofHours(1), rate)

    @Test
    fun theDaysFigureCrossesInKilocaloriesAndNotInWatts() {
        val rate = Power.kilocaloriesPerDay(1650.0)

        // The other getter on the same object: 1650 kcal a day is about 80 W, so a mapping that
        // read watts would send a number 20 times too small and nothing would refuse it.
        assertEquals(79.9, rate.inWatts, 0.1)

        val point = BasalMetabolicRate.points(listOf(reading(rate))).single()
        assertEquals(1650.0, point.kcal, 1e-9)
    }

    @Test
    fun theReadingKeepsItsOwnInstantAndOffset() {
        val point = BasalMetabolicRate.points(listOf(reading(Power.kilocaloriesPerDay(1500.0)))).single()

        assertEquals(at, point.time)
        assertEquals(1, point.zoneOffset?.totalSeconds?.div(3600))
    }

    @Test
    fun aReadingTheDeviceFiledWithNoOffsetStillCrosses() {
        val noOffset = BasalMetabolicRate.Reading(at, null, Power.kilocaloriesPerDay(1500.0))

        val point = BasalMetabolicRate.points(listOf(noOffset)).single()

        assertEquals(null, point.zoneOffset)
        assertEquals(1500.0, point.kcal, 1e-9)
    }

    @Test
    fun nothingReadMeansNothingSent() {
        assertEquals(emptyList<BasalMetabolicRate.Point>(), BasalMetabolicRate.points(emptyList()))
    }
}
