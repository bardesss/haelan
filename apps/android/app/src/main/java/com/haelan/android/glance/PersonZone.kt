package com.haelan.android.glance

import org.json.JSONObject
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId

/**
 * The zone the glance reads its clock times in: the person's, as the instance keeps it, and the
 * phone's only until the instance has said. The glance payload names no zone (its dates are local
 * already), but a bed time, an as-of time, the "Shown from" line and the greeting are instants, and
 * the web reads them in the person's zone; a phone travelling in another zone must read the same.
 *
 * Pure, so the decisions it holds are tested without a phone: what the sign-in's `/api/auth/me`
 * answer says, which zone wins before and after it, and where the person's day ends.
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

    /**
     * How long from [nowMs] until the next local midnight in [zone]: when the glance on screen, if
     * it is today's, stops being today. From the start of the next day as the zone has it, so a day
     * the clocks change on is 23 or 25 hours long rather than a fixed 24.
     */
    fun untilNextMidnight(nowMs: Long, zone: ZoneId): Long {
        val next = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone)
        return next.toInstant().toEpochMilli() - nowMs
    }

    /** Whether [aMs] and [bMs] fall on the same calendar day in [zone]. */
    fun sameDay(aMs: Long, bMs: Long, zone: ZoneId): Boolean =
        Instant.ofEpochMilli(aMs).atZone(zone).toLocalDate() == Instant.ofEpochMilli(bMs).atZone(zone).toLocalDate()

    private fun known(id: String): Boolean = try {
        ZoneId.of(id)
        true
    } catch (e: DateTimeException) {
        false
    }
}
