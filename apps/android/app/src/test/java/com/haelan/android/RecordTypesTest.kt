package com.haelan.android

import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The record class each toggle's change feed is opened for, and how its deletions travel. */
class RecordTypesTest {

    @Test
    fun `every toggle names the record class its feed is opened for`() {
        SyncTypes.KEYS.forEach { SyncEngine.recordTypeOf(it) }
        assertEquals(StepsRecord::class, SyncEngine.recordTypeOf("steps"))
        assertEquals(SleepSessionRecord::class, SyncEngine.recordTypeOf("sleep"))
        assertEquals(RespiratoryRateRecord::class, SyncEngine.recordTypeOf("breathing"))
    }

    @Test
    fun `deletions travel in pieces the route accepts, in order, none dropped`() {
        val ids = (1..2_000).map { "hc-$it" }
        val pieces = SyncEngine.deletionPayloads(ids).map { JSONObject(it).getJSONArray("recordIds") }
        assertEquals(listOf(990, 990, 20), pieces.map { it.length() })
        assertEquals(ids, pieces.flatMap { p -> (0 until p.length()).map { p.getString(it) } })
    }

    @Test
    fun `no deletions is no request`() =
        assertEquals(emptyList<String>(), SyncEngine.deletionPayloads(emptyList()))
}
