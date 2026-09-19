package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The address a person types is not the address the app posts to: the scheme is often missing,
 * a pasted address often ends in a slash, and a space survives a copy. Every one of those used
 * to reach the network and come back as the same unhelpful sentence (A-18).
 */
class InstanceAddressTest {

    @Test
    fun aBareAddressGetsTheSchemeALocalInstanceUses() {
        assertEquals("http://192.168.1.10:4235", InstanceAddress.normalize("192.168.1.10:4235"))
        assertEquals("http://nas:4235", InstanceAddress.normalize("nas:4235"))
        assertEquals("http://10.0.2.2:4235", InstanceAddress.normalize("10.0.2.2:4235"))
    }

    @Test
    fun aTrailingSlashNeverReachesARequestPath() {
        assertEquals("http://10.0.2.2:4235", InstanceAddress.normalize("http://10.0.2.2:4235/"))
        assertEquals("https://haelan.example/nas", InstanceAddress.normalize(" https://haelan.example/nas// "))
    }

    @Test
    fun theSchemeThePersonChoseIsKept() {
        assertEquals("https://haelan.example", InstanceAddress.normalize("https://haelan.example"))
        assertEquals("http://nas", InstanceAddress.normalize("nas"))
    }

    @Test
    fun somethingThatIsNotAnAddressIsRefusedRatherThanGuessed() {
        assertNull(InstanceAddress.normalize(""))
        assertNull(InstanceAddress.normalize("   "))
        assertNull(InstanceAddress.normalize("http://"))
        assertNull(InstanceAddress.normalize("ftp://nas:4235"))
        assertNull(InstanceAddress.normalize("http://nas:not-a-port"))
        assertNull(InstanceAddress.normalize("due parole"))
    }

    @Test
    fun anAddressCarryingMoreThanTheInstanceIsRefused() {
        assertNull(InstanceAddress.normalize("http://user:secret@nas:4235"))
        assertNull(InstanceAddress.normalize("http://nas:4235/?debug=1"))
        assertNull(InstanceAddress.normalize("http://nas:4235/#top"))
    }
}
