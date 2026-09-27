package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page behind a card is the instance's own page, signed in with the app's session, so which
 * addresses the view will load is the whole of what keeps that session on the instance. A link to
 * anywhere else goes to the browser, which never saw the cookie; a script or an inline document is
 * neither loaded nor handed on.
 */
class WebPagePolicyTest {

    private val server = "http://nas:4235"

    @Test
    fun `a page on the instance stays in the view`() {
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide(server, "http://nas:4235/sleep/night/2026-09-20"))
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide(server, "http://nas:4235/activity?week=1#top"))
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide(server, "http://nas:4235"))
    }

    @Test
    fun `the same host on another port is another origin`() {
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(server, "http://nas:8080/recovery"))
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(server, "http://nas/recovery"))
    }

    @Test
    fun `the same host over the other scheme is another origin`() {
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(server, "https://nas:4235/recovery"))
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide("https://haelan.example", "http://haelan.example/recovery"))
    }

    @Test
    fun `another host goes to the browser`() {
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(server, "https://github.com/Bardesss/haelan"))
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(server, "http://nas.evil:4235/"))
    }

    @Test
    fun `a default port written out is the same origin as one left off`() {
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide("https://haelan.example", "https://haelan.example:443/activity"))
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide("http://nas:80", "http://nas/activity"))
    }

    @Test
    fun `scheme and host are compared without regard to case`() {
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide(server, "HTTP://NAS:4235/recovery"))
    }

    @Test
    fun `an instance under a path is still judged by its origin`() {
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide("https://haelan.example/nas", "https://haelan.example/nas/recovery"))
    }

    @Test
    fun `a script or an inline document is refused, never loaded and never handed on`() {
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "javascript:alert(document.cookie)"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "JavaScript:void(0)"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "data:text/html,<p>hi</p>"))
    }

    @Test
    fun `only the web goes to the browser, every other scheme is refused`() {
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "file:///sdcard/x.html"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "intent://scan/#Intent;scheme=zxing;end"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "content://com.haelan.android/x"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "mailto:someone@example.com"))
    }

    @Test
    fun `an address that cannot be read is refused`() {
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http://nas:4235/a b"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http:///recovery"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, ""))
    }

    @Test
    fun `the page for a card is the instance address and the card's path`() {
        assertEquals("http://nas:4235/sleep/night/2026-09-20", WebPagePolicy.pageUrl(server, "/sleep/night/2026-09-20"))
        assertEquals("https://haelan.example/nas/activity/abc", WebPagePolicy.pageUrl("https://haelan.example/nas", "/activity/abc"))
    }

    @Test
    fun `a path that does not start at the root makes no page`() {
        assertEquals(null, WebPagePolicy.pageUrl(server, "evil.example/recovery"))
        assertEquals(null, WebPagePolicy.pageUrl(server, "@evil.example/recovery"))
        assertEquals(null, WebPagePolicy.pageUrl(server, "//evil.example/recovery"))
        assertEquals(null, WebPagePolicy.pageUrl(server, ""))
    }

    @Test
    fun `a page the view would refuse is not a page either`() {
        assertEquals(null, WebPagePolicy.pageUrl(server, "/a b"))
        assertEquals(null, WebPagePolicy.pageUrl("", "/recovery"))
    }

    @Test
    fun `the session cookie is the one the instance sets, for the whole site, out of a script's reach`() {
        // The attributes of apps/server/src/auth/cookie.ts: HttpOnly and SameSite=Lax as there.
        assertEquals("haelan_session=abc; Path=/; HttpOnly; SameSite=Lax", WebPagePolicy.sessionCookie(server, "abc"))
    }

    @Test
    fun `over https the session cookie is never sent in the clear`() {
        assertEquals("haelan_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure", WebPagePolicy.sessionCookie("https://haelan.example", "abc"))
        assertEquals("haelan_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure", WebPagePolicy.sessionCookie("HTTPS://haelan.example", "abc"))
    }

    @Test
    fun `only the instance's own page is left to the view`() {
        assertFalse(WebPagePolicy.shouldOverride(WebPagePolicy.Decision.Stay))
        assertTrue(WebPagePolicy.shouldOverride(WebPagePolicy.Decision.External))
        assertTrue(WebPagePolicy.shouldOverride(WebPagePolicy.Decision.Refuse))
    }

    @Test
    fun `the browser opens only for the page itself going to another origin`() {
        assertTrue(WebPagePolicy.opensBrowser(WebPagePolicy.Decision.External, isForMainFrame = true))
        assertFalse(WebPagePolicy.opensBrowser(WebPagePolicy.Decision.External, isForMainFrame = false))
        assertFalse(WebPagePolicy.opensBrowser(WebPagePolicy.Decision.Refuse, isForMainFrame = true))
        assertFalse(WebPagePolicy.opensBrowser(WebPagePolicy.Decision.Stay, isForMainFrame = true))
    }

    @Test
    fun `the top bar reads the tapped card's heading, or the app's name without one`() {
        assertEquals("Recovery", WebPagePolicy.title("Recovery", "Hælan"))
        assertEquals("Hælan", WebPagePolicy.title(null, "Hælan"))
        assertEquals("Hælan", WebPagePolicy.title(" ", "Hælan"))
    }

    @Test
    fun `an instance reached by a container name with an underscore is an origin like any other`() {
        val docker = "http://haelan_server:4235"
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide(docker, "http://haelan_server:4235/recovery"))
        assertEquals(WebPagePolicy.Decision.Stay, WebPagePolicy.decide("http://Haelan_Server", "http://haelan_server:80/recovery"))
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(docker, "http://haelan_server:8080/recovery"))
        assertEquals(WebPagePolicy.Decision.External, WebPagePolicy.decide(docker, "http://other_server:4235/recovery"))
        assertEquals("http://haelan_server:4235/activity/abc", WebPagePolicy.pageUrl(docker, "/activity/abc"))
    }

    @Test
    fun `an underscore host is read strictly, so a malformed one is still no origin`() {
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http://haelan_server:4235:1/"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http://haelan_server:99999/"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http://_haelan:4235/"))
        assertEquals(WebPagePolicy.Decision.Refuse, WebPagePolicy.decide(server, "http://haelan_server:/"))
    }
}
