package com.haelan.android

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Resting heart rate is the one daily figure Health Connect computes itself, so it crosses as
 * the reading the device took and not as a mean of readings (A-04). The mean would be this
 * app's own definition of the day, and nothing compares it with Google's.
 *
 * The daily type holds one row per day per source, so two readings landing on the same local
 * day keep the later one instead of letting upload order decide which day the dashboard sees.
 */
object DailyRestingHeartRate {

    data class Reading(val at: Instant, val zoneOffset: ZoneOffset?, val beatsPerMinute: Long)

    data class Daily(val date: LocalDate, val beatsPerMinute: Long)

    fun daily(readings: List<Reading>): List<Daily> =
        readings
            // atZone().toLocalDate() rather than LocalDate.ofInstant: the latter only exists
            // from API 34, and the app runs from 26.
            .groupBy { it.at.atZone(it.zoneOffset ?: ZoneOffset.UTC).toLocalDate() }
            .map { (date, sameDay) -> Daily(date, sameDay.maxBy { it.at }.beatsPerMinute) }
            .sortedBy { it.date }
}
