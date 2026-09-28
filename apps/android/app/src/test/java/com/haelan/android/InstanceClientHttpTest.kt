package com.haelan.android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client against a real server, for what only the wire can answer: which headers arrive,
 * which come back, and what a 304 turns into. The 304 is the case this file exists for - a
 * conditional read whose answer is "still current" is a success with no body, and a client that
 * treated it as a failure would have the glance report an error every time nothing changed.
 */
class InstanceClientHttpTest {

    private val instance = TestInstance()

    @After
    fun stop() = instance.close()

    @Test
    fun `the headers a caller names arrive at the instance`() {
        InstanceClient.get(instance.address, "/x", headers = mapOf("If-None-Match" to "\"abc\"")) { }
        assertEquals("\"abc\"", instance.only().headers["if-none-match"])
    }

    @Test
    fun `the session cookie arrives under its own name`() {
        InstanceClient.get(instance.address, "/x", cookie = "s3cret") { }
        assertEquals("haelan_session=s3cret", instance.only().headers["cookie"])
    }

    @Test
    fun `the answer's headers come back by lower-case name`() {
        instance.headers = mapOf("ETag" to "\"v1\"")
        instance.body = "{}"
        val outcome = InstanceClient.get(instance.address, "/x") { it }
        val reply = (outcome as InstanceClient.Outcome.Ok).value
        assertEquals("\"v1\"", reply.headers["etag"])
        assertEquals("\"v1\"", reply.header("ETag"))
    }

    @Test
    fun `a 304 is an answer with no body, not a failure`() {
        instance.status = 304
        val outcome = InstanceClient.get(instance.address, "/x", headers = mapOf("If-None-Match" to "\"v1\"")) { it }
        assertTrue("a 304 is Ok, got $outcome", outcome is InstanceClient.Outcome.Ok)
        val reply = (outcome as InstanceClient.Outcome.Ok).value
        assertEquals(304, reply.status)
        assertEquals("", reply.body)
    }

    /** The contract the sync and the login were written against, which the 304 must not widen. */
    @Test
    fun `any other status is still a failure carrying the status and the body`() {
        instance.status = 401
        instance.body = "nope"
        var parsed = false
        val outcome = InstanceClient.get(instance.address, "/x") { parsed = true }
        val error = (outcome as InstanceClient.Outcome.Failed).error as InstanceClient.InstanceHttpException
        assertEquals(401, error.status)
        assertEquals("nope", error.answer)
        assertFalse("parse runs only on an answer the caller can use", parsed)
    }

    @Test
    fun `a GET sends no body and no content type`() {
        InstanceClient.get(instance.address, "/x") { }
        val request = instance.only()
        assertEquals("GET", request.method)
        assertEquals("", request.body)
        assertEquals(null, request.headers["content-type"])
    }

    @Test
    fun `a POST still sends its method, its JSON and its path`() {
        InstanceClient.post(instance.address, "/api/auth/login", "{\"a\":1}") { }
        val request = instance.only()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/login", request.path)
        assertEquals("{\"a\":1}", request.body)
        assertEquals("application/json", request.headers["content-type"])
    }

    @Test
    fun `a PUT sends its method, its JSON and the cookie`() {
        instance.body = "{\"localDate\":\"2026-09-20\",\"score\":4}"
        val outcome = InstanceClient.put(instance.address, "/api/v1/p/p1/moods/2026-09-20", "{\"score\":4}", "s3cret") { it.body }
        val request = instance.only()
        assertEquals("PUT", request.method)
        assertEquals("{\"score\":4}", request.body)
        assertEquals("application/json", request.headers["content-type"])
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
        assertEquals(instance.body, (outcome as InstanceClient.Outcome.Ok).value)
    }

    @Test
    fun `a DELETE sends its method with no body, and the cookie`() {
        InstanceClient.delete(instance.address, "/api/v1/p/p1/moods/2026-09-20", "s3cret") { }
        val request = instance.only()
        assertEquals("DELETE", request.method)
        assertEquals("/api/v1/p/p1/moods/2026-09-20", request.path)
        assertEquals("", request.body)
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
    }

    /**
     * Named, because on a phone a DELETE without a type is sent as a form, and the instance refuses
     * a form it cannot parse: found on the emulator, where Undo answered "something went wrong".
     * The JVM here sends no type at all, so this holds the line that names one.
     */
    @Test
    fun `a DELETE names a type the instance parses, so Android's form default never reaches it`() {
        InstanceClient.delete(instance.address, "/api/v1/p/p1/events/e1", "s3cret") { }
        assertEquals("text/plain", instance.only().headers["content-type"])
    }

    @Test
    fun `nothing listening is a failure, not a throw`() {
        val outcome = InstanceClient.get(TestInstance.closedAddress(), "/x") { }
        assertTrue(outcome is InstanceClient.Outcome.Failed)
    }
}
