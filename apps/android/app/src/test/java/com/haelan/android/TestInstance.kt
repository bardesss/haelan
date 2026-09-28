package com.haelan.android

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException

/**
 * A real HTTP server on 127.0.0.1 and a port the system picks, answering every request with
 * whatever the test set last. Real because the cases worth pinning live in the platform's
 * HttpURLConnection - whether a 304 throws, whether a header arrives, which stream an error body
 * comes out of - and a fake transport would answer all of them by assumption.
 *
 * Written on a bare ServerSocket rather than the JDK's com.sun.net.httpserver, because a unit test
 * here compiles against android.jar, which does not carry that package. It speaks just enough
 * HTTP/1.1 for one request per connection: a request line, headers, a Content-Length body, and an
 * answer with `Connection: close`.
 */
class TestInstance : Closeable {

    /** One request as it arrived: header names lower-cased, the query left on the path. */
    data class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String)

    @Volatile var status = 200
    @Volatile var body = ""
    @Volatile var headers: Map<String, String> = emptyMap()
    private val requests = mutableListOf<Request>()

    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))

    /** The address to hand a client, in the form the person types it. */
    val address: String = "http://127.0.0.1:${socket.localPort}"

    private val acceptor = Thread {
        while (!socket.isClosed) {
            val connection = try {
                socket.accept()
            } catch (_: SocketException) {
                break
            }
            connection.use { answer(it) }
        }
    }.apply {
        isDaemon = true
        start()
    }

    /** The one request this test made. */
    fun only(): Request = synchronized(requests) { requests.single() }

    override fun close() {
        socket.close()
        acceptor.join(2_000)
    }

    private fun answer(connection: Socket) {
        val input = BufferedInputStream(connection.getInputStream())
        val requestLine = input.line() ?: return
        val received = mutableMapOf<String, String>()
        while (true) {
            val line = input.line() ?: return
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) {
                val name = line.substring(0, colon).trim().lowercase()
                val value = line.substring(colon + 1).trim()
                received[name] = received[name]?.let { "$it, $value" } ?: value
            }
        }
        val length = received["content-length"]?.toIntOrNull() ?: 0
        val sent = ByteArray(length).also { var read = 0; while (read < length) read += input.read(it, read, length - read) }
        val (method, path) = requestLine.split(' ').let { it[0] to it[1] }
        synchronized(requests) { requests += Request(method, path, received, sent.toString(Charsets.UTF_8)) }

        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = StringBuilder("HTTP/1.1 $status Test\r\n")
        for ((name, value) in headers) head.append("$name: $value\r\n")
        // A 304 carries no body and no length; every other answer says how long its body is.
        if (status != 304) head.append("Content-Length: ${bytes.size}\r\n")
        head.append("Connection: close\r\n\r\n")
        val out = connection.getOutputStream()
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        if (status != 304) out.write(bytes)
        out.flush()
    }

    /** One CRLF-terminated line, without its terminator; null when the stream ended first. */
    private fun InputStream.line(): String? {
        val buffer = ByteArrayOutputStream()
        while (true) {
            val byte = read()
            if (byte == -1) return if (buffer.size() == 0) null else buffer.toString(Charsets.ISO_8859_1.name())
            if (byte == '\n'.code) return buffer.toString(Charsets.ISO_8859_1.name()).trimEnd('\r')
            buffer.write(byte)
        }
    }

    companion object {
        /** An address where nothing listens: a port the system handed out, then closed. */
        fun closedAddress(): String {
            val port = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1")).use { it.localPort }
            return "http://127.0.0.1:$port"
        }
    }
}
