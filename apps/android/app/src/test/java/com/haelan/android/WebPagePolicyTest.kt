package com.haelan.android

import org.junit.Assert.assertEquals
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
    fun `the session cookie is the one the instance reads, for the whole site`() {
        assertEquals("haelan_session=abc; Path=/", WebPagePolicy.sessionCookie(server, "abc"))
    }

    @Test
    fun `over https the session cookie is never sent in the clear`() {
        assertEquals("haelan_session=abc; Path=/; Secure", WebPagePolicy.sessionCookie("https://haelan.example", "abc"))
        assertEquals("haelan_session=abc; Path=/; Secure", WebPagePolicy.sessionCookie("HTTPS://haelan.example", "abc"))
    }
}
