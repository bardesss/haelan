package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule the app promises about its own uploads: a type travels only when a real path
 * produced it. Before this table existed, five types came from a random generator on the
 * phone (A-03), so these tests are mostly about what must not come back.
 */
class SyncTypesTest {

    private val inventedDailyTypes = listOf(
        "active-minutes",
        "active-zone-minutes",
        "daily-sleep-temperature-derivations",
        "daily-heart-rate-zones",
    )

    private val averagedOnTheDevice = listOf(
        "daily-heart-rate-variability",
        "daily-oxygen-saturation",
        "daily-respiratory-rate",
        "daily-vo2-max",
    )

    @Test
    fun everyTypeIsReadFromHealthConnect() {
        assertEquals(setOf(SyncTypes.HEALTH_CONNECT), SyncTypes.ALL.map { it.source }.toSet())
    }

    @Test
    fun anInventedTypeIsRefusedRatherThanSent() {
        for (dataTypeId in inventedDailyTypes + averagedOnTheDevice) {
            assertFalse(dataTypeId, SyncTypes.isDeclared(dataTypeId))
            assertThrows(IllegalStateException::class.java) { SyncTypes.declared(dataTypeId) }
        }
    }

    @Test
    fun theRestingHeartRateIsStillSentBecauseTheDeviceComputesIt() {
        assertTrue(SyncTypes.isDeclared("daily-resting-heart-rate"))
    }

    /**
     * The fifth of A-03's invented types survived phase 2 on the strength of a measurement, not
     * of a second look: T0.4 found BasalMetabolicRateRecord, one record a day. The four above
     * have no record class in connect-client at all.
     */
    @Test
    fun theBasalRateIsSentBecauseHealthConnectRecordsIt() {
        assertTrue(SyncTypes.isDeclared("basal-energy-burned"))
    }

    @Test
    fun everyToggleOnTheScreenNamesADeclaredType() {
        assertEquals(SyncTypes.KEYS.toSet(), SyncTypes.ALL.map { it.key }.toSet())
        for (key in SyncTypes.KEYS) {
            assertTrue(key, SyncTypes.typesFor(key).isNotEmpty())
        }
    }

    @Test
    fun aTypeIsDeclaredOnceAndItsIdAppearsOnce() {
        assertEquals(SyncTypes.KEYS.size, SyncTypes.KEYS.toSet().size)
        assertEquals(SyncTypes.ALL.size, SyncTypes.ALL.map { it.dataTypeId }.toSet().size)
    }

    @Test
    fun everyDeclaredTypeIsReachableFromAToggle() {
        for (type in SyncTypes.ALL) {
            assertTrue(type.dataTypeId, type.key in SyncTypes.KEYS)
        }
    }

    @Test
    fun everyToggleResolvesToExactlyOneDeclaredType() {
        for (key in SyncTypes.KEYS) {
            assertEquals(key, key, SyncTypes.forKey(key).key)
        }
        // A toggle that survived phase 2 in name only: no type names this key any more, so
        // asking for it is still the mistake the table refuses.
        assertThrows(IllegalStateException::class.java) { SyncTypes.forKey("zone_minutes") }
    }
}
