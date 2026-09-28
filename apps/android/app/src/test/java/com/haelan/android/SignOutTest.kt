package com.haelan.android

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The sign-out's order, and that a screen going mid-way cannot stop it short. The steps record
 * into one log, so the order is what is read.
 */
class SignOutTest {

    private val log = mutableListOf<String>()

    private suspend fun signOut(forget: () -> Unit = { log += "forget glances" }) = signOutInOrder(
        io = Dispatchers.Unconfined,
        forgetGlances = forget,
        clearSession = { log += "clear session" },
        clearWebData = { log += "clear web data" },
        sendLogout = { log += "send logout" },
        goLogin = { log += "go to sign-in" },
        log = { log += "logged: $it" },
    )

    @Test
    fun `a delete that throws is logged, and the session, the web data and sign-in still follow`() {
        runBlocking { signOut(forget = { throw IllegalStateException("keystore unavailable") }) }
        assertEquals(
            listOf(
                "logged: the glance could not be forgotten at sign-out: java.lang.IllegalStateException: keystore unavailable",
                "clear session", "clear web data", "send logout", "go to sign-in",
            ),
            log,
        )
    }

    @Test
    fun `the phone forgets everything before the instance is told, and sign-in comes last`() {
        runBlocking { signOut() }
        assertEquals(listOf("forget glances", "clear session", "clear web data", "send logout", "go to sign-in"), log)
    }

    @Test
    fun `a screen cancelled while the glances are forgotten still ends signed out, on sign-in`() {
        val io = Executors.newSingleThreadExecutor()
        val inForget = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            runBlocking {
                // Undispatched, as the screen starts it: running before this thread blocks below.
                val job = launch(start = CoroutineStart.UNDISPATCHED) {
                    signOutInOrder(
                        io = io.asCoroutineDispatcher(),
                        forgetGlances = {
                            inForget.countDown()
                            release.await(5, TimeUnit.SECONDS)
                            synchronized(log) { log += "forget glances" }
                        },
                        clearSession = { synchronized(log) { log += "clear session" } },
                        clearWebData = { synchronized(log) { log += "clear web data" } },
                        sendLogout = { synchronized(log) { log += "send logout" } },
                        goLogin = { synchronized(log) { log += "go to sign-in" } },
                    )
                }
                assertTrue(inForget.await(5, TimeUnit.SECONDS))
                // Back pressed: the screen's scope goes while the IO step is still under way.
                job.cancel()
                release.countDown()
                job.join()
            }
        } finally {
            io.shutdownNow()
        }
        assertEquals(listOf("forget glances", "clear session", "clear web data", "send logout", "go to sign-in"), log)
    }
}
