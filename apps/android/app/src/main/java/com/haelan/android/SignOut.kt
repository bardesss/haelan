package com.haelan.android

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/**
 * **The sign-out, in the order that makes it final whatever interrupts it.** Everything on the
 * phone goes first: every open glance is closed and the stored one deleted ([forgetGlances], on
 * [io], since the delete is disk), then the session, then the in-app page's web data. Only then
 * is the instance told ([sendLogout], which hands the POST to [SignOut.background] and returns at
 * once), and the person goes to sign-in ([goLogin]).
 *
 * The POST used to come first and the rest after it, all on the screen's scope. Back pressed
 * during a slow POST cancelled that scope once the IO block had closed every repository and
 * deleted the store, so the session was never cleared and the glance underneath sat on a closed
 * repository with nothing left to end its spinner. Now nothing waits on the instance, and the whole
 * of it runs under [NonCancellable]: a screen that goes mid-way still ends signed out.
 */
internal suspend fun signOutInOrder(
    io: CoroutineContext,
    forgetGlances: () -> Unit,
    clearSession: () -> Unit,
    clearWebData: () -> Unit,
    sendLogout: () -> Unit,
    goLogin: () -> Unit,
) = withContext(NonCancellable) {
    withContext(io) { forgetGlances() }
    clearSession()
    clearWebData()
    sendLogout()
    goLogin()
}

/** What outlives the screen that signed out. */
internal object SignOut {
    /**
     * The logout POST's scope: the application's lifetime, never cancelled, so the instance hears of
     * the sign-out even when the screen that asked for it is gone. Best effort by construction: the
     * client returns a failure rather than throwing it, and the session is already gone either way.
     */
    val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)
}
