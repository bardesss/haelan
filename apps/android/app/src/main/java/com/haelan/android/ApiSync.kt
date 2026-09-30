package com.haelan.android

import org.json.JSONObject

/**
 * The Health API sync button: asking the instance to run its own Google sync now, the same run the
 * web app's status panel starts (`POST /api/sync/run`, apps/server/src/routes/sync.ts).
 *
 * The route answers in four shapes, and two of them are "not now" rather than failures: a 429 names
 * when a retry would work (a run finished moments ago), and a 409 says a run is already going or the
 * instance is on its way down. So the answer is its own type instead of an [InstanceClient.Outcome].
 * SyncEngine's retry rule reads a 429 as weather and asks again, which is right for an ingest and
 * wrong here: a person tapped a button, and the honest reply is one line, once.
 */
object ApiSync {

    const val PATH = "/api/sync/run"

    /** The statuses this route answers with a meaning of their own; anything else is a failure. */
    internal val ANSWERS = setOf(202, 409, 429)

    /**
     * The two 409s that are the route's own. The setup gate answers 409 too, `setup_incomplete`,
     * for an instance whose wizard is not finished - a database restored without its key lands
     * there - and that is not a run already going, so it takes the error wording instead.
     */
    private val BUSY_CODES = setOf("already_running", "shutting_down")

    sealed interface Answer {
        /** 202: the instance started a run. */
        data object Started : Answer

        /** 429: a run finished moments ago; the instance names when another would start. */
        data class Cooldown(val seconds: Long) : Answer

        /** 409: a run is already going, or the instance is shutting down. */
        data object Busy : Answer

        /** Anything else, carried as the app's other exchanges carry it, for the same wording. */
        data class Failed(val error: Exception) : Answer
    }

    /**
     * What a reply from the route means. A 429 whose retry-after cannot be read has no number to
     * print, so it falls to the plain error wording rather than inventing one.
     */
    fun answerFor(reply: InstanceClient.Reply): Answer = when (reply.status) {
        202 -> Answer.Started
        409 -> if (codeOf(reply.body) in BUSY_CODES) Answer.Busy else failed(reply)
        429 -> reply.header("retry-after")?.trim()?.toLongOrNull()?.let { Answer.Cooldown(it) }
            ?: failed(reply)
        else -> failed(reply)
    }

    private fun failed(reply: InstanceClient.Reply) =
        Answer.Failed(InstanceClient.InstanceHttpException(reply.status, reply.body))

    /** `error.code` from the instance's one error shape (apps/server/src/api/envelope.ts). */
    private fun codeOf(body: String): String? = try {
        JSONObject(body).optJSONObject("error")?.optString("code")
    } catch (_: Exception) {
        null
    }

    /**
     * One tap: the line under the button is cleared before the request goes out, so the last
     * answer ("Google sync started") never stands beside a tap still waiting on its own. Inline, so
     * the screen's request can suspend inside it; the clearing is the part a test can hold.
     */
    inline fun tap(clearLine: () -> Unit, request: () -> Answer): Answer {
        clearLine()
        return request()
    }

    /**
     * The card's line for an answer, or null for a failure, which the screen words the way it words
     * every other failed exchange (SyncRun.reasonFor).
     */
    fun lineFor(answer: Answer): Int? = when (answer) {
        Answer.Started -> R.string.api_sync_started
        is Answer.Cooldown -> R.string.api_sync_cooldown
        Answer.Busy -> R.string.api_sync_busy
        is Answer.Failed -> null
    }
}
