package com.haelan.android.glance

import com.haelan.android.InstanceClient
import org.json.JSONObject

/**
 * The three reads the glance makes: today, a finished day, and a month of the calendar.
 *
 * Each answer comes back as a case the screen can draw, not as a status code: 401 is "sign in
 * again", a 404 on the today route is an instance older than the glance, a 404 on a past day names
 * the day to open instead, and a 400 carries the instance's own sentence. The body of a good
 * answer is returned as text; reading it is the parser's job, so this layer stays about HTTP.
 *
 * No date is computed here. The day and the month come from a payload the instance already sent,
 * and are passed through as given.
 *
 * [transport] is [InstanceClient.get] in the app; a test can hand in anything of the same shape.
 */
class GlanceClient(
    private val server: String,
    private val personId: String,
    private val cookie: String,
    private val transport: Transport = Transport { server, path, cookie, headers ->
        InstanceClient.get(server, path, cookie, headers) { it }
    },
) {

    /** One GET, answering the whole [InstanceClient.Reply] so each read can decide for itself. */
    fun interface Transport {
        fun get(
            server: String,
            path: String,
            cookie: String?,
            headers: Map<String, String>,
        ): InstanceClient.Outcome<InstanceClient.Reply>
    }

    /** What a glance read came to. */
    sealed interface GlanceRead {
        /** A body to parse, and the ETag to send next time so an unchanged glance costs a 304. */
        data class Fresh(val json: String, val etag: String?) : GlanceRead

        /** The glance on screen is still current. */
        data object NotModified : GlanceRead

        /** The session is gone; the person has to sign in again. */
        data object Unauthorised : GlanceRead

        /** The instance has no glance route: it predates the glance, and wants updating. */
        data object TooOld : GlanceRead

        /** That day has no data; the instance names the nearest one that does. */
        data class Nearest(val localDate: String) : GlanceRead

        /** The instance refused the request, in its own words. */
        data class Refused(val message: String) : GlanceRead

        /** No answer this layer can use: no connection, or a status nobody asked it to name. */
        data class Unreachable(val cause: Throwable) : GlanceRead
    }

    /** What a calendar read came to; the same cases as [GlanceRead] where they can happen. */
    sealed interface CalendarRead {
        data class Fresh(val json: String) : CalendarRead
        data object Unauthorised : CalendarRead
        data object TooOld : CalendarRead
        data class Refused(val message: String) : CalendarRead
        data class Unreachable(val cause: Throwable) : CalendarRead
    }

    private val base = "/api/v1/p/$personId/glance"

    /**
     * Today's glance. With [etag], the instance answers 304 when nothing changed, which is what
     * lets the screen ask again often without moving the whole body every time.
     */
    fun today(etag: String?): GlanceRead {
        val headers = if (etag != null) mapOf("If-None-Match" to etag) else emptyMap()
        return glance(base, headers, dayRoute = false)
    }

    /**
     * A finished day's glance, for [localDate] exactly as a payload named it. No ETag: a past day
     * is read when the person asks for it, and there is no copy on screen to compare against.
     */
    fun day(localDate: String): GlanceRead = glance("$base?day=$localDate", emptyMap(), dayRoute = true)

    /** One month of the calendar, [month] as `YYYY-MM` from the payload. */
    fun calendar(month: String): CalendarRead =
        when (val outcome = transport.get(server, "$base/calendar?month=$month", cookie, emptyMap())) {
            is InstanceClient.Outcome.Ok -> CalendarRead.Fresh(outcome.value.body)
            is InstanceClient.Outcome.Failed -> when (statusOf(outcome.error)) {
                401 -> CalendarRead.Unauthorised
                404 -> CalendarRead.TooOld
                400 -> CalendarRead.Refused(messageOf(outcome.error))
                else -> CalendarRead.Unreachable(outcome.error)
            }
        }

    private fun glance(path: String, headers: Map<String, String>, dayRoute: Boolean): GlanceRead =
        when (val outcome = transport.get(server, path, cookie, headers)) {
            is InstanceClient.Outcome.Ok -> {
                val reply = outcome.value
                if (reply.status == InstanceClient.NOT_MODIFIED) {
                    GlanceRead.NotModified
                } else {
                    GlanceRead.Fresh(reply.body, reply.header("etag"))
                }
            }
            is InstanceClient.Outcome.Failed -> when (statusOf(outcome.error)) {
                401 -> GlanceRead.Unauthorised
                // A 404 with a day in it is the instance naming where to go. One without is the
                // route itself missing, which on a past day means the same as on today.
                404 -> nearestOf(outcome.error)?.takeIf { dayRoute }?.let { GlanceRead.Nearest(it) }
                    ?: GlanceRead.TooOld
                400 -> GlanceRead.Refused(messageOf(outcome.error))
                else -> GlanceRead.Unreachable(outcome.error)
            }
        }

    /** The status of an answer the instance gave, or null when there was no answer at all. */
    private fun statusOf(error: Exception): Int? = (error as? InstanceClient.InstanceHttpException)?.status

    /** `{ "nearest": "YYYY-MM-DD" }`, or null for any other body, including a null day. */
    private fun nearestOf(error: Exception): String? {
        val answer = (error as? InstanceClient.InstanceHttpException)?.answer ?: return null
        val json = runCatching { JSONObject(answer) }.getOrNull() ?: return null
        if (json.isNull("nearest")) return null
        return json.optString("nearest").takeIf { it.isNotEmpty() }
    }

    /**
     * The sentence in the instance's error envelope, `{ "error": { "message": … } }`. A body that is
     * not that envelope - a proxy's page, say - is passed on as it came, since it is still the
     * only account of what went wrong.
     */
    private fun messageOf(error: Exception): String {
        val answer = (error as? InstanceClient.InstanceHttpException)?.answer ?: return error.message ?: ""
        val message = runCatching { JSONObject(answer).getJSONObject("error").getString("message") }.getOrNull()
        return message ?: answer
    }
}
