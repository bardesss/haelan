package com.haelan.android

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

/**
 * The four ways an exchange fails need four sentences: a person reading "the instance did not
 * answer" cannot tell a typo from a stopped instance from a certificate the phone refuses, and
 * each of those is fixed somewhere else (A-18).
 */
class InstanceErrorTest {

    @Test
    fun everyFailureNamesItsOwnReason() {
        assertEquals(
            R.string.error_unknown_host,
            InstanceError.forThrowable(UnknownHostException("nas")),
        )
        assertEquals(R.string.error_refused, InstanceError.forThrowable(ConnectException("refused")))
        assertEquals(
            R.string.error_timeout,
            InstanceError.forThrowable(SocketTimeoutException("timed out")),
        )
        assertEquals(
            R.string.error_certificate,
            InstanceError.forThrowable(SSLHandshakeException("self signed certificate")),
        )
        assertEquals(
            R.string.error_not_instance,
            InstanceError.forThrowable(JSONException("not a haelan answer")),
        )
    }

    @Test
    fun theFourReasonsAreFourDifferentSentences() {
        val messages = listOf(
            InstanceError.forThrowable(UnknownHostException("nas")),
            InstanceError.forThrowable(ConnectException("refused")),
            InstanceError.forThrowable(SocketTimeoutException("timed out")),
            InstanceError.forThrowable(SSLHandshakeException("self signed certificate")),
            InstanceError.forThrowable(JSONException("not a haelan answer")),
        )
        assertEquals(messages.size, messages.toSet().size)
    }

    @Test
    fun anAnswerTheSyncCannotUseSaysWhichCaseItIs() {
        assertEquals(R.string.error_not_your_person, InstanceError.forStatus(403))
        assertEquals(R.string.error_too_large, InstanceError.forStatus(413))
        assertEquals(R.string.error_instance, InstanceError.forStatus(500))
    }

    /**
     * A status the app cannot use arrives as a failure from the client rather than as a throw
     * from the platform, so it has to reach the same sentence the status already had (T3.5).
     * Without this the 403 and the 413 would fall through to the generic "the instance answered"
     * and the two cases somebody can act on would be indistinguishable.
     */
    @Test
    fun aStatusTheClientCouldNotUseKeepsItsOwnSentence() {
        val forbidden = InstanceClient.InstanceHttpException(403, "not_your_person")
        val tooLarge = InstanceClient.InstanceHttpException(413, "too big")

        assertEquals(R.string.error_not_your_person, InstanceError.forThrowable(forbidden))
        assertEquals(R.string.error_too_large, InstanceError.forThrowable(tooLarge))
        assertEquals(R.string.error_instance, InstanceError.forThrowable(InstanceClient.InstanceHttpException(500, "")))
    }

    /**
     * A failure carries the status and the answer, because the log line is where the instance's
     * own words go: a screen shows a sentence a person can act on, and the answer here is what a
     * developer reads afterwards to find out which sentence was true.
     */
    @Test
    fun aRefusalCarriesWhatTheInstanceSaid() {
        val refused = InstanceClient.InstanceHttpException(400, "dataPoints must not be empty")

        assertEquals(400, refused.status)
        assertEquals("dataPoints must not be empty", refused.answer)
    }

    /**
     * 401 on the login screen is wrong credentials, never a broken instance: a wrong
     * password, an unknown username, or no account at all yet on a fresh instance. Found
     * on a phone, which printed "The instance answered %1$d." for it instead: the wrong
     * sentence, with its placeholder uninterpolated because the screen passed no argument.
     */
    @Test
    fun aWrongPasswordOnTheLoginScreenIsWrongCredentials() {
        assertEquals(
            R.string.login_failed,
            InstanceError.forLogin(InstanceClient.InstanceHttpException(401, "invalid username or password")),
        )
    }

    @Test
    fun otherAnswersKeepTheirOwnSentenceOnTheLoginScreenToo() {
        assertEquals(
            R.string.error_not_your_person,
            InstanceError.forLogin(InstanceClient.InstanceHttpException(403, "not_your_person")),
        )
        assertEquals(
            R.string.error_instance,
            InstanceError.forLogin(InstanceClient.InstanceHttpException(500, "")),
        )
        assertEquals(
            R.string.error_unknown_host,
            InstanceError.forLogin(UnknownHostException("nas")),
        )
    }
}
