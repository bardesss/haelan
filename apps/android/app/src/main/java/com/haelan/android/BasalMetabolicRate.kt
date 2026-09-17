package com.haelan.android

import androidx.health.connect.client.units.Power
import java.time.Instant
import java.time.ZoneOffset

/**
 * The fifth type A-03 invented, kept because T0.4 found a record behind it:
 * `BasalMetabolicRateRecord`, one per day, `AUTOMATICALLY_RECORDED`. The generator is not back,
 * and the difference is the whole point of the measurement: this reads a figure the device
 * computed instead of rolling dice for one.
 *
 * Health Connect files the reading as a power at an instant, while v4 files the same type as an
 * energy over an interval. The library's [Power] carries the rate twice, in watts and in
 * kilocalories per day, and only one of the two is the reading: the day figure Health Connect
 * shows, and the unit the catalogue declares for `basal-energy-burned`. The choice lives here,
 * where a JVM test can hold it, rather than at the call site where either getter compiles.
 */
object BasalMetabolicRate {

    data class Reading(val time: Instant, val zoneOffset: ZoneOffset?, val rate: Power)

    /**
     * The clock is the reading's own instant and the interval is empty, because an instantaneous
     * record has no duration to report: inventing a day-long interval here would be this app
     * deciding where a day starts, which is exactly the derivation the phone no longer does.
     */
    data class Point(val time: Instant, val zoneOffset: ZoneOffset?, val kcal: Double)

    fun points(readings: List<Reading>): List<Point> =
        readings.map { Point(it.time, it.zoneOffset, it.rate.inKilocaloriesPerDay) }
}
