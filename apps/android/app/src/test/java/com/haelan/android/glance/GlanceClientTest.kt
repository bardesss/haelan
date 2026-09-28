package com.haelan.android.glance

import com.haelan.android.InstanceClient
import com.haelan.android.TestInstance
import com.haelan.android.glance.GlanceClient.CalendarRead
import com.haelan.android.glance.GlanceClient.GlanceRead
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The glance's three reads against a real server, each answer the instance can give turned into
 * the case the screen draws. The bodies are the shapes glance.ts sends: `{ nearest }` on a past
 * day with no data, and registerV1's error envelope on a 400.
 */
class GlanceClientTest {

    private val instance = TestInstance()
    private val client = GlanceClient(instance.address, "p1", "s3cret")

    @After
    fun stop() = instance.close()

    @Test
    fun `today asks the glance route with the session cookie`() {
        instance.body = "{}"
        client.today(null)
        val request = instance.only()
        assertEquals("GET", request.method)
        assertEquals("/api/v1/p/p1/glance", request.path)
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
        assertEquals("no ETag, no condition", null, request.headers["if-none-match"])
    }

    @Test
    fun `today sends the ETag it was given as If-None-Match`() {
        instance.body = "{}"
        client.today("\"v1\"")
        assertEquals("\"v1\"", instance.only().headers["if-none-match"])
    }

    @Test
    fun `a fresh glance carries its body and the ETag to send next time`() {
        instance.body = "{\"today\":\"2026-09-27\"}"
        instance.headers = mapOf("ETag" to "\"v2\"")
        assertEquals(GlanceRead.Fresh("{\"today\":\"2026-09-27\"}", "\"v2\""), client.today(null))
    }

    @Test
    fun `a 304 is NotModified`() {
        instance.status = 304
        assertEquals(GlanceRead.NotModified, client.today("\"v1\""))
    }

    @Test
    fun `a 401 is Unauthorised`() {
        instance.status = 401
        instance.body = "{\"error\":{\"message\":\"no session\"}}"
        assertEquals(GlanceRead.Unauthorised, client.today(null))
        assertEquals(GlanceRead.Unauthorised, client.day("2026-09-20"))
        assertEquals(CalendarRead.Unauthorised, client.calendar("2026-09"))
    }

    /** An instance older than 2.6.0 has no glance route, and says so with a bare 404. */
    @Test
    fun `a 404 on today is TooOld`() {
        instance.status = 404
        instance.body = "{\"message\":\"Route GET:/api/v1/p/p1/glance not found\"}"
        assertEquals(GlanceRead.TooOld, client.today(null))
    }

    @Test
    fun `a past day asks with the day as given, and no condition`() {
        instance.body = "{}"
        client.day("2026-09-20")
        val request = instance.only()
        assertEquals("/api/v1/p/p1/glance?day=2026-09-20", request.path)
        assertEquals(null, request.headers["if-none-match"])
    }

    @Test
    fun `a 404 naming a day on a past day is Nearest`() {
        instance.status = 404
        instance.body = "{ \"nearest\": \"2026-09-20\" }"
        assertEquals(GlanceRead.Nearest("2026-09-20"), client.day("2026-09-22"))
    }

    /** The same body on today is not an answer today can give, so it stays the missing route. */
    @Test
    fun `a 404 naming a day on today is still TooOld`() {
        instance.status = 404
        instance.body = "{ \"nearest\": \"2026-09-20\" }"
        assertEquals(GlanceRead.TooOld, client.today(null))
    }

    @Test
    fun `a 404 with no day in it on a past day is TooOld`() {
        instance.status = 404
        instance.body = "{\"nearest\":null}"
        assertEquals(GlanceRead.TooOld, client.day("2026-09-22"))
    }

    @Test
    fun `a 400 is Refused with the instance's own sentence`() {
        instance.status = 400
        instance.body = "{\"error\":{\"kind\":\"config\",\"code\":\"config\",\"message\":\"day '2026-09-30' is after today '2026-09-27'\"}}"
        assertEquals(GlanceRead.Refused("day '2026-09-30' is after today '2026-09-27'"), client.day("2026-09-30"))
    }

    @Test
    fun `a 400 whose body is not the envelope is Refused with the body as it came`() {
        instance.status = 400
        instance.body = "Bad Request"
        assertEquals(GlanceRead.Refused("Bad Request"), client.day("2026-09-30"))
    }

    @Test
    fun `a status nobody named is Unreachable, carrying it`() {
        instance.status = 500
        instance.body = "boom"
        val read = client.today(null)
        val cause = (read as GlanceRead.Unreachable).cause as InstanceClient.InstanceHttpException
        assertEquals(500, cause.status)
    }

    @Test
    fun `nothing listening is Unreachable`() {
        val closed = GlanceClient(TestInstance.closedAddress(), "p1", "s3cret")
        assertTrue(closed.today(null) is GlanceRead.Unreachable)
        assertTrue(closed.calendar("2026-09") is CalendarRead.Unreachable)
    }

    @Test
    fun `the calendar asks for the month as given and returns its body`() {
        instance.body = "{\"month\":\"2026-09\",\"days\":[]}"
        assertEquals(CalendarRead.Fresh("{\"month\":\"2026-09\",\"days\":[]}"), client.calendar("2026-09"))
        val request = instance.only()
        assertEquals("/api/v1/p/p1/glance/calendar?month=2026-09", request.path)
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
    }

    @Test
    fun `a 400 on the calendar is Refused with the instance's own sentence`() {
        instance.status = 400
        instance.body = "{\"error\":{\"kind\":\"config\",\"code\":\"config\",\"message\":\"month is required\"}}"
        assertEquals(CalendarRead.Refused("month is required"), client.calendar("2026-13"))
    }

    @Test
    fun `a 404 on the calendar is TooOld`() {
        instance.status = 404
        assertEquals(CalendarRead.TooOld, client.calendar("2026-09"))
    }

    /** The seam Task 5 uses: any transport of the same shape stands in for the network. */
    @Test
    fun `a handed-in transport is what the client reads through`() {
        val seen = mutableListOf<Map<String, String>>()
        val fake = GlanceClient("http://nowhere", "p1", "s3cret") { _, _, _, headers ->
            seen += headers
            InstanceClient.Outcome.Ok(InstanceClient.Reply(304, "", emptyMap()))
        }
        assertEquals(GlanceRead.NotModified, fake.today("\"v1\""))
        assertEquals(listOf(mapOf("If-None-Match" to "\"v1\"")), seen)
    }
}
