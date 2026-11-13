package com.haelan.android

import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Mass
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class SamplePointNameTest {

    @Test
    fun `a weight point carries its record id beside the payload`() {
        val record = WeightRecord(
            Instant.parse("2026-08-18T07:00:00Z"),
            ZoneOffset.ofHours(2),
            Mass.kilograms(80.0),
            Metadata.unknownRecordingMethodWithId("hc-weight-1"),
        )
        val point = SyncEngine.toWeightPoints(listOf(record)).single()
        assertEquals("hc-weight-1", point.getString("name"))
        assertFalse(point.getJSONObject("weight").has("name"))
    }

    @Test
    fun `every heart rate sample carries its parent record id`() {
        val start = Instant.parse("2026-08-18T07:00:00Z")
        val record = HeartRateRecord(
            start,
            ZoneOffset.ofHours(2),
            start.plusSeconds(120),
            ZoneOffset.ofHours(2),
            listOf(
                HeartRateRecord.Sample(start, 60L),
                HeartRateRecord.Sample(start.plusSeconds(60), 62L),
            ),
            Metadata.unknownRecordingMethodWithId("hc-hr-1"),
        )
        val points = SyncEngine.toHeartRatePoints(listOf(record))
        assertEquals(listOf("hc-hr-1", "hc-hr-1"), points.map { it.getString("name") })
    }

    @Test
    fun `a point that carries a name still measures its own instant`() {
        val point = JSONObject().put("name", "hc-weight-1").put(
            "weight",
            JSONObject().put(
                "sampleTime",
                JSONObject().put("physicalTime", "2026-08-18T07:00:00Z").put("utcOffset", "7200s"),
            ),
        )
        assertEquals(Instant.parse("2026-08-18T09:00:00Z").toEpochMilli(), SyncEngine.instantMsOf(point))
    }
}
