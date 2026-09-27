package com.haelan.android.glance

import org.json.JSONObject
import java.time.DateTimeException
import java.time.ZoneId

/**
 * The zone the glance reads its clock times in: the person's, as the instance keeps it, and the
 * phone's only until the instance has said. The glance payload names no zone (its dates are local
 * already), but a bed time, an as-of time, the "Shown from" line and the greeting are instants, and
 * the web reads them in the person's zone; a phone travelling in another zone must read the same.
 *
 * Pure, so the two decisions it holds are tested without a phone: what the sign-in's `/api/auth/me`
 * answer says, and which zone wins before and after it.
 */
object PersonZone {

    /** The session route; it answers `timezone` for the browser's today, and the glance reads it too. */
    const val ME_PATH = "/api/auth/me"

    /**
     * The zone id in a `/api/auth/me` body, or null when the body is not JSON, has no `timezone`, or
     * names a zone this phone's tz database does not know (a newer server's name, say), since a zone
     * the phone cannot read is no better than having none.
     */
    fun parseMe(json: String): String? {
        val raw = runCatching { JSONObject(json) }.getOrNull()?.takeUnless { it.isNull("timezone") }?.optString("timezone")
        return raw?.takeIf { it.isNotEmpty() && known(it) }
    }

    /** [stored] when it names a zone this phone knows, [fallback] (the phone's own) otherwise. */
    fun choose(stored: String?, fallback: ZoneId): ZoneId =
        stored?.takeIf(::known)?.let(ZoneId::of) ?: fallback

    private fun known(id: String): Boolean = try {
        ZoneId.of(id)
        true
    } catch (e: DateTimeException) {
        false
    }
}
