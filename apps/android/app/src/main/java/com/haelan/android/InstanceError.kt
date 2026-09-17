package com.haelan.android

import org.json.JSONException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Why an exchange with the instance produced no answer, as the sentence that says so.
 *
 * Every failure used to read "the instance did not answer", which is the same sentence for a
 * typo in the address, a stopped instance, a certificate the phone refuses and a page that is
 * not haelan at all. They need different things from the person, so the reason is decided here,
 * in a file with no Android in it, and the screens only choose where to print it (A-18).
 */
object InstanceError {

    /** The message for an answer the sync cannot use. 401 is the caller's own case. */
    fun forStatus(code: Int): Int = when (code) {
        // The session is valid and belongs to somebody else: the route says not_your_person.
        403 -> R.string.error_not_your_person
        413 -> R.string.error_too_large
        else -> R.string.error_instance
    }

    /**
     * What the login screen prints for a failed exchange. 401 there is wrong credentials,
     * never a broken instance: a wrong password, an unknown username, or no account at all
     * yet on a fresh instance. The sync reads the same status as its own case (the session
     * is over), so the rule lives on the caller that owns it rather than in forThrowable,
     * which both screens share. Anything else is the same reason the sync would print.
     */
    fun forLogin(error: Throwable): Int {
        if (error is InstanceClient.InstanceHttpException && error.status == 401) {
            return R.string.login_failed
        }
        return forThrowable(error)
    }

    /** The message for an exchange that threw instead of answering. */
    fun forThrowable(error: Throwable): Int = when (error) {
        // An answer with a status this app cannot use carries its own reason, so it is decided
        // here rather than falling through to the generic sentence below.
        is InstanceClient.InstanceHttpException -> forStatus(error.status)
        is UnknownHostException -> R.string.error_unknown_host
        is ConnectException -> R.string.error_refused
        is SocketTimeoutException -> R.string.error_timeout
        // Checked before the generic IOException below, which an SSL failure also is.
        is SSLException -> R.string.error_certificate
        is JSONException -> R.string.error_not_instance
        // A reset or a truncated answer is its own sentence: nothing was listening is wrong for
        // a connection that got as far as answering halfway.
        else -> R.string.error_broken
    }
}
