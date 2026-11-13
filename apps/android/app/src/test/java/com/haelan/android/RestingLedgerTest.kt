package com.haelan.android

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * A resting day is rebuilt from a window read, and a change feed can touch a day older than the
 * window: an edited reading from two months back, or a deleted one whose day still has an
 * earlier reading standing. The window reaches back to cover those days, and the ledger is what
 * dates a deletion, which Health Connect hands over as a bare record id.
 */
class RestingLedgerTest {

    /** Preferences held in a map, written through an editor the way the platform's are. */
    private class Stored : SharedPreferences {
        val values = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = values.toMutableMap()
        override fun getString(key: String?, defValue: String?): String? = values[key] as String? ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            (values[key] as Set<String>?)?.toMutableSet() ?: defValues
        override fun getInt(key: String?, defValue: Int): Int = values[key] as Int? ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = values[key] as Long? ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = values[key] as Float? ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as Boolean? ?: defValue
        override fun contains(key: String?): Boolean = key in values
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            val pending = mutableMapOf<String, Any?>()
            override fun putString(key: String, value: String?) = apply { pending[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { pending[key] = values?.toSet() }
            override fun putInt(key: String, value: Int) = apply { pending[key] = value }
            override fun putLong(key: String, value: Long) = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float) = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { pending[key] = value }
            override fun remove(key: String) = apply { pending[key] = null }
            override fun clear() = apply { values.clear() }
            override fun commit(): Boolean {
                for ((key, value) in pending) if (value == null) values.remove(key) else values[key] = value
                return true
            }
            override fun apply() {
                commit()
            }
        }
    }

    private val end = Instant.parse("2026-11-13T08:00:00Z")
    private val windowStart = end.minus(30, ChronoUnit.DAYS)
    private val fallbackStart = Instant.EPOCH

    private fun daysBack(days: Long) = end.minus(days, ChronoUnit.DAYS)

    @Test
    fun `changes inside the window leave the window as it was`() {
        val start = SyncEngine.rebuildStart(windowStart, listOf(daysBack(3)), listOf("a"), mapOf("a" to daysBack(5).toEpochMilli()), fallbackStart)
        assertEquals(windowStart, start)
    }

    @Test
    fun `an upsert sixty days back reaches back to the day before it`() {
        assertEquals(daysBack(61), SyncEngine.rebuildStart(windowStart, listOf(daysBack(60)), emptyList(), emptyMap(), fallbackStart))
    }

    @Test
    fun `a known deleted reading ninety days back reaches back to the day before it`() {
        val known = mapOf("old" to daysBack(90).toEpochMilli())
        assertEquals(daysBack(91), SyncEngine.rebuildStart(windowStart, emptyList(), listOf("old"), known, fallbackStart))
    }

    @Test
    fun `an unknown deleted id changes nothing`() {
        val known = mapOf("old" to daysBack(90).toEpochMilli())
        assertEquals(windowStart, SyncEngine.rebuildStart(windowStart, emptyList(), listOf("never-sent"), known, fallbackStart))
    }

    @Test
    fun `a reach before what the permission answers is clamped to it`() {
        val floor = daysBack(45)
        assertEquals(floor, SyncEngine.rebuildStart(windowStart, listOf(daysBack(60)), emptyList(), emptyMap(), floor))
    }

    @Test
    fun `the ledger round-trips through preferences`() {
        val prefs = Stored()
        val sent = mapOf("a" to daysBack(2).toEpochMilli(), "b" to daysBack(40).toEpochMilli())
        RestingLedger.record(prefs, "server|p1", sent, fallbackStart)
        RestingLedger.record(prefs, "server|p1", mapOf("c" to daysBack(1).toEpochMilli()), fallbackStart)
        assertEquals(sent + ("c" to daysBack(1).toEpochMilli()), RestingLedger.load(prefs, "server|p1"))
    }

    @Test
    fun `another owner reads an empty ledger and starts its own`() {
        val prefs = Stored()
        RestingLedger.record(prefs, "server|p1", mapOf("a" to daysBack(2).toEpochMilli()), fallbackStart)
        assertTrue(RestingLedger.load(prefs, "server|p2").isEmpty())
        RestingLedger.record(prefs, "server|p2", mapOf("b" to daysBack(2).toEpochMilli()), fallbackStart)
        assertEquals(mapOf("b" to daysBack(2).toEpochMilli()), RestingLedger.load(prefs, "server|p2"))
    }

    @Test
    fun `a write prunes entries older than what the permission answers`() {
        val prefs = Stored()
        RestingLedger.record(prefs, "o", mapOf("old" to daysBack(40).toEpochMilli()), fallbackStart)
        RestingLedger.record(prefs, "o", mapOf("new" to daysBack(2).toEpochMilli()), windowStart)
        assertEquals(mapOf("new" to daysBack(2).toEpochMilli()), RestingLedger.load(prefs, "o"))
    }

    @Test
    fun `a write keeps only the newest entries once the ledger is full`() {
        val prefs = Stored()
        val many = (0 until RestingLedger.MAX_ENTRIES + 5).associate { "r$it" to daysBack(it.toLong()).toEpochMilli() }
        RestingLedger.record(prefs, "o", many, fallbackStart)
        val kept = RestingLedger.load(prefs, "o")
        assertEquals(RestingLedger.MAX_ENTRIES, kept.size)
        assertEquals(many.entries.sortedByDescending { it.value }.take(RestingLedger.MAX_ENTRIES).associate { it.key to it.value }, kept)
    }
}
