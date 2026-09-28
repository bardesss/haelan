package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The in-app page's cookies, storage and cache belong to whoever signed in; the decision of when
 * they change hands at sign-in, which is the only part of it a JVM test can hold.
 */
class WebDataTest {

    @Test
    fun `the same person on the same instance keeps their web data`() {
        assertFalse(WebData.changesHands(WebData.owner("http://nas:4235", "p1"), "http://nas:4235", "p1"))
    }

    @Test
    fun `another person on the same instance gets none of it`() {
        assertTrue(WebData.changesHands(WebData.owner("http://nas:4235", "p1"), "http://nas:4235", "p2"))
    }

    @Test
    fun `the same person id on another instance is somebody else`() {
        assertTrue(WebData.changesHands(WebData.owner("http://nas:4235", "p1"), "http://other:4235", "p1"))
    }

    @Test
    fun `with nobody on record the web data is cleared rather than trusted`() {
        assertTrue(WebData.changesHands(null, "http://nas:4235", "p1"))
    }

    @Test
    fun `a step that throws is logged and the rest still run, so it never blocks signing in or out`() {
        val ran = mutableListOf<String>()
        val logged = mutableListOf<String>()
        WebData.clearEach(
            listOf(
                "cookies" to { throw IllegalStateException("WebView provider is updating") },
                "web storage" to { ran += "web storage" },
                "cache" to { throw RuntimeException("no WebView installed") },
            ),
        ) { logged += it }

        assertEquals(listOf("web storage"), ran)
        assertEquals(2, logged.size)
        assertTrue(logged[0], logged[0].contains("cookies") && logged[0].contains("updating"))
        assertTrue(logged[1], logged[1].contains("cache"))
    }

    @Test
    fun `the owner names both the person and the instance`() {
        assertEquals("p1@http://nas:4235", WebData.owner("http://nas:4235", "p1"))
    }
}
