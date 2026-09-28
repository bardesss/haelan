package com.haelan.android.glance

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The store through the in-memory [GlanceStore.Storage]: the EncryptedFile underneath it on a phone
 * is the platform's, and what this proves is the record around it - whose glance it is, and that a
 * record the app cannot use is gone after the first read that finds it.
 */
class GlanceStoreTest {

    private val storage = MemoryStorage()
    private val store = GlanceStore(storage)
    private val today = glanceFixture("today.json")

    @Test
    fun `a saved glance loads back with its ETag and the instant it was fetched`() {
        assertTrue(store.save("https://h.example", "p1", "\"v1\"", 1234L, today))
        val kept = checkNotNull(store.load("https://h.example", "p1"))
        assertEquals(GlanceParser.parse(today), kept.glance)
        assertEquals(today, kept.json)
        assertEquals("\"v1\"", kept.etag)
        assertEquals(1234L, kept.fetchedAtMs)
    }

    @Test
    fun `a glance saved without an ETag loads back without one`() {
        store.save("https://h.example", "p1", null, 1234L, today)
        assertNull(checkNotNull(store.load("https://h.example", "p1")).etag)
    }

    @Test
    fun `nothing saved loads as nothing`() {
        assertNull(store.load("https://h.example", "p1"))
    }

    @Test
    fun `another person's glance is not shown, and is deleted on the read that finds it`() {
        store.save("https://h.example", "p2", "\"v1\"", 1234L, today)
        assertNull(store.load("https://h.example", "p1"))
        assertNull(storage.bytes)
    }

    @Test
    fun `the same person id on another server is someone else`() {
        store.save("https://other.example", "p1", "\"v1\"", 1234L, today)
        assertNull(store.load("https://h.example", "p1"))
        assertNull(storage.bytes)
    }

    @Test
    fun `bytes that are not a record are deleted`() {
        storage.bytes = "not json".toByteArray()
        assertNull(store.load("https://h.example", "p1"))
        assertNull(storage.bytes)
    }

    @Test
    fun `a record whose glance the parser rejects is deleted, ETag and all`() {
        // Kept, its ETag would earn a 304 that leaves the screen with nothing to draw.
        store.save("https://h.example", "p1", "\"v1\"", 1234L, "{\"today\":\"2026-08-20\"}")
        assertNull(store.load("https://h.example", "p1"))
        assertNull(storage.bytes)
    }

    @Test
    fun `a record missing a field is deleted`() {
        store.save("https://h.example", "p1", "\"v1\"", 1234L, today)
        val record = JSONObject(String(checkNotNull(storage.bytes))).apply { remove("fetchedAtMs") }
        storage.bytes = record.toString().toByteArray()
        assertNull(store.load("https://h.example", "p1"))
        assertNull(storage.bytes)
    }

    @Test
    fun `a storage that cannot be read is treated as empty and cleared`() {
        val broken = object : GlanceStore.Storage {
            var deleted = false
            override fun read(): ByteArray = throw IllegalStateException("bad tag")
            override fun write(bytes: ByteArray) = Unit
            override fun delete() {
                deleted = true
            }
        }
        assertNull(GlanceStore(broken).load("https://h.example", "p1"))
        assertTrue(broken.deleted)
    }

    @Test
    fun `a save the storage refuses answers false instead of throwing`() {
        storage.failWrites = true
        assertFalse(store.save("https://h.example", "p1", "\"v1\"", 1234L, today))
    }

    @Test
    fun `a second save replaces the first`() {
        store.save("https://h.example", "p1", "\"v1\"", 1L, today)
        val past = glanceFixture("past-day.json")
        store.save("https://h.example", "p1", "\"v2\"", 2L, past)
        val kept = checkNotNull(store.load("https://h.example", "p1"))
        assertEquals("\"v2\"", kept.etag)
        assertEquals("2026-08-18", kept.glance.today)
    }

    @Test
    fun `delete forgets the glance`() {
        store.save("https://h.example", "p1", "\"v1\"", 1234L, today)
        assertNotNull(storage.bytes)
        store.delete()
        assertNull(storage.bytes)
        assertNull(store.load("https://h.example", "p1"))
    }

    @Test
    fun `the record holds the glance as the server sent it`() {
        store.save("https://h.example", "p1", "\"v1\"", 1234L, today)
        val record = JSONObject(String(checkNotNull(storage.bytes)))
        assertEquals("https://h.example", record.getString("server"))
        assertEquals("p1", record.getString("personId"))
        assertArrayEquals(today.toByteArray(), record.getString("json").toByteArray())
    }
}
