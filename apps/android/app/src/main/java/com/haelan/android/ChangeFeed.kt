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

    /**
     * A token is drained only when the instance also holds the type. An instance that was reset
     * (or a type it never received) would otherwise only ever hear the changes made after the
     * token, and never the history behind them, so without a cursor the type bootstraps.
     */
    fun modeFor(token: String?, cursorEndMs: Long?, fallbackStart: Instant, end: Instant): Mode =
        if (token != null && cursorEndMs != null) Mode.Drain(token)
        else Mode.Bootstrap(SyncCursors.bootstrapStartFor(cursorEndMs, fallbackStart, end))

    /**
     * A token Health Connect stopped honouring covers an unknown stretch of changes, so the type
     * reads everything the permission answers again rather than the thirty days [modeFor] gives a
     * type that merely has no token yet.
     */
    fun fallbackAfterExpiry(fallbackStart: Instant): Mode = Mode.Bootstrap(fallbackStart)

    fun keyFor(owner: String, dataTypeId: String): String = "changes_token|$owner|$dataTypeId"

    fun load(prefs: SharedPreferences, owner: String, dataTypeId: String): String? =
        prefs.getString(keyFor(owner, dataTypeId), null)

    fun save(prefs: SharedPreferences, owner: String, dataTypeId: String, token: String) {
        prefs.edit().putString(keyFor(owner, dataTypeId), token).commit()
    }

    fun clear(prefs: SharedPreferences, owner: String, dataTypeId: String) {
        prefs.edit().remove(keyFor(owner, dataTypeId)).commit()
    }
}
