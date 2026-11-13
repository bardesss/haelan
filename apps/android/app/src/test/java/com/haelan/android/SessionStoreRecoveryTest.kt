package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionStoreRecoveryTest {

    @Test fun `a secure file that opens is used without a reset`() {
        var resets = 0
        assertEquals("prefs", SessionStore.createOrRecover({ "prefs" }, { resets++ }))
        assertEquals(0, resets)
    }

    @Test fun `a secure file that fails once is deleted and created again`() {
        var calls = 0
        var resets = 0
        val result = SessionStore.createOrRecover(
            { if (calls++ == 0) throw java.security.GeneralSecurityException("restored keyset") else "fresh" },
            { resets++ },
        )
        assertEquals("fresh", result)
        assertEquals(1, resets)
        assertEquals(2, calls)
    }

    @Test fun `a secure file that fails twice answers null so the caller falls back`() {
        var resets = 0
        assertNull(SessionStore.createOrRecover<String>({ throw IllegalStateException("no keystore") }, { resets++ }))
        assertEquals(1, resets)
    }
}
