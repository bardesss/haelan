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
     * Whether the view's shouldOverrideUrlLoading takes the navigation away from the view: every
     * decision but [Decision.Stay] does, the browser opening for one and nothing at all for the other.
     */
    fun shouldOverride(decision: Decision): Boolean = decision != Decision.Stay

    /**
     * Whether a navigation goes to the browser: another web origin, and only when it is the page
     * itself navigating. A frame inside the page pointing elsewhere is simply not loaded, rather
     * than a browser opening by surprise.
     */
    fun opensBrowser(decision: Decision, isForMainFrame: Boolean): Boolean = decision == Decision.External && isForMainFrame

    /**
     * The top bar's title: the heading of the card that was tapped, as the card shows it, or the
     * app's name when none came. Not the page's document title, which the web app never sets.
     */
    fun title(passed: String?, appName: String): String = passed?.takeIf { it.isNotBlank() } ?: appName

    /**
     * The cookie the view is handed before it loads anything, with the attributes the instance
     * gives its own (apps/server/src/auth/cookie.ts): the name it reads, for the whole site,
     * HttpOnly so no script on the page can read it, SameSite=Lax so another site cannot send it
     * with a request of its own, and `Secure` when the instance is https so the view never sends it
     * in the clear. Over http it travels in the clear on the local network, as every request of the
     * app does (network_security_config.xml says why).
     */
    fun sessionCookie(server: String, cookie: String): String {
        val secure = server.trim().lowercase().startsWith("https://")
        return InstanceClient.cookieHeader(cookie) + "; Path=/; HttpOnly; SameSite=Lax" + if (secure) "; Secure" else ""
    }

    /** The route that ends a session on the instance (apps/server/src/routes/auth.ts). */
    private const val LOGOUT_PATH = "/api/auth/logout"

    /**
     * The answer the view is given instead of the instance's to a sign-out: the instance's own error
     * envelope, so the web app shows it as it would any refusal.
     */
    const val SIGN_OUT_REFUSAL =
        """{"error":{"kind":"forbidden","code":"forbidden","message":"Sign out from the app's sync screen."}}"""

    /**
     * The view's user agent: the WebView's own with ` HaelanAndroid/<versionName>` after it, which
     * the web app reads to leave its Sign out out of the page (apps/web's isInAndroidApp).
     */
    fun userAgent(base: String, versionName: String): String = "$base HaelanAndroid/$versionName"

    /**
     * Whether a request the page makes is answered by the app instead of sent: a sign-out on the
     * instance's own origin. The page shares the app's session, so the web app's Sign out would end
     * the app's too; the web app hides it inside the app, and this is what holds if something calls
     * the route anyway. Any method, any query; an instance under a path is matched by the route's
     * end, since the web app calls it under the path it is served from.
     */
    fun blocksRequest(serverOrigin: String, url: String): Boolean {
        if (decide(serverOrigin, url) != Decision.Stay) return false
        val path = try {
            URI(url.trim()).normalize().path
        } catch (e: URISyntaxException) {
            return false
        } ?: return false
        return path.trimEnd('/').endsWith(LOGOUT_PATH)
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
        val (host, port) = if (!uri.host.isNullOrEmpty()) uri.host.lowercase() to uri.port
        else registryHostOf(uri.rawAuthority) ?: return null
        return Origin(scheme, host, if (port == -1) defaultPort else port)
    }

    /**
     * A self-hosted instance is often reached by its container's name, and Docker's names carry an
     * underscore (`http://haelan_server:4235`), which is not a hostname to `java.net.URI`: it keeps
     * the authority and gives no host. The authority is read here instead, strictly: letters,
     * digits, dots, dashes and underscores, an optional port, and nothing else, so credentials, a
     * second colon or an empty host still make no origin.
     */
    private fun registryHostOf(authority: String?): Pair<String, Int>? {
        val match = REGISTRY_AUTHORITY.matchEntire(authority ?: return null) ?: return null
        val port = match.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: -1
        if (port == 0 || port > 65535) return null
        return match.groupValues[1].lowercase() to port
    }

    private val REGISTRY_AUTHORITY = Regex("^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?$")
}
