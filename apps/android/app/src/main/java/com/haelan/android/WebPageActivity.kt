package com.haelan.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import com.haelan.android.glance.ui.GlanceTheme

/**
 * The web page behind a card or a workout row, inside the app and signed in: the glance copies the
 * dashboard, and everything past it (a night, the recovery page, a workout) is the web app itself.
 *
 * The web app is a single-page app, so a client route such as `/sleep/night/2026-09-20` loads
 * through the server's fallback and every navigation after it stays on the instance's origin.
 * [WebPagePolicy] holds the rule for everything else: another web origin opens in the browser, which
 * never saw the session, and anything that is not the web is refused.
 *
 * The session is the app's, handed over in the extras the glance passes to the sync screen, and set
 * as the instance's cookie before the page loads. It is not removed when this screen closes (the
 * next card opens signed in without it being set again for nothing); sign-out and a different
 * person signing in clear it, with the rest of what the view kept ([WebData]). A session the instance has let go shows the web app's own sign-in, which
 * this screen leaves alone.
 */
class WebPageActivity : ComponentActivity() {

    companion object {
        /** The web path to open, as a card names it: `/recovery`, `/activity/{sessionId}`. */
        const val EXTRA_PATH = "path"

        /** The top bar's title: the tapped card's heading, as the card shows it. */
        const val EXTRA_TITLE = "title"
    }

    private var web: WebView? = null

    /** Whether back walks the page's history; once it cannot, back leaves the screen. */
    private var canGoBack by mutableStateOf(false)

    // JavaScript is on because the web app is nothing without it, and the view only ever loads the
    // instance's own origin (WebPagePolicy); that origin is the one the person already trusts
    // with their session in a browser.
    @SuppressLint("SetJavaScriptEnabled")
    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val server = intent.getStringExtra(LoginActivity.EXTRA_SERVER).orEmpty()
        val cookie = intent.getStringExtra(LoginActivity.EXTRA_COOKIE).orEmpty()
        val url = WebPagePolicy.pageUrl(server, intent.getStringExtra(EXTRA_PATH).orEmpty())
        if (server.isEmpty() || cookie.isEmpty() || url == null) {
            finish()
            return
        }
        val pageTitle = WebPagePolicy.title(intent.getStringExtra(EXTRA_TITLE), getString(R.string.app_name))

        val view = WebView(this).apply {
            // The web app is a script and keeps its choices (the person picked in a picker, a
            // collapsed rail) in storage; without either it draws nothing.
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The page is the instance's, never a file or another app's content.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // The pages are health data and the instance sends its API answers without no-store,
            // so the view would otherwise keep them in its disk cache. Not reading the cache is
            // what this setting promises; a cache written anyway is cleared with the session
            // (WebData.clear). The cost is the web app's scripts fetched again per page, over a LAN.
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            // The web app has its own dark theme, chosen by prefers-color-scheme, which the view
            // takes from this app's DayNight theme. Darkening the light page by algorithm instead
            // would draw neither theme. Off is already the default for an app targeting 33 and up;
            // saying so keeps it off whatever a WebView update decides.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) settings.isAlgorithmicDarkeningAllowed = false
            webViewClient = PageClient(server)
        }
        web = view

        // The cookie first, and the page only once the cookie store has it: a load that raced the
        // set would ask as nobody and draw the web app's sign-in. flush() writes it to disk, so a
        // process restart with this screen on top still opens signed in.
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setCookie(server, WebPagePolicy.sessionCookie(server, cookie)) {
            cookies.flush()
            // A rotation or a process restart brings back the page history rather than the
            // first page again.
            if (web == null) return@setCookie
            if (savedInstanceState == null || view.restoreState(savedInstanceState) == null) view.loadUrl(url)
            canGoBack = view.canGoBack()
        }

        // Scaffold pads for the system bars itself, as on the glance.
        enableEdgeToEdge()
        setContent {
            GlanceTheme {
                // Back walks the page's history first; with none left the default back finishes.
                BackHandler(enabled = canGoBack) { web?.goBack() }
                val background = MaterialTheme.colorScheme.background.toArgb()
                Scaffold(
                    topBar = {
                        TopAppBar(
                            title = { Text(pageTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            // Up leaves the page for the glance, however deep the history is.
                            navigationIcon = {
                                IconButton(onClick = ::finish) {
                                    Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.web_page_up))
                                }
                            },
                        )
                    },
                ) { padding ->
                    AndroidView(
                        factory = { view },
                        // The page's own background arrives with its style sheet; until then the
                        // view is the app's page colour rather than a white flash in the dark.
                        update = { it.setBackgroundColor(background) },
                        modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
                    )
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web?.saveState(outState)
    }

    override fun onDestroy() {
        web?.let(::release)
        web = null
        super.onDestroy()
    }

    /** Out of the layout first: a view destroyed while still attached can leak its window. */
    private fun release(view: WebView) {
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private inner class PageClient(private val server: String) : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            val decision = WebPagePolicy.decide(server, url)
            if (WebPagePolicy.opensBrowser(decision, request.isForMainFrame)) openInBrowser(url)
            return WebPagePolicy.shouldOverride(decision)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            canGoBack = view.canGoBack()
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            canGoBack = view.canGoBack()
        }

        /**
         * The page's renderer died (out of memory, or killed). Returning false would take the whole
         * app down with it; the screen closes instead and the glance is back underneath.
         */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (web === view) {
                web = null
                release(view)
            }
            finish()
            return true
        }
    }

    /**
     * Another origin, in the browser. BROWSABLE, so only an app that offers itself for web links
     * can answer, not whatever claims the address; and a phone with none says nothing rather than
     * crash.
     */
    private fun openInBrowser(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            // Nothing to open it with: the link does nothing, as it would on a phone with no browser.
        }
    }
}
