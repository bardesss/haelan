package com.haelan.android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Health API sync button's one call, against a real server: what goes over the wire, and what
 * each of the instance's answers turns into (apps/server/src/routes/sync.ts). 429 and 409 are
 * "not now", which this app must neither show as an error nor ask again.
 */
class ApiSyncTest {

    private val instance = TestInstance()

    @After
    fun stop() = instance.close()

    @Test
    fun `the call is a POST to the sync route carrying the session cookie`() {
        instance.status = 202
        instance.body = "{\"started\":true}"
        InstanceClient.runApiSync(instance.address, "s3cret")
        val request = instance.only()
        assertEquals("POST", request.method)
        assertEquals("/api/sync/run", request.path)
        assertEquals("haelan_session=s3cret", request.headers["cookie"])
        assertEquals(null, request.headers["origin"])
    }

    /**
     * Fastify refuses a JSON content type with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY), so the
     * call sends an empty object rather than nothing.
     */
    @Test
    fun `the call sends a JSON body the instance can parse`() {
        instance.status = 202
        InstanceClient.runApiSync(instance.address, "s3cret")
        val request = instance.only()
        assertEquals("{}", request.body)
        assertEquals("application/json", request.headers["content-type"])
    }

    @Test
    fun `a 202 is a started sync`() {
        instance.status = 202
        instance.body = "{\"started\":true}"
        assertEquals(ApiSync.Answer.Started, InstanceClient.runApiSync(instance.address, "s3cret"))
    }

    @Test
    fun `a 429 is a cooldown naming its seconds, asked once`() {
        instance.status = 429
        instance.headers = mapOf("retry-after" to "42")
        instance.body = "{\"error\":{\"kind\":\"transient\",\"code\":\"cooldown\"}}"
        assertEquals(ApiSync.Answer.Cooldown(42), InstanceClient.runApiSync(instance.address, "s3cret"))
        // only() is single(): a second request would throw here.
        instance.only()
    }

    @Test
    fun `a 429 without a readable retry-after is the plain error wording`() {
        instance.status = 429
        instance.body = "{}"
        val answer = InstanceClient.runApiSync(instance.address, "s3cret")
        val error = (answer as ApiSync.Answer.Failed).error as InstanceClient.InstanceHttpException
        assertEquals(429, error.status)
    }

    @Test
    fun `a 409 is a sync already running, asked once`() {
        instance.status = 409
        instance.body = "{\"error\":{\"kind\":\"transient\",\"code\":\"already_running\"}}"
        assertEquals(ApiSync.Answer.Busy, InstanceClient.runApiSync(instance.address, "s3cret"))
        instance.only()
    }

    @Test
    fun `a 409 for a shutting-down instance reads the same`() {
        instance.status = 409
        instance.body = "{\"error\":{\"kind\":\"transient\",\"code\":\"shutting_down\"}}"
        assertEquals(ApiSync.Answer.Busy, InstanceClient.runApiSync(instance.address, "s3cret"))
    }

    /** The setup gate's 409 is an unfinished instance, not a run already going. */
    @Test
    fun `a 409 from the setup gate is the plain error wording`() {
        instance.status = 409
        instance.body = "{\"error\":{\"kind\":\"setup_incomplete\",\"code\":\"setup_incomplete\",\"message\":\"x\"}}"
        val answer = InstanceClient.runApiSync(instance.address, "s3cret")
        val error = (answer as ApiSync.Answer.Failed).error as InstanceClient.InstanceHttpException
        assertEquals(409, error.status)
    }

    @Test
    fun `any other status is a failure carrying it`() {
        instance.status = 500
        instance.body = "boom"
        val answer = InstanceClient.runApiSync(instance.address, "s3cret")
        val error = (answer as ApiSync.Answer.Failed).error as InstanceClient.InstanceHttpException
        assertEquals(500, error.status)
    }

    /** A 200 is not what this route answers; reading it as started would claim a run nobody saw. */
    @Test
    fun `a 200 is not a started sync`() {
        instance.status = 200
        instance.body = "{}"
        assertTrue(InstanceClient.runApiSync(instance.address, "s3cret") is ApiSync.Answer.Failed)
    }

    @Test
    fun `nothing listening is a failure, not a throw`() {
        assertTrue(InstanceClient.runApiSync(TestInstance.closedAddress(), "s3cret") is ApiSync.Answer.Failed)
    }

    @Test
    fun `each answer names its own line`() {
        assertEquals(R.string.api_sync_started, ApiSync.lineFor(ApiSync.Answer.Started))
        assertEquals(R.string.api_sync_cooldown, ApiSync.lineFor(ApiSync.Answer.Cooldown(3)))
        assertEquals(R.string.api_sync_busy, ApiSync.lineFor(ApiSync.Answer.Busy))
        // A failure has no line of its own: the screen prints the app's existing error wording.
        assertNull(ApiSync.lineFor(ApiSync.Answer.Failed(InstanceClient.InstanceHttpException(500, ""))))
    }

    // Review M2: a tap clears the last answer before its own request goes out.
    @Test
    fun `a tap clears the line before its request goes out`() {
        val order = mutableListOf<String>()
        val answer = ApiSync.tap(clearLine = { order += "clear" }) {
            order += "request"
            ApiSync.Answer.Started
        }
        assertEquals(listOf("clear", "request"), order)
        assertEquals(ApiSync.Answer.Started, answer)
    }
}
