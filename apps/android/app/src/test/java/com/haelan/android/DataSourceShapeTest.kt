package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DataSourceShapeTest {
    @Test fun `a record from another app names that app and marks itself origin scoped`() {
        val json = SyncEngine.dataSourceOf(SourceIdentity("Google Pixel 9", "PASSIVELY_MEASURED", "com.google.android.apps.fitness"), "com.haelan.android")
        assertEquals("com.google.android.apps.fitness", json.getJSONObject("application").getString("packageName"))
        assertEquals(true, json.getBoolean("originScoped"))
        assertEquals("Google Pixel 9", json.getJSONObject("device").getString("displayName"))
    }

    @Test fun `a record before the cutover is sent exactly as it always was`() {
        val json = SyncEngine.dataSourceOf(SourceIdentity("Google Pixel 9", "PASSIVELY_MEASURED", null), "com.haelan.android")
        assertEquals("com.haelan.android", json.getJSONObject("application").getString("packageName"))
        assertFalse(json.has("originScoped"))
    }
}
