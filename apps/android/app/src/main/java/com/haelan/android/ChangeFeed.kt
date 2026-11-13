package com.haelan.android

import android.content.SharedPreferences
import java.time.Instant

/** The Health Connect change token kept per owner and data type, and when a type may trust it. */
object ChangeFeed {

    sealed interface Mode {
        /** Read the changes since this token. */
        data class Drain(val token: String) : Mode

        /** No usable token: read records from this instant, and take a fresh token afterwards. */
        data class Bootstrap(val start: Instant) : Mode
    }

    /** A saved change token and the instance cursor the run that saved it started from. */
    data class Saved(val token: String, val cursorEndMs: Long?)

    /**
     * A token is drained only when the instance also holds the type. An instance that was reset
     * (or a type it never received) would otherwise only ever hear the changes made after the
     * token, and never the history behind them, so without a cursor the type bootstraps.
     *
     * Nor when the instance's cursor is now below the one the token was saved with: the instance
     * went back (a restore from backup), and the changes it lost are behind the token. A new
     * source lowering the type's minimum reads the same and costs one bootstrap. A token saved
     * before its cursor was kept beside it is trusted as before.
     */
    fun modeFor(saved: Saved?, cursorEndMs: Long?, fallbackStart: Instant, end: Instant): Mode =
        if (saved != null && cursorEndMs != null && (saved.cursorEndMs == null || cursorEndMs >= saved.cursorEndMs)) {
            Mode.Drain(saved.token)
        } else {
            Mode.Bootstrap(SyncCursors.bootstrapStartFor(cursorEndMs, fallbackStart, end))
        }

    fun cursorKeyFor(owner: String, dataTypeId: String): String = "changes_token_cursor|$owner|$dataTypeId"

    /**
     * A token Health Connect stopped honouring covers an unknown stretch of changes, so the type
     * reads everything the permission answers again rather than the thirty days [modeFor] gives a
     * type that merely has no token yet.
     */
    fun fallbackAfterExpiry(fallbackStart: Instant): Mode = Mode.Bootstrap(fallbackStart)

    fun keyFor(owner: String, dataTypeId: String): String = "changes_token|$owner|$dataTypeId"

    fun load(prefs: SharedPreferences, owner: String, dataTypeId: String): Saved? {
        val token = prefs.getString(keyFor(owner, dataTypeId), null) ?: return null
        val cursorKey = cursorKeyFor(owner, dataTypeId)
        return Saved(token, if (prefs.contains(cursorKey)) prefs.getLong(cursorKey, 0L) else null)
    }

    /** Saves [token] beside the instance cursor this run started from, which [modeFor] compares with the next. */
    fun save(prefs: SharedPreferences, owner: String, dataTypeId: String, token: String, cursorEndMs: Long?) {
        val edit = prefs.edit().putString(keyFor(owner, dataTypeId), token)
        if (cursorEndMs != null) edit.putLong(cursorKeyFor(owner, dataTypeId), cursorEndMs)
        else edit.remove(cursorKeyFor(owner, dataTypeId))
        edit.commit()
    }

    fun clear(prefs: SharedPreferences, owner: String, dataTypeId: String) {
        prefs.edit().remove(keyFor(owner, dataTypeId)).remove(cursorKeyFor(owner, dataTypeId)).commit()
    }
}
