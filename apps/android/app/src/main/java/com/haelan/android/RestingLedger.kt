package com.haelan.android

import android.content.SharedPreferences
import org.json.JSONObject
import java.time.Instant

/**
 * The resting heart rate readings this phone posted, by Health Connect record id, with the epoch
 * ms each was taken at. A resting day's point is named after the reading it kept
 * (DailyRestingHeartRate), and a change feed reports a deletion by that record id alone, so this
 * is what dates a deleted reading and lets its day be rebuilt (SyncEngine.rebuildStart). Kept per
 * instance and person, as RouteLedger is: another archive never received these points.
 */
object RestingLedger {

    /**
     * About five years of one reading a day from one source. With the history permission the
     * fallback start is the epoch, so pruning by age alone would never bound the ledger; an
     * entry dropped here only means a deletion that old is not dated, as with ids sent before
     * the ledger existed.
     */
    const val MAX_ENTRIES = 2_000

    private const val KEY_OWNER = "resting_ledger_owner"
    private const val KEY_SENT = "resting_ledger_sent"

    @Synchronized
    fun load(prefs: SharedPreferences, owner: String): Map<String, Long> {
        if (prefs.getString(KEY_OWNER, null) != owner) return emptyMap()
        val stored = prefs.getString(KEY_SENT, null) ?: return emptyMap()
        val json = JSONObject(stored)
        return json.keys().asSequence().associateWith { json.getLong(it) }
    }

    /**
     * Files [sent] once the instance accepted it, dropping every entry from before
     * [fallbackStart], which no rebuild may reach, and the oldest past [MAX_ENTRIES].
     */
    @Synchronized
    fun record(prefs: SharedPreferences, owner: String, sent: Map<String, Long>, fallbackStart: Instant) {
        if (sent.isEmpty()) return
        val floorMs = fallbackStart.toEpochMilli()
        val kept = (load(prefs, owner) + sent.filterKeys { it.isNotEmpty() })
            .filterValues { it >= floorMs }
            .entries
            .sortedByDescending { it.value }
            .take(MAX_ENTRIES)
        val json = JSONObject()
        for ((id, atMs) in kept) json.put(id, atMs)
        // commit rather than apply, as RouteLedger: the next load has to read this write.
        prefs.edit()
            .putString(KEY_OWNER, owner)
            .putString(KEY_SENT, json.toString())
            .commit()
    }
}
