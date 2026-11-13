package com.haelan.android

import org.junit.Assert.assertEquals
import org.json.JSONObject
import org.junit.Test

class DataSourceShapeTest {
    @Test fun `a record from another app names that app and marks itself origin scoped`() {
        val json = SyncEngine.dataSourceOf(SourceIdentity("Google Pixel 9", "PASSIVELY_MEASURED", "com.google.android.apps.fitness"), "com.haelan.android")
        assertEquals("com.google.android.apps.fitness", json.getJSONObject("application").getString("packageName"))
        assertEquals(true, json.getBoolean("originScoped"))
        assertEquals("Google Pixel 9", json.getJSONObject("device").getString("displayName"))
    }

    @Test fun `a record before the cutover keeps its source id and marks itself as the upgraded phone's old identity`() {
        val json = SyncEngine.dataSourceOf(SourceIdentity("Google Pixel 9", "PASSIVELY_MEASURED", null), "com.haelan.android")
        // The whole object, so a key added or dropped fails here. The JVM's org.json keeps keys in
        // a HashMap rather than the device's insertion order, so the expected string is put through
        // the same JSONObject before the two are compared.
        val expected = """{"platform":"HEALTH_CONNECT","application":{"packageName":"com.haelan.android"},""" +
            """"device":{"displayName":"Google Pixel 9"},"recordingMethod":"PASSIVELY_MEASURED","originScoped":false}"""
        assertEquals(JSONObject(expected).toString(), json.toString())
    }
}
