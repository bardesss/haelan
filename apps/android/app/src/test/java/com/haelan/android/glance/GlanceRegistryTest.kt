package com.haelan.android.glance

import com.haelan.android.glance.GlanceClient.GlanceRead
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The open glances, and the sign-out that closes them before it deletes the stored glance. The
 * repositories are stand-ins that record their close into one log, so the order is what is read.
 */
class GlanceRegistryTest {

    private val log = mutableListOf<String>()

    private inner class Repo(val name: String) : AutoCloseable {
        var closed = false
        override fun close() {
            closed = true
            log += "close $name"
        }
    }

    @Test
    fun `closing the newer of two screens leaves the older for the sign-out to close`() {
        val registry = GlanceRegistry()
        val older = registry.register(Repo("older"))
        val newer = registry.register(Repo("newer"))

        registry.close(newer)
        assertTrue(newer.closed)
        assertFalse(older.closed)
        assertEquals(1, registry.size)

        registry.closeAll()
        assertTrue("the older glance was left running", older.closed)
        assertEquals(0, registry.size)
    }

    @Test
    fun `a repository closed by the sign-out is closed again harmlessly when its screen goes`() {
        val registry = GlanceRegistry()
        val repo = registry.register(Repo("one"))
        registry.closeAll()
        registry.close(repo)
        assertEquals(0, registry.size)
    }

    @Test
    fun `the sign-out closes every glance before it deletes the store`() {
        val registry = GlanceRegistry()
        registry.register(Repo("a"))
        registry.register(Repo("b"))

        forgetGlances(registry) { log += "delete" }

        assertEquals(listOf("close a", "close b", "delete"), log)
    }

    /** The real repository is what the app registers, and once the sign-out has closed it, it keeps nothing. */
    @Test
    fun `a closed glance repository reads and keeps nothing more`() {
        val registry = GlanceRegistry()
        val store = GlanceStore(MemoryStorage())
        val reads = FakeReads().apply { todayAnswers += GlanceRead.Fresh(glanceFixture("today.json"), "\"v1\"") }
        val repository = registry.register(
            GlanceRepository(reads, store, "http://instance", "p1", clock = { 0L }, dispatcher = Dispatchers.Unconfined, log = {}),
        )

        forgetGlances(registry) { store.delete() }
        repository.refresh()

        assertEquals(0, registry.size)
        assertEquals(1, reads.todayAnswers.size)
        assertNull(store.load("http://instance", "p1"))
    }
}
