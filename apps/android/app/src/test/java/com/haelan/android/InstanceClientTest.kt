package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The name rides with the value: the instance reads `request.cookies[SESSION_COOKIE]`,
 * so a bare value authenticates nothing and every call after login answers 401.
 * Measured on the wire against a live instance, where the same id answered 200 named
 * and 401 bare.
 */
class InstanceClientTest {

    @Test
    fun theSessionCookieTravelsUnderItsOwnName() {
        assertEquals("haelan_session=abc123", InstanceClient.cookieHeader("abc123"))
    }
}
