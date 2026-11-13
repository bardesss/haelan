package com.haelan.android

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SyncEngineCancellationTest {

    @Test(expected = CancellationException::class)
    fun `a cancellation inside a type is rethrown, not filed as that type's failure`() = runBlocking<Unit> {
        SyncEngine.runType { throw CancellationException("worker stopped") }
    }

    @Test
    fun `any other exception is the type's own failure`() = runBlocking {
        val error = IllegalStateException("read refused")
        assertEquals(InstanceClient.Outcome.Failed(error), SyncEngine.runType { throw error })
    }
}
