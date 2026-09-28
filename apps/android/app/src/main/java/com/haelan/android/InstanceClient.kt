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
 * There is no Apache HttpClient here and no OkHttp: these are JSON calls to one address the person
 * typed, optionally with a session cookie, and a client library would be a dependency to keep
 * patched for calls the platform already makes.
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

    /** Not Modified: the answer to a conditional read whose copy is still current. */
    const val NOT_MODIFIED = 304

    /**
     * The Cookie header for a stored session value. The name rides with it: the instance reads
     * `request.cookies[SESSION_COOKIE]`, so a bare value authenticates nothing and every call
     * after login answers 401. Found on the wire, where the same id answered 200 named and
     * 401 bare.
     */
    fun cookieHeader(sessionCookie: String) = "$SESSION_COOKIE=$sessionCookie"

    /**
     * What the instance answered: its status, its body, every cookie it set, and its headers by
     * lower-case name. The names are folded because HTTP never cared about their case and the
     * platform hands them back however the server spelled them: the glance's `ETag` arrives as
     * `etag` from Fastify, and a reader looking up either spelling should find it.
     */
    data class Reply(
        val status: Int,
        val body: String,
        val cookies: Map<String, String>,
        val headers: Map<String, String> = emptyMap(),
    ) {
        fun cookie(name: String): String? = cookies[name]
        fun header(name: String): String? = headers[name.lowercase()]
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
     * One JSON GET. The cursors call reads through here: a cursor fetch that fails is not a sync
     * failure, the caller falls back to the full window instead.
     *
     * [headers] is for the glance, which sends `If-None-Match` with the ETag of what it already
     * shows. That is also the only way a 304 can arrive: the instance answers one only to a
     * request that asked for it, so the cursors call, which never does, keeps the 200-only answer
     * it always had.
     */
    fun <T> get(
        server: String,
        path: String,
        cookie: String? = null,
        headers: Map<String, String> = emptyMap(),
        parse: (Reply) -> T,
    ): Outcome<T> = exchange("GET", server, path, null, cookie, headers, parse)

    /**
     * One JSON POST. [parse] runs on a 200 and returns what this caller cares about, which is the
     * whole point of the shape: the ingest calls it for nothing and the login for the person id,
     * and neither builds a connection of its own.
     */
    fun <T> post(
        server: String,
        path: String,
        body: String,
        cookie: String? = null,
        parse: (Reply) -> T,
    ): Outcome<T> = exchange("POST", server, path, body, cookie, emptyMap(), parse)

    /** One JSON PUT, for the log sheet's writes; the same answer as [post]. */
    fun <T> put(
        server: String,
        path: String,
        body: String,
        cookie: String? = null,
        parse: (Reply) -> T,
    ): Outcome<T> = exchange("PUT", server, path, body, cookie, emptyMap(), parse)

    /** One DELETE, with no body: the instance's deletes name what they remove in the path. */
    fun <T> delete(
        server: String,
        path: String,
        cookie: String? = null,
        parse: (Reply) -> T,
    ): Outcome<T> = exchange("DELETE", server, path, null, cookie, emptyMap(), parse)

    /**
     * The exchange every verb shares. [parse] runs on a 200, and on a 304, which is an answer and
     * not a failure: "what you have is still current" is exactly what a conditional read asked to
     * hear, and it carries no body, so [Reply.body] is empty and [parse] reads the status instead.
     * Everything else is [Outcome.Failed] with the status, for the caller to decide about.
     *
     * Everything is opened, used and disconnected inside this call. A connection left open holds
     * its socket until the read timeout expires, which is how "the sync is slow" becomes true for
     * a request that has already been answered.
     */
    private fun <T> exchange(
        method: String,
        server: String,
        path: String,
        body: String?,
        cookie: String?,
        headers: Map<String, String>,
        parse: (Reply) -> T,
    ): Outcome<T> {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$server$path").openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            // No Origin header on purpose: the server's origin check passes requests that
            // carry none, the same way its own tests reach mutating routes without one.
            if (cookie != null) connection.setRequestProperty("Cookie", cookieHeader(cookie))
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            } else if (method == "DELETE") {
                // Android's HttpURLConnection gives every DELETE without a type of its own an
                // `application/x-www-form-urlencoded` one (a JVM's does not, which is why only the
                // emulator showed it). The instance has no parser for that type, so it refused
                // every Undo, mood clear and note clear. `text/plain` it parses, and an empty one
                // reads as nothing.
                connection.setRequestProperty("Content-Type", "text/plain")
            }

            // Once. Everything below reads what this returned rather than asking again.
            val status = connection.responseCode
            val reply = Reply(status, connection.readOnce(status), connection.cookiesOf(), connection.headersOf())
            if (status == 200 || status == NOT_MODIFIED) {
                Outcome.Ok(parse(reply))
            } else {
                Outcome.Failed(InstanceHttpException(status, reply.body))
            }
        } catch (e: Exception) {
            Outcome.Failed(e)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * The body of an answer, read once. For an error it is read for the log rather than for a
     * screen, and a status with no body at all is a real answer - some proxies send one - so this
     * says "empty" instead of throwing on a null stream. A 304 goes through the first branch and
     * reads as an empty body; InstanceClientHttpTest holds that against a real connection.
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

    /**
     * Every header by lower-case name, repeated ones joined with a comma as HTTP defines them.
     * The status line sits in the same map under a null name and is left out: the status already
     * has its own field.
     */
    private fun HttpURLConnection.headersOf(): Map<String, String> {
        val out = mutableMapOf<String, String>()
        for ((name, values) in headerFields ?: emptyMap()) {
            if (name == null || values == null) continue
            out[name.lowercase()] = values.joinToString(", ")
        }
        return out
    }
}
