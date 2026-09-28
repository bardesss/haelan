package com.haelan.android.glance

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.ZoneId

/**
 * Waits for the person's midnight by the wall clock. A coroutine `delay` on the main thread counts
 * uptime (Handler.postDelayed), which stops while the phone is in deep sleep: one delay computed at
 * 23:00 for "one hour" can end the next morning, or the next evening, and the glance goes on calling
 * yesterday today until then. So the wait is cut into slices of at most [SLICE_MS], and each turn
 * reads [clock] again; after a sleep, the midnight that passed is seen within one slice of waking.
 *
 * The midnight waited for is kept across [run]s, so the screen coming back (which cancels the wait
 * and runs it again) finds a midnight that passed while it was asleep and fires at once, rather
 * than computing the next one from the new now and skipping it.
 *
 * [now] is the clock as of the last tick or [touch]: the screen reads the + from it, so the + is
 * redrawn at midnight itself, not at the next recomposition something else happens to cause.
 */
internal class MidnightTicker(
    private val clock: () -> Long,
    private val delay: suspend (Long) -> Unit,
) {
    companion object {
        /** The longest single wait: how late after waking a midnight slept through is noticed. */
        const val SLICE_MS = 60_000L

        /** The next wait from [nowMs] towards [targetMs]: at most a slice, and 0 once it has passed. */
        fun nextWait(nowMs: Long, targetMs: Long): Long = (targetMs - nowMs).coerceIn(0L, SLICE_MS)
    }

    private class Armed(val zone: ZoneId, val atMs: Long)

    /** The midnight being waited for, kept across runs; null once it has fired. */
    @Volatile
    private var armed: Armed? = null

    private val mutableNow = MutableStateFlow(clock())

    /** The wall clock as of the last midnight or [touch]. */
    val now: StateFlow<Long> = mutableNow.asStateFlow()

    /** Reads the clock into [now]: the screen came back, or a tap found the day over. */
    fun touch() {
        mutableNow.value = clock()
    }

    /**
     * Calls [fire] at each of the person's midnights in [zone], until cancelled. [now] moves first,
     * so the screen has already dropped the + by the time [fire] asks for the new day.
     */
    suspend fun run(zone: ZoneId, fire: suspend () -> Unit) {
        while (true) {
            val target = armed?.takeIf { it.zone == zone }?.atMs ?: arm(zone)
            while (true) {
                val wait = nextWait(clock(), target)
                if (wait == 0L) break
                delay(wait)
            }
            armed = null
            touch()
            fire()
        }
    }

    /** Keeps and returns the next midnight in [zone] from now. */
    private fun arm(zone: ZoneId): Long {
        val nowMs = clock()
        return (nowMs + PersonZone.untilNextMidnight(nowMs, zone)).also { armed = Armed(zone, it) }
    }
}
