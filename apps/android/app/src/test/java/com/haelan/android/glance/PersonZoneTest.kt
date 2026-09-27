package com.haelan.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

/**
 * The person's zone: read from the session route's answer, and chosen over the phone's zone once it
 * is known. The body below is the shape `/api/auth/me` sends (apps/server/src/routes/auth.ts).
 */
class PersonZoneTest {

    private val phone = ZoneId.of("America/New_York")

    private fun me(timezone: String?): String {
        val zone = if (timezone == null) "null" else "\"$timezone\""
        return """{"personId":"p1","displayName":"Ann","username":"ann","isAdmin":false,"timezone":$zone,""" +
            """"birthDate":null,"sex":null,"sleepTargetMinutes":480,"sleepUseBaseline":true,"quickLogEnabled":false}"""
    }

    @Test
    fun `the answer's timezone is read`() {
        assertEquals("Europe/Amsterdam", PersonZone.parseMe(me("Europe/Amsterdam")))
        assertEquals("UTC", PersonZone.parseMe(me("UTC")))
    }

    @Test
    fun `no usable timezone in the answer reads as none`() {
        assertNull(PersonZone.parseMe(me(null)))
        assertNull(PersonZone.parseMe(me("")))
        assertNull(PersonZone.parseMe(me("Mars/Olympus_Mons")))
        assertNull(PersonZone.parseMe("""{"personId":"p1"}"""))
        assertNull(PersonZone.parseMe("<html>a proxy's page</html>"))
    }

    @Test
    fun `the kept zone wins over the phone's`() {
        assertEquals(ZoneId.of("Europe/Amsterdam"), PersonZone.choose("Europe/Amsterdam", phone))
    }

    @Test
    fun `before the first answer, or with a zone the phone cannot read, the phone's zone stands in`() {
        assertEquals(phone, PersonZone.choose(null, phone))
        assertEquals(phone, PersonZone.choose("Mars/Olympus_Mons", phone))
        assertEquals(phone, PersonZone.choose("", phone))
    }
}
