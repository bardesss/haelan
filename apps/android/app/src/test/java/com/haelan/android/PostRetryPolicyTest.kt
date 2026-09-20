package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which refusals the sync asks again, and how many times - the rule that used to be "none".
 *
 * The retry is what keeps a refusal from abandoning the rest of a type: uploadType returns at the
 * first permanent failure, so every chunk after it goes unposted too. It is also the only reason a
 * transient failure is not a loss at all, so which failures count as transient decides whether a
 * flaky network costs data.
 *
 * [SyncEngine.postWithRetry] takes its clock as a parameter, so every case here runs the real
 * policy to its end without spending the budget in real time. `InstanceClient.InstanceHttpException`
 * is what a non-200 answer arrives as, and `IOException` is what a socket that died arrives as.
 */
class PostRetryPolicyTest {

    private class Attempts(private val outcomes: List<InstanceClient.Outcome<Unit>>) {
        var count = 0
            private set
        val waits = mutableListOf<Long>()

        suspend fun post(): InstanceClient.Outcome<Unit> {
            val outcome = outcomes[minOf(count, outcomes.size - 1)]
            count++
            return outcome
        }

        val sleep: suspend (Long) -> Unit = { waits += it }
    }

    private fun ok(): InstanceClient.Outcome<Unit> = InstanceClient.Outcome.Ok(Unit)

    private fun refused(status: Int): InstanceClient.Outcome<Unit> =
        InstanceClient.Outcome.Failed(InstanceClient.InstanceHttpException(status, "an answer"))

    private fun threw(): InstanceClient.Outcome<Unit> =
        InstanceClient.Outcome.Failed(java.io.IOException("the socket went away"))

    private suspend fun run(attempts: Attempts, budget: Int = SyncEngine.POST_ATTEMPTS) =
        SyncEngine.postWithRetry(budget, attempts.sleep) { attempts.post() }

    @Test
    fun `an answer that works is never asked again`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(ok()))
        assertTrue(run(attempts) is InstanceClient.Outcome.Ok)
        assertEquals("one post, no waits", 1, attempts.count)
        assertEquals(emptyList<Long>(), attempts.waits)
    }

    @Test
    fun `a 5xx is asked again until it is answered`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(503), refused(502), ok()))
        assertTrue(run(attempts) is InstanceClient.Outcome.Ok)
        assertEquals("two refusals and the answer", 3, attempts.count)
        assertEquals("the wait doubles", listOf(500L, 1_000L), attempts.waits)
    }

    @Test
    fun `a 429 is asked again`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(429), ok()))
        assertTrue(run(attempts) is InstanceClient.Outcome.Ok)
        assertEquals(2, attempts.count)
    }

    @Test
    fun `a socket that died is asked again`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(threw(), ok()))
        assertTrue(run(attempts) is InstanceClient.Outcome.Ok)
        assertEquals(2, attempts.count)
    }

    @Test
    fun `a session that is over is never asked again`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(401), ok()))
        val outcome = run(attempts)
        // syncAll reads this exact status to end the whole sync and open the login screen. Sleeping
        // on it would hammer the instance with a cookie it has already rejected, and would swallow
        // the one answer that concerns every type rather than this one.
        assertEquals("no second attempt", 1, attempts.count)
        assertEquals(401, (outcome as InstanceClient.Outcome.Failed).error.let {
            (it as InstanceClient.InstanceHttpException).status
        })
    }

    @Test
    fun `the other 4xx answers are final`() = kotlinx.coroutines.runBlocking {
        for (status in listOf(400, 403, 413)) {
            val attempts = Attempts(listOf(refused(status), ok()))
            run(attempts)
            assertEquals("a $status is the request's own fault", 1, attempts.count)
        }
    }

    @Test
    fun `the budget bounds the asking, and the wait never runs away`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(503)))
        val outcome = run(attempts)
        assertTrue(outcome is InstanceClient.Outcome.Failed)
        assertEquals("every attempt was spent", SyncEngine.POST_ATTEMPTS, attempts.count)
        // Three waits for four attempts, doubling and then held at the ceiling: at most seven and a
        // half seconds on a chunk that never goes, which is what a background sync can afford.
        assertEquals(listOf(500L, 1_000L, 2_000L), attempts.waits)
    }

    @Test
    fun `a single attempt budget never retries`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(503), ok()))
        run(attempts, budget = 1)
        assertEquals("the first refusal is final when there is no budget", 1, attempts.count)
        assertEquals(emptyList<Long>(), attempts.waits)
    }

    @Test
    fun `the last attempt is returned rather than a fresh one being invented`() = kotlinx.coroutines.runBlocking {
        // The loop must return what the final attempt answered, not fall off the end of the budget
        // with the previous refusal. A last attempt that succeeds is a chunk that travelled.
        val attempts = Attempts(listOf(refused(503), refused(503), refused(503), ok()))
        assertTrue(run(attempts) is InstanceClient.Outcome.Ok)
        assertEquals(SyncEngine.POST_ATTEMPTS, attempts.count)
    }

    @Test
    fun `the wait is capped so four attempts do not sleep for minutes`() = kotlinx.coroutines.runBlocking {
        val attempts = Attempts(listOf(refused(500)))
        run(attempts, budget = 8)
        assertTrue("no wait exceeds the ceiling", attempts.waits.all { it <= 4_000L })
        assertFalse("and the waits do not grow without bound", attempts.waits.last() > 4_000L)
    }
}
