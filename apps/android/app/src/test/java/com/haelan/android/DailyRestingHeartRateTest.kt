package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class DailyRestingHeartRateTest {

    private fun reading(instant: String, offsetHours: Int, beatsPerMinute: Long) =
        DailyRestingHeartRate.Reading(
            Instant.parse(instant),
            ZoneOffset.ofHours(offsetHours),
            beatsPerMinute,
        )

    @Test
    fun oneReadingPerDayCrossesAsItWasRead() {
        val daily = DailyRestingHeartRate.daily(
            listOf(
                reading("2026-03-01T06:00:00Z", 1, 54L),
                reading("2026-03-02T06:00:00Z", 1, 52L),
            ),
        )

        assertEquals(
            listOf(LocalDate.of(2026, 3, 1) to 54L, LocalDate.of(2026, 3, 2) to 52L),
            daily.map { it.date to it.beatsPerMinute },
        )
    }

    @Test
    fun twoReadingsInADayKeepTheLaterOneRatherThanTheirMean() {
        val daily = DailyRestingHeartRate.daily(
            listOf(
                reading("2026-03-01T06:00:00Z", 1, 50L),
                reading("2026-03-01T20:00:00Z", 1, 60L),
            ),
        )

        assertEquals(1, daily.size)
        // 55 would be the average, and the average is what this stopped doing.
        assertEquals(60L, daily.single().beatsPerMinute)
    }

    @Test
    fun theLocalDayComesFromTheReadingOwnOffset() {
        // 23:30 UTC on 1 March is already 2 March at +02:00.
        val daily = DailyRestingHeartRate.daily(listOf(reading("2026-03-01T23:30:00Z", 2, 51L)))

        assertEquals(LocalDate.of(2026, 3, 2), daily.single().date)
    }

    @Test
    fun aReadingWithNoOffsetIsFiledUnderUtcRatherThanDropped() {
        val daily = DailyRestingHeartRate.daily(
            listOf(DailyRestingHeartRate.Reading(Instant.parse("2026-03-01T23:30:00Z"), null, 51L)),
        )

        assertEquals(LocalDate.of(2026, 3, 1), daily.single().date)
        assertEquals(51L, daily.single().beatsPerMinute)
    }

    @Test
    fun theDaysComeOutInOrderWhicheverOrderTheyWereRead() {
        val daily = DailyRestingHeartRate.daily(
            listOf(
                reading("2026-03-03T06:00:00Z", 0, 50L),
                reading("2026-03-01T06:00:00Z", 0, 52L),
                reading("2026-03-02T06:00:00Z", 0, 51L),
            ),
        )

        assertEquals(
            listOf(LocalDate.of(2026, 3, 1), LocalDate.of(2026, 3, 2), LocalDate.of(2026, 3, 3)),
            daily.map { it.date },
        )
    }

    @Test
    fun nothingReadMeansNothingSent() {
        assertEquals(emptyList<DailyRestingHeartRate.Daily>(), DailyRestingHeartRate.daily(emptyList()))
    }
}
