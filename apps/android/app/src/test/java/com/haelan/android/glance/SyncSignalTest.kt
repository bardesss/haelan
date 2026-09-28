package com.haelan.android.glance

import android.content.SharedPreferences
import com.haelan.android.SyncStatus
import com.haelan.android.SyncTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The finished-sync signal: which preference keys it answers to, and that it listens only between
 * start and close. The preferences are a hand-written fake that keeps its listeners and lets the
 * test announce a change, as SharedPreferences does after a write.
 */
class SyncSignalTest {

    /** Preferences that hold nothing but their listeners; every read is a mistake in this test. */
    private class Listened : SharedPreferences {
        val listeners = mutableListOf<SharedPreferences.OnSharedPreferenceChangeListener>()

        fun changed(key: String?) = listeners.toList().forEach { it.onSharedPreferenceChanged(this, key) }

        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
            listeners += listener
        }

        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
            listeners -= listener
        }

        override fun getAll(): MutableMap<String, *> = error("not read")
        override fun getString(key: String?, defValue: String?): String? = error("not read")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = error("not read")
        override fun getInt(key: String?, defValue: Int): Int = error("not read")
        override fun getLong(key: String?, defValue: Long): Long = error("not read")
        override fun getFloat(key: String?, defValue: Float): Float = error("not read")
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = error("not read")
        override fun contains(key: String?): Boolean = error("not read")
        override fun edit(): SharedPreferences.Editor = error("not written")
    }

    @Test
    fun `every type's last-run key is a sync finishing`() {
        val missed = SyncTypes.ALL.map { SyncStatus.lastKey(it.key) }.filterNot { SyncSignal.isSyncKey(it) }
        assertEquals(emptyList<String>(), missed)
    }

    @Test
    fun `the empty flag beside it, a toggle, the session and a cleared file are not`() {
        val steps = SyncTypes.ALL.first().key
        assertFalse(SyncSignal.isSyncKey(SyncStatus.emptyKey(steps)))
        assertFalse(SyncSignal.isSyncKey(steps))
        assertFalse(SyncSignal.isSyncKey("cookie"))
        assertFalse(SyncSignal.isSyncKey("person_timezone"))
        assertFalse(SyncSignal.isSyncKey(SyncStatus.lastKey("not_a_type")))
        assertFalse(SyncSignal.isSyncKey(null))
    }

    @Test
    fun `a started signal fires for a last-run write and for nothing else`() {
        val prefs = Listened()
        var fired = 0
        val signal = SyncSignal(prefs) { fired++ }
        signal.start()
        val key = SyncTypes.ALL.first().key

        prefs.changed(SyncStatus.emptyKey(key))
        prefs.changed("cookie")
        assertEquals(0, fired)

        prefs.changed(SyncStatus.lastKey(key))
        assertEquals(1, fired)
    }

    @Test
    fun `nothing is heard before start or after close`() {
        val prefs = Listened()
        var fired = 0
        val signal = SyncSignal(prefs) { fired++ }
        val last = SyncStatus.lastKey(SyncTypes.ALL.first().key)

        prefs.changed(last)
        assertEquals(0, fired)

        signal.start()
        assertTrue(prefs.listeners.isNotEmpty())
        signal.close()
        assertTrue("close left the listener registered", prefs.listeners.isEmpty())
        prefs.changed(last)
        assertEquals(0, fired)
    }
}
