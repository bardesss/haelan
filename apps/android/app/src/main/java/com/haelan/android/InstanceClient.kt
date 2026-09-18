package com.haelan.android

import java.net.HttpURLConnection
import java.net.URL

/**
 * The one place this app talks to an instance, because it used to be three.
 *
 * Two screens each carried their own copy of the same exchange - open the connection, set the two
 * timeouts, write the body, read the answer - and the copies had already drifted in what they did
 * with the status. The exchange is also where the answer is read, and reading it twice is the
 * defect this file exists to stop: `responseCode` asks the connection for its status, and asking it
 * again after the body has been taken can throw on a connection that has nothing left to say. One
 * read, and the status, the body and the cookies all come out of it together.
 *
 * There is no Apache HttpClient here and no OkHttp: this is a POST to one address the person typed,
 * optionally with a session cookie, and a client library would be a dependency to keep patched for
 * a call the platform already makes.
 */
object InstanceClient {

    // A home instance is a container on the same network, so this is generous rather than tight;
    // the point of both numbers is that neither is infinite. A request that hangs forever is the
    // failure nobody can describe, because the screen simply never changes.
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000

    /**
     * The session cookie the instance sets, spelled once: both the login screen that saves it and
     * anything that ever has to recognize it read the name from here rather than from a literal.
     */
    const val SESSION_COOKIE = "haelan_session"

    /**
     * The Cookie header for a stored session value. The name rides with it: the instance reads
     * `request.cookies[SESSION_COOKIE]`, so a bare value authenticates nothing and every call
     * after login answers 401. Found on the wire, where the same id answered 200 named and
     * 401 bare.
     */
    fun cookieHeader(sessionCookie: String) = "$SESSION_COOKIE=$sessionCookie"

    /** What the instance answered: its status, its body, and every cookie it set. */
    data class Reply(val status: Int, val body: String, val cookies: Map<String, String>) {
        fun cookie(name: String): String? = cookies[name]
    }

    /**
     * The outcome of an exchange, as a value rather than an exception. A status the caller has to
     * decide about is not an error the platform threw: 401 means "sign in again" to the sync and
     * "these credentials are wrong" to the login screen, and a client that threw on the first
     * would be making that choice for both.
     */
    sealed interface Outcome<out T> {
        data class Ok<T>(val value: T) : Outcome<T>
        data class Failed(val error: Exception) : Outcome<Nothing>
    }

    /** An answer the app cannot use, carrying the status so a screen can name the case. */
    class InstanceHttpException(val status: Int, val answer: String) : Exception("$status: $answer")

    /**
     * One JSON POST. [parse] runs on a 200 and returns what this caller cares about, which is the
     * whole point of the shape: the ingest calls it for nothing and the login for the person id,
     * and neither builds a connection of its own.
     *
     * Everything is opened, used and disconnected inside this call. A connection left open holds
     * its socket until the read timeout expires, which is how "the sync is slow" becomes true for
     * a request that has already been answered.
     */
    /**
     * One JSON GET. The cursors call reads through here: a cursor fetch that fails
     * is not a sync failure, the caller falls back to the full window instead.
     */
    fun <T> get(
        server: String,
        path: String,
        cookie: String? = null,
        parse: (Reply) -> T,
    ): Outcome<T> {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$server$path").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            if (cookie != null) connection.setRequestProperty("Cookie", cookieHeader(cookie))
            val status = connection.responseCode
            val reply = Reply(status, connection.readOnce(status), connection.cookiesOf())
            if (status == 200) Outcome.Ok(parse(reply)) else Outcome.Failed(InstanceHttpException(status, reply.body))
        } catch (e: Exception) {
            Outcome.Failed(e)
        } finally {
            connection?.disconnect()
        }
    }

    fun <T> post(
        server: String,
        path: String,
        body: String,
        cookie: String? = null,
        parse: (Reply) -> T,
    ): Outcome<T> {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$server$path").openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Content-Type", "application/json")
            // No Origin header on purpose: the server's origin check passes requests that
            // carry none, the same way its own tests reach mutating routes without one.
            if (cookie != null) connection.setRequestProperty("Cookie", cookieHeader(cookie))
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            // Once. Everything below reads what this returned rather than asking again.
            val status = connection.responseCode
            val reply = Reply(status, connection.readOnce(status), connection.cookiesOf())
            if (status == 200) Outcome.Ok(parse(reply)) else Outcome.Failed(InstanceHttpException(status, reply.body))
        } catch (e: Exception) {
            Outcome.Failed(e)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * The body of an answer already known to be an error, read for the log rather than for a
     * screen. A status with no body at all is a real answer - some proxies send one - so this
     * says "empty" instead of throwing on a null stream.
     */
    private fun HttpURLConnection.readOnce(status: Int): String {
        val stream = if (status < 400) inputStream else errorStream ?: return ""
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    /**
     * Every cookie this answer set, by name. The login screen needs the session one and the
     * server sets exactly that today, but a map costs nothing here and a second cookie later
     * would otherwise arrive as a screen silently reading the wrong header.
     */
    private fun HttpURLConnection.cookiesOf(): Map<String, String> {
        val jar = mutableMapOf<String, String>()
        for ((name, values) in headerFields ?: emptyMap()) {
            if (name == null || !name.equals("Set-Cookie", ignoreCase = true)) continue
            for (value in values ?: emptyList()) {
                val pair = value.substringBefore(";")
                val equals = pair.indexOf('=')
                if (equals > 0) jar[pair.substring(0, equals).trim()] = pair.substring(equals + 1).trim()
            }
        }
        return jar
    }
}
