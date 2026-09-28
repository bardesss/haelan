package com.haelan.android.glance

import com.haelan.android.TestInstance
import com.haelan.android.glance.QuickLogClient.Answer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The log sheet's calls against a real server: each route's method, path and body as quickLog.ts
 * and annotations.ts read them, the answers the sheet uses read back, and a refusal's own sentence
 * (registerV1's error envelope) surfaced for the line under the section.
 */
class QuickLogClientTest {

    private val instance = TestInstance()
    private val client = QuickLogClient(instance.address, "p1", "s3cret")

    @After
    fun stop() = instance.close()

    private fun sent(): TestInstance.Request = instance.only()

    private fun bodyOf(request: TestInstance.Request): JSONObject = JSONObject(request.body)

    @Test
    fun `a stepped day reads the day-log route and parses the day log`() {
        instance.body = glanceFixture("day-log.json")
        val answer = client.dayLog("2026-08-19")
        val request = sent()
        assertEquals("GET", request.method)
        assertEquals("/api/v1/p/p1/quick-log/day/2026-08-19", request.path)
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
        val log = (answer as Answer.Ok).value
        assertEquals(listOf("illness", "travel", "alcohol", "medication", "injury", "caffeine", "meditation", "sauna", "reading", "screen_free", "stretching"), log.presets)
        assertEquals(2, log.mood)
        assertEquals(mapOf("sauna" to 1), log.counts)
        assertEquals("2026-08-20", log.today)
    }

    @Test
    fun `a tap posts the kind and the day, and answers the event's id`() {
        instance.body = """{"id":"e7","kind":"caffeine","startedAtMs":1,"startedAtOffsetMinutes":120,""" +
            """"endedAtMs":null,"endedAtOffsetMinutes":null,"value":null,"note":null,"localDate":"2026-09-27"}"""
        val answer = client.tap("caffeine", "2026-09-27")
        val request = sent()
        assertEquals("POST", request.method)
        assertEquals("/api/v1/p/p1/quick-log", request.path)
        assertEquals("caffeine", bodyOf(request).getString("kind"))
        assertEquals("2026-09-27", bodyOf(request).getString("day"))
        assertEquals(Answer.Ok(LoggedEvent("e7", "caffeine", "2026-09-27")), answer)
    }

    @Test
    fun `undo deletes the event the tap answered with`() {
        instance.body = """{"id":"e7"}"""
        assertEquals(Answer.Ok(Unit), client.undo("e7"))
        val request = sent()
        assertEquals("DELETE", request.method)
        assertEquals("/api/v1/p/p1/events/e7", request.path)
        assertEquals("", request.body)
    }

    @Test
    fun `a mood is put with its score`() {
        instance.body = """{"localDate":"2026-09-27","score":4}"""
        assertEquals(Answer.Ok(Unit), client.setMood("2026-09-27", 4))
        val request = sent()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/p/p1/moods/2026-09-27", request.path)
        assertEquals(4, bodyOf(request).getInt("score"))
    }

    @Test
    fun `a cleared mood is deleted`() {
        instance.body = """{"localDate":"2026-09-27"}"""
        assertEquals(Answer.Ok(Unit), client.setMood("2026-09-27", null))
        val request = sent()
        assertEquals("DELETE", request.method)
        assertEquals("/api/v1/p/p1/moods/2026-09-27", request.path)
    }

    @Test
    fun `the chips are put as the whole list, and answered as saved`() {
        instance.body = """{"kinds":["caffeine","Sauna"]}"""
        val answer = client.savePresets(listOf("caffeine", "Sauna"))
        val request = sent()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/p/p1/quick-log/presets", request.path)
        val kinds = bodyOf(request).getJSONArray("kinds")
        assertEquals(listOf("caffeine", "Sauna"), (0 until kinds.length()).map { kinds.getString(it) })
        assertEquals(Answer.Ok(listOf("caffeine", "Sauna")), answer)
    }

    @Test
    fun `a note is put with its body as typed`() {
        instance.body = """{"id":"n1"}"""
        assertEquals(Answer.Ok(Unit), client.saveNote("2026-09-27", "Birthday, home late."))
        val request = sent()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/p/p1/notes/2026-09-27", request.path)
        assertEquals("Birthday, home late.", bodyOf(request).getString("body"))
    }

    @Test
    fun `a blank note is deleted, since the route refuses an empty body`() {
        instance.body = """{"id":null}"""
        assertEquals(Answer.Ok(Unit), client.saveNote("2026-09-27", "  "))
        val request = sent()
        assertEquals("DELETE", request.method)
        assertEquals("/api/v1/p/p1/notes/2026-09-27", request.path)
    }

    @Test
    fun `a 400 surfaces the instance's own sentence`() {
        instance.status = 400
        instance.body = """{"error":{"message":"at most 16 kinds"}}"""
        assertEquals(Answer.Refused("at most 16 kinds"), client.savePresets(List(17) { "k$it" }))
    }

    @Test
    fun `a 401 is Unauthorised, whatever the call`() {
        instance.status = 401
        instance.body = """{"error":{"message":"no session"}}"""
        assertEquals(Answer.Unauthorised, client.tap("caffeine", "2026-09-27"))
    }

    @Test
    fun `a refusal without the envelope is unreachable, never shown as a sentence`() {
        instance.status = 502
        instance.body = "<html>Bad gateway</html>"
        assertTrue(client.setMood("2026-09-27", 3) is Answer.Unreachable)
    }

    @Test
    fun `a 200 whose body is not the route's is unreachable`() {
        instance.body = "<html>captive portal</html>"
        assertTrue(client.tap("caffeine", "2026-09-27") is Answer.Unreachable)
    }

    @Test
    fun `no instance at all is unreachable`() {
        val nowhere = QuickLogClient(TestInstance.closedAddress(), "p1", "s3cret")
        assertTrue(nowhere.undo("e7") is Answer.Unreachable)
    }
}
