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

    @Test
    fun `a window at the oldest readable instant has no partial minute`() {
        val fallback = Instant.parse("2026-07-19T10:00:17Z")
        assertNull(SyncEngine.partialMinuteStart(fallback, fallback))
    }

    @Test
    fun `a window that starts later than what can be read has a partial first minute`() {
        val fallback = Instant.parse("2026-07-19T10:00:17Z")
        val start = fallback.plus(Duration.ofDays(1))
        assertEquals(start, SyncEngine.partialMinuteStart(start, fallback))
    }

    @Test
    fun `a window that starts on a minute boundary has a whole first minute`() {
        val fallback = Instant.parse("2026-07-19T10:00:17Z")
        assertNull(SyncEngine.partialMinuteStart(Instant.parse("2026-07-20T10:01:00Z"), fallback))
    }
}
