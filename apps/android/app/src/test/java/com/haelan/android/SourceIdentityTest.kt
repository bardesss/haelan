package com.haelan.android

import androidx.health.connect.client.records.metadata.Metadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What is proven rather than asserted here: the recording method crosses into the
 * vocabulary the instance actually reads, and a device gets the name v4 wants out of the two
 * fields Health Connect has instead of one it never had.
 */
class SourceIdentityTest {

    @Test
    fun aReadingSomebodyTypedInIsManualAndNotSomethingTheAppMeasured() {
        // The whole of A-05 in one assertion: this used to cross as PASSIVELY_MEASURED, which
        // made a typed weight indistinguishable from a scale's and impossible to exclude.
        assertEquals("MANUAL", SourceIdentity.recordingMethod(Metadata.RECORDING_METHOD_MANUAL_ENTRY))
    }

    @Test
    fun aWorkoutSomebodyStartedIsActivelyMeasured() {
        assertEquals("ACTIVELY_MEASURED", SourceIdentity.recordingMethod(Metadata.RECORDING_METHOD_ACTIVELY_RECORDED))
    }

    @Test
    fun aReadingTheDeviceTookOnItsOwnIsPassivelyMeasured() {
        assertEquals("PASSIVELY_MEASURED", SourceIdentity.recordingMethod(Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED))
    }

    @Test
    fun aMethodNobodyStatedCrossesAsNoClaimRatherThanAGuess() {
        assertNull(SourceIdentity.recordingMethod(Metadata.RECORDING_METHOD_UNKNOWN))
    }

    @Test
    fun theDeviceNameIsTheManufacturerAndTheModelTogether() {
        assertEquals("Google Pixel Watch 3", SourceIdentity.deviceName("Google", "Pixel Watch 3"))
    }

    @Test
    fun aModelThatAlreadyCarriesTheBrandIsNotDoubled() {
        assertEquals("Samsung Galaxy Watch5", SourceIdentity.deviceName("Samsung", "Samsung Galaxy Watch5"))
    }

    @Test
    fun halfADeviceStillNamesIt() {
        assertEquals("Withings", SourceIdentity.deviceName("Withings", null))
        assertEquals("Body Comp", SourceIdentity.deviceName(null, "Body Comp"))
    }

    @Test
    fun aBlankFieldIsAnAbsentDeviceRatherThanAnEmptyName() {
        assertNull(SourceIdentity.deviceName("", "   "))
        assertNull(SourceIdentity.deviceName(null, null))
    }

    @Test
    fun aTypedReadingCarriesNoDeviceAndSaysManual() {
        val identity = SourceIdentity.of(null, null, Metadata.RECORDING_METHOD_MANUAL_ENTRY)

        // No device is what makes the package name the `who` of the identity, and MANUAL is what
        // makes the instance file the row under a source of its own, kind manual.
        assertNull(identity.deviceName)
        assertEquals("MANUAL", identity.recordingMethod)
    }

    @Test
    fun aWatchAndAPhoneAreTwoIdentitiesAndNotOne() {
        val watch = SourceIdentity.of("Google", "Pixel Watch 3", Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED)
        val phone = SourceIdentity.of("Google", "Pixel 9 Pro", Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED)

        assertEquals(2, setOf(watch, phone).size)
    }
}
