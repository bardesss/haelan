package com.haelan.android

import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.metadata.Metadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset

class HeartRateFirstMinuteTest {

    private fun pointsAt(vararg times: String) = SyncEngine.toHeartRatePoints(
        listOf(
            HeartRateRecord(
                Instant.parse(times.first()),
                ZoneOffset.ofHours(2),
                Instant.parse(times.last()).plusSeconds(1),
                ZoneOffset.ofHours(2),
                times.map { HeartRateRecord.Sample(Instant.parse(it), 60L) },
                Metadata.unknownRecordingMethodWithId("hc-hr-1"),
            ),
        ),
    )

    private fun timesOf(points: List<org.json.JSONObject>) =
        points.map { it.getJSONObject("heartRate").getJSONObject("sampleTime").getString("physicalTime") }

    @Test
    fun `the points in the window's first minute are dropped`() {
        val points = pointsAt("2026-08-18T10:00:30Z", "2026-08-18T10:00:59Z", "2026-08-18T10:01:00Z")
        val kept = SyncEngine.dropMinuteOf(points, Instant.parse("2026-08-18T10:00:17Z"))
        assertEquals(listOf("2026-08-18T10:01:00Z"), timesOf(kept))
    }

    @Test
    fun `no window start keeps every point`() {
        val points = pointsAt("2026-08-18T10:00:30Z", "2026-08-18T10:00:59Z", "2026-08-18T10:01:00Z")
        assertEquals(points, SyncEngine.dropMinuteOf(points, null))
    }

    private val cursor = Instant.parse("2026-08-18T09:00:00Z").toEpochMilli()

    @Test
    fun `a window for an instance that holds nothing of the type has no partial minute`() {
        assertNull(SyncEngine.partialMinuteStart(Instant.parse("2026-07-19T10:00:17Z"), null))
    }

    @Test
    fun `a window for an instance that already holds the type has a partial first minute`() {
        val start = Instant.parse("2026-07-19T10:00:17Z").plus(Duration.ofDays(1))
        assertEquals(start, SyncEngine.partialMinuteStart(start, cursor))
    }

    @Test
    fun `without the history permission a window at the fallback start has a partial first minute`() {
        // Without the permission every bootstrap starts at the fallback, thirty days back, and
        // the instance holds the minutes there whole from an earlier run whose fallback was older.
        val fallback = Instant.parse("2026-07-19T10:00:17Z")
        assertEquals(fallback, SyncEngine.partialMinuteStart(fallback, cursor))
    }

    @Test
    fun `a window that starts on a minute boundary has a whole first minute`() {
        assertNull(SyncEngine.partialMinuteStart(Instant.parse("2026-07-20T10:01:00Z"), cursor))
    }
}
