package com.haelan.android

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView

/**
 * What the in-app web page (WebPageActivity) leaves on the phone: the session cookie it was handed,
 * whatever the web app keeps in its own storage, and the view's HTTP cache. All of it belongs to
 * the person signed in, so it goes when they sign out and when somebody else signs in on this phone,
 * and nobody's web storage survives into another person's session.
 */
object WebData {

    /** Whose the web data is, in the same shape the stored timezone is kept against. */
    fun owner(server: String, personId: String): String = "$personId@$server"

    /**
     * Whether signing in as [personId] on [server] hands the web data to somebody else. Nothing on
     * record counts as somebody else: an app upgraded from before the record, or a phone signed out
     * of, has nothing to lose by clearing it.
     */
    fun changesHands(previousOwner: String?, server: String, personId: String): Boolean =
        previousOwner != owner(server, personId)

    /**
     * Forgets the cookies, the web app's storage and the view's cache. On the main thread, where
     * CookieManager and a WebView want to be called; the cookie removal is asynchronous, and the
     * next cookie set (a card opened after sign-in) is ordered after it.
     *
     * The cache is cleared through a view made for the purpose because the platform offers no other
     * handle on it; the cache is shared by every view in the app, so clearing one clears it.
     *
     * Each step on its own ([clearEach]): CookieManager.getInstance() and a new WebView throw while
     * the WebView provider is updating or missing, and a sign-in or sign-out that stopped there
     * would leave somebody half signed in over a browser part nobody asked about.
     */
    fun clear(context: Context, log: (String) -> Unit = { Log.w(TAG, it) }) = clearEach(
        listOf(
            "cookies" to {
                val cookies = CookieManager.getInstance()
                cookies.removeAllCookies { cookies.flush() }
            },
            "web storage" to { WebStorage.getInstance().deleteAllData() },
            "cache" to {
                WebView(context).apply {
                    clearCache(true)
                    destroy()
                }
            },
        ),
        log,
    )

    /** Runs every step, in order, whichever of them throws; a throw is logged by the step's name. */
    internal fun clearEach(steps: List<Pair<String, () -> Unit>>, log: (String) -> Unit) {
        for ((name, step) in steps) {
            runCatching(step).onFailure { log("could not clear the web page's $name: $it") }
        }
    }

    private const val TAG = "haelan-web"
}
