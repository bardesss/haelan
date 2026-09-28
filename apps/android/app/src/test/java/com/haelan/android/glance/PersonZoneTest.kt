package com.haelan.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
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

    private fun meWith(timezone: String, effective: String?): String {
        val zone = if (effective == null) "null" else "\"$effective\""
        return """{"personId":"p1","timezone":"$timezone","effectiveTimezone":$zone,"currentTimezone":$zone,"followPhoneZone":true}"""
    }

    @Test
    fun `the effective zone wins over the home zone`() {
        assertEquals("Asia/Tokyo", PersonZone.parseMe(meWith("Europe/Amsterdam", "Asia/Tokyo")))
    }

    @Test
    fun `an unusable effective zone falls back to the home zone`() {
        assertEquals("Europe/Amsterdam", PersonZone.parseMe(meWith("Europe/Amsterdam", null)))
        assertEquals("Europe/Amsterdam", PersonZone.parseMe(meWith("Europe/Amsterdam", "Mars/Olympus_Mons")))
        assertEquals("Europe/Amsterdam", PersonZone.parseMe(meWith("Europe/Amsterdam", "")))
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

    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private fun at(instant: String) = Instant.parse(instant).toEpochMilli()
    private val hour = 3_600_000L

    @Test
    fun `the next midnight is the person's, not the phone's or UTC's`() {
        // 23:00 in Amsterdam (summer time) is 21:00 UTC and 17:00 in New York.
        assertEquals(hour, PersonZone.untilNextMidnight(at("2026-09-27T21:00:00Z"), amsterdam))
        assertEquals(7 * hour, PersonZone.untilNextMidnight(at("2026-09-27T21:00:00Z"), phone))
        // Exactly at midnight, the next one is a whole day away.
        assertEquals(24 * hour, PersonZone.untilNextMidnight(at("2026-09-27T22:00:00Z"), amsterdam))
    }

    @Test
    fun `a day the clocks change on is as long as the zone makes it`() {
        // Amsterdam, 25 October 2026: the clocks go back at 03:00, so the day runs 25 hours.
        assertEquals(25 * hour, PersonZone.untilNextMidnight(at("2026-10-24T22:00:00Z"), amsterdam))
        // 29 March 2026: forward at 02:00, 23 hours.
        assertEquals(23 * hour, PersonZone.untilNextMidnight(at("2026-03-28T23:00:00Z"), amsterdam))
    }

    @Test
    fun `a confirmation holds until the person's midnight, however long that day is`() {
        fun confirmedAt(ms: Long) = GlanceUiState(
            shownDay = null, glance = null, fetchedAtMs = ms, reachable = true, loading = false, problem = null, confirmed = true,
        )
        // 00:30 and 23:30 on the 25-hour day are 24 hours apart and still the same day there.
        val early = confirmedAt(at("2026-10-24T22:30:00Z"))
        assertEquals(true, confirmedNow(early, at("2026-10-25T22:30:00Z"), amsterdam))
        // Past that day's midnight (00:00 +01:00 is 23:00 UTC), it no longer holds.
        assertEquals(false, confirmedNow(early, at("2026-10-25T23:01:00Z"), amsterdam))
        // Within the hour after midnight in spring, when an hour is skipped.
        val lateSpring = confirmedAt(at("2026-03-28T22:50:00Z")) // 23:50 +01:00
        assertEquals(false, confirmedNow(lateSpring, at("2026-03-28T23:10:00Z"), amsterdam))
        // Never without the flag, or without an instant to date it by.
        assertEquals(false, confirmedNow(early.copy(confirmed = false), at("2026-10-24T22:31:00Z"), amsterdam))
        assertEquals(false, confirmedNow(early.copy(fetchedAtMs = null), at("2026-10-24T22:31:00Z"), amsterdam))
        assertEquals(false, confirmedNow(null, at("2026-10-24T22:31:00Z"), amsterdam))
    }
}
