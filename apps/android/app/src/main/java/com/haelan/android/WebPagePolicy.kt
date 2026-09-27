package com.haelan.android

import java.net.URI
import java.net.URISyntaxException

/**
 * Which addresses the in-app page loads, as a pure rule so a JVM test can hold it.
 *
 * The view carries the app's session cookie, so it stays on the instance's own origin: scheme, host
 * and port, compared the way a browser compares them. A link to any other web address is opened in
 * the browser, which never saw the cookie. Anything that is not the web (a `javascript:` or `data:`
 * address above all, which would run or draw inside the signed-in view, but also `intent:`, `file:`
 * and the rest) is refused outright: never loaded, and never handed to another app to resolve.
 *
 * `java.net.URI` rather than `android.net.Uri`, which is a stub under a unit test.
 */
object WebPagePolicy {

    enum class Decision {
        /** The instance's own page: load it in the view. */
        Stay,

        /** Another web origin: open it in the browser, without the session. */
        External,

        /** Not a web address, or not one that can be read: do nothing with it at all. */
        Refuse,
    }

    /**
     * What to do with [url], seen from the instance at [serverOrigin]. Only the address's origin
     * counts, so an instance reached under a path (`https://host/nas`) may be passed as it is.
     */
    fun decide(serverOrigin: String, url: String): Decision {
        val target = originOf(url) ?: return Decision.Refuse
        val home = originOf(serverOrigin) ?: return Decision.Refuse
        return if (target == home) Decision.Stay else Decision.External
    }

    /**
     * The address of the page behind a card: the instance address and the path the card names, or
     * null when that is not a page on the instance. The path must start at the root, since joined
     * onto `http://nas:4235` an `@evil.example/...` would name a different host; and `//` is refused
     * too, being another host in a browser's reading of a bare path.
     */
    fun pageUrl(server: String, path: String): String? {
        if (!path.startsWith("/") || path.startsWith("//")) return null
        val url = server.trimEnd('/') + path
        return url.takeIf { decide(server, it) == Decision.Stay }
    }

    /**
     * The cookie the view is handed before it loads anything: the name the instance reads, for the
     * whole site, and `Secure` when the instance is https so the view never sends it in the clear.
     * Over http it travels in the clear on the local network, as every request of the app does
     * (network_security_config.xml says why).
     */
    fun sessionCookie(server: String, cookie: String): String {
        val secure = server.trim().lowercase().startsWith("https://")
        return InstanceClient.cookieHeader(cookie) + "; Path=/" + if (secure) "; Secure" else ""
    }

    private data class Origin(val scheme: String, val host: String, val port: Int)

    private fun originOf(url: String): Origin? {
        val uri = try {
            URI(url.trim())
        } catch (e: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val defaultPort = when (scheme) {
            "http" -> 80
            "https" -> 443
            else -> return null
        }
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port == -1) defaultPort else uri.port
        return Origin(scheme, host, port)
    }
}
