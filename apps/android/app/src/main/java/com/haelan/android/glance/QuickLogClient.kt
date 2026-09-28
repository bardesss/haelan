package com.haelan.android.glance

import com.haelan.android.InstanceClient
import org.json.JSONArray
import org.json.JSONObject

/** What a tap on a chip answers that the sheet uses: the event's id, for Undo, and its kind. */
data class LoggedEvent(val id: String, val kind: String, val localDate: String)

/**
 * The log sheet's calls, as [LogSheetModel] needs them: the client in the app, a hand-written fake
 * in a test, so the sheet's orchestration is tested without a server underneath it.
 */
interface QuickLogCalls {
    fun dayLog(localDate: String): QuickLogClient.Answer<DayLog>
    fun tap(kind: String, day: String): QuickLogClient.Answer<LoggedEvent>
    fun undo(eventId: String): QuickLogClient.Answer<Unit>
    fun setMood(day: String, score: Int?): QuickLogClient.Answer<Unit>
    fun savePresets(kinds: List<String>): QuickLogClient.Answer<List<String>>
    fun saveNote(day: String, body: String): QuickLogClient.Answer<Unit>
}

/**
 * The log sheet's reads and writes (M9c's routes): a stepped day's log, a tap and its undo, the
 * mood, the chips and the note. The web's useQuickLog.ts sends the same requests; this is its phone
 * copy, and like it decides nothing about time: a tap names the day and the route picks the moment.
 *
 * Every answer comes back as a case, not a status: 401 is the session gone, any refusal carrying
 * the instance's error envelope is its own sentence (the presets route's 400 names the first
 * problem with the list), and everything else, a proxy's page or no connection, is unreachable.
 *
 * The day log is read here rather than in [GlanceClient]: it belongs to the sheet, and the sheet's
 * one client follows the session's cookie for its reads and its writes alike.
 *
 * [transport] is [InstanceClient] in the app; a test can hand in anything of the same shape.
 */
class QuickLogClient(
    private val server: String,
    personId: String,
    private val cookie: String,
    private val transport: Transport = Transport { method, server, path, body, cookie ->
        when (method) {
            "GET" -> InstanceClient.get(server, path, cookie) { it }
            "POST" -> InstanceClient.post(server, path, body ?: "", cookie) { it }
            "PUT" -> InstanceClient.put(server, path, body ?: "", cookie) { it }
            else -> InstanceClient.delete(server, path, cookie) { it }
        }
    },
) : QuickLogCalls {

    /** One exchange, answering the whole [InstanceClient.Reply] so each call reads its own body. */
    fun interface Transport {
        fun send(
            method: String,
            server: String,
            path: String,
            body: String?,
            cookie: String?,
        ): InstanceClient.Outcome<InstanceClient.Reply>
    }

    /** What a call came to. */
    sealed interface Answer<out T> {
        data class Ok<T>(val value: T) : Answer<T>

        /** The instance refused, in its own words: the sentence to show where the write was made. */
        data class Refused(val message: String) : Answer<Nothing>

        /** The session is gone; the person has to sign in again. */
        data object Unauthorised : Answer<Nothing>

        /** No answer this layer can use: no connection, or a body that is not the route's. */
        data class Unreachable(val cause: Throwable) : Answer<Nothing>
    }

    private val base = "/api/v1/p/$personId"

    /** The log of [localDate], as the sheet names it after a step: GET /quick-log/day/{date}. */
    override fun dayLog(localDate: String): Answer<DayLog> =
        call("GET", "$base/quick-log/day/$localDate", null) { GlanceParser.parseDayLog(it) }

    /** One tap: POST /quick-log {kind, day}; the answer's id is what Undo deletes. */
    override fun tap(kind: String, day: String): Answer<LoggedEvent> {
        val body = JSONObject().put("kind", kind).put("day", day).toString()
        return call("POST", "$base/quick-log", body) {
            val json = JSONObject(it)
            LoggedEvent(json.getString("id"), json.getString("kind"), json.getString("localDate"))
        }
    }

    /** Undo: DELETE /events/{id}, the event the tap answered with. */
    override fun undo(eventId: String): Answer<Unit> = call("DELETE", "$base/events/$eventId", null) {}

    /** PUT /moods/{date} {score}, or DELETE when the mood is cleared back to no answer. */
    override fun setMood(day: String, score: Int?): Answer<Unit> =
        if (score == null) {
            call("DELETE", "$base/moods/$day", null) {}
        } else {
            call("PUT", "$base/moods/$day", JSONObject().put("score", score).toString()) {}
        }

    /** PUT /quick-log/presets {kinds}, replacing the list outright; answers the list as saved. */
    override fun savePresets(kinds: List<String>): Answer<List<String>> {
        val body = JSONObject().put("kinds", JSONArray(kinds)).toString()
        return call("PUT", "$base/quick-log/presets", body) { text ->
            val saved = JSONObject(text).getJSONArray("kinds")
            (0 until saved.length()).map { saved.getString(it) }
        }
    }

    /**
     * PUT /notes/{date} {body}, or DELETE when the field is blank: the route refuses an empty body,
     * and an emptied note is the reader removing it (the web's useSaveNote, the same convention).
     */
    override fun saveNote(day: String, body: String): Answer<Unit> =
        if (body.isBlank()) {
            call("DELETE", "$base/notes/$day", null) {}
        } else {
            call("PUT", "$base/notes/$day", JSONObject().put("body", body).toString()) {}
        }

    private fun <T> call(method: String, path: String, body: String?, read: (String) -> T): Answer<T> =
        when (val outcome = transport.send(method, server, path, body, cookie)) {
            is InstanceClient.Outcome.Ok -> try {
                Answer.Ok(read(outcome.value.body))
            } catch (e: Exception) {
                // A 200 whose body is not the route's: an instance or a proxy this app cannot read.
                Answer.Unreachable(e)
            }
            is InstanceClient.Outcome.Failed -> {
                val error = outcome.error
                val http = error as? InstanceClient.InstanceHttpException
                val message = http?.let { messageOf(it.answer) }
                when {
                    http?.status == 401 -> Answer.Unauthorised
                    message != null -> Answer.Refused(message)
                    else -> Answer.Unreachable(error)
                }
            }
        }

    /**
     * The sentence in the instance's error envelope, `{ "error": { "message": … } }`, or null for
     * any other body. Unlike the glance's reads, a body that is not the envelope is not passed on:
     * it would be shown under a chip or a face, and a proxy's HTML page is no sentence to show there.
     */
    private fun messageOf(answer: String): String? =
        runCatching { JSONObject(answer).getJSONObject("error").getString("message") }.getOrNull()
}
