package com.haelan.android.glance

import android.util.Log
import com.haelan.android.glance.GlanceClient.GlanceRead
import com.haelan.android.glance.GlanceUiState.Problem
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** Everything the glance screen draws, in one value. */
data class GlanceUiState(
    /** The finished day on screen, or the day being opened; null is today. */
    val shownDay: String?,
    /** The glance to draw; null when there has never been one to show. */
    val glance: Glance?,
    /** When [glance] was last confirmed by the instance: the "Shown from 07:42" line. */
    val fetchedAtMs: Long?,
    /** Whether the last read reached the instance. */
    val reachable: Boolean,
    /** A read is in flight: the day arrows wait for it. */
    val loading: Boolean,
    val problem: Problem?,
) {
    /** What the screen says instead of, or over, the cards. */
    sealed interface Problem {
        /** The instance has no glance route, or ignores `?day=`: it wants updating. */
        data object TooOld : Problem

        /** The instance refused today's glance, in its own words. */
        data class Refused(val message: String) : Problem

        /** The glance holds no value at all: the web's "Nothing here yet". */
        data object FirstRun : Problem
    }
}

/**
 * The web's first-run rule (Dashboard.tsx): no night, no heart rate, no workout, and none of the
 * six figures with a value. A workout alone is something to show, so it is not an empty page.
 */
internal fun holdsNoValue(glance: Glance): Boolean {
    val figures = listOf(
        glance.recovery.index, glance.recovery.restingHeartRate, glance.recovery.hrv,
        glance.recovery.respiratoryRate, glance.day.steps, glance.day.activeMinutes,
    )
    return glance.sleep == null && glance.day.heartRate.points.isEmpty() && glance.day.workouts.isEmpty() &&
        figures.all { it?.value == null }
}

/**
 * The glance screen's state machine: the stored glance at once, then the instance's answer, and the
 * day navigation on top of it. Pure: the reads, the store, the clock and the dispatcher are all
 * handed in, so the whole of it runs under a plain JUnit test.
 *
 * The reads block (they are [com.haelan.android.InstanceClient] calls), so [dispatcher] is IO in the
 * app. Each call starts a new read and numbers it; an answer that arrives after a later call is not
 * drawn, so a slow day the person already stepped away from cannot replace the one they are on.
 * Today's answer is still stored when it lands, since it is the truth about today whoever asked,
 * unless a today read started after it has already been kept: only the newest answer is kept, and
 * memory and disk are written together under one lock, so the file never holds an older glance than
 * the one in memory.
 *
 * The public methods are called from the main thread; [refresh] reads the state outside the lock,
 * which is only safe because nothing else calls them concurrently.
 *
 * **Sign-out closes the repository before deleting the store.** A blocking read cannot be
 * interrupted, so a today read in flight at sign-out can still answer 200 afterwards; [close] makes
 * sure that answer is never written, and deleting after it makes sure nothing written before stays.
 * Only the explicit sign-out deletes: a 401 leaves the record, which is keyed by server and person,
 * so the same person signing back in gets their glance back and anyone else never sees it.
 *
 * Nothing here computes a date: every day it asks for came from a payload, through the caller.
 */
class GlanceRepository(
    private val reads: GlanceReads,
    private val store: GlanceStore,
    private val server: String,
    private val personId: String,
    private val clock: () -> Long,
    dispatcher: CoroutineDispatcher,
    private val log: (String) -> Unit = { Log.w(TAG, it) },
) {

    private companion object {
        const val TAG = "haelan-glance"
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val mutableState = MutableStateFlow(
        GlanceUiState(shownDay = null, glance = null, fetchedAtMs = null, reachable = true, loading = false, problem = null),
    )
    val state: StateFlow<GlanceUiState> = mutableState.asStateFlow()

    // A channel, not a shared flow: the 401 can land before the screen collects, and must wait for it.
    private val signedOutEvents = Channel<Unit>(Channel.CONFLATED)

    /** Fires once when the instance answers 401: the session is gone, back to sign-in. */
    val signedOut: Flow<Unit> = signedOutEvents.receiveAsFlow()

    private val lock = Any()

    /** The number of the latest call; guarded by [lock]. */
    private var generation = 0

    /** Today's glance as last stored, so going back to today draws it without the disk; guarded by [lock]. */
    private var today: GlanceStore.Kept? = null

    /** The number of the latest today read started, and of the newest one kept; guarded by [lock]. */
    private var todayStarted = 0
    private var todayKept = 0

    /** Set by [close]: nothing is kept after it, in memory or on disk; guarded by [lock]. */
    private var closed = false

    /** Draws the stored glance, then asks the instance whether it is still current. */
    fun open() = start({ it.copy(loading = true) }) { gen ->
        val stored = store.load(server, personId)
        synchronized(lock) { if (today == null) today = stored }
        backToToday(gen)
    }

    /**
     * Asks again for what is on screen: today with its ETag, or the finished day being shown.
     * Pull to refresh, the return to the foreground, and a finished sync all land here.
     */
    fun refresh() {
        val day = state.value.shownDay
        start({ it.copy(loading = true) }) { gen -> if (day != null) readDay(gen, day, followNearest = true) else readToday(gen) }
    }

    /** Opens a finished day, [localDate] as a payload named it (`nav`, or the calendar). */
    fun showDay(localDate: String) = start({ it.copy(shownDay = localDate, loading = true) }) { gen ->
        readDay(gen, localDate, followNearest = true)
    }

    /** Back to today: the kept glance at once, then revalidated. */
    fun showToday() = start({ it.copy(shownDay = null, loading = true) }) { gen -> backToToday(gen) }

    /**
     * Stops every read in flight; the screen is gone, or the person is signing out. A read already
     * blocked in the client still returns, but its answer is no longer kept.
     */
    fun close() {
        synchronized(lock) { closed = true }
        scope.cancel()
    }

    /** Numbers a call, marks it pending on screen at once, and runs [block] on the dispatcher. */
    private fun start(pending: (GlanceUiState) -> GlanceUiState, block: (Int) -> Unit) {
        val gen = synchronized(lock) {
            mutableState.value = pending(mutableState.value)
            ++generation
        }
        scope.launch { block(gen) }
    }

    /** Applies [change] only while [gen] is still the latest call. */
    private fun emit(gen: Int, change: (GlanceUiState) -> GlanceUiState) = synchronized(lock) {
        if (gen == generation) mutableState.value = change(mutableState.value)
    }

    private fun problemOf(glance: Glance?): Problem? =
        if (glance != null && holdsNoValue(glance)) Problem.FirstRun else null

    /** The day a glance is shown as: its own when finished, today (null) otherwise, as the web has it. */
    private fun shownDayOf(glance: Glance?): String? = glance?.takeIf { it.finished }?.today

    /** A read that got no usable answer: whatever is on screen stays, under its own day. */
    private fun unreachable(gen: Int) = emit(gen) {
        it.copy(shownDay = shownDayOf(it.glance), reachable = false, loading = false)
    }

    private fun signOut(gen: Int) {
        signedOutEvents.trySend(Unit)
        emit(gen) { it.copy(loading = false) }
    }

    private fun backToToday(gen: Int) {
        val kept = synchronized(lock) { today }
        emit(gen) {
            it.copy(shownDay = null, glance = kept?.glance, fetchedAtMs = kept?.fetchedAtMs, loading = true, problem = problemOf(kept?.glance))
        }
        readToday(gen)
    }

    private fun readToday(gen: Int) {
        val (etag, seq) = synchronized(lock) { today?.etag to ++todayStarted }
        when (val read = reads.today(etag)) {
            is GlanceRead.Fresh -> {
                val glance = parseOrNull(read.json, "today") ?: return unreachable(gen)
                val kept = GlanceStore.Kept(glance, read.json, read.etag, clock())
                keep(kept, seq)
                emit(gen) {
                    GlanceUiState(
                        shownDay = null, glance = glance, fetchedAtMs = kept.fetchedAtMs,
                        reachable = true, loading = false, problem = problemOf(glance),
                    )
                }
            }
            GlanceRead.NotModified -> {
                val now = clock()
                // Only sent with an ETag, so there is a kept glance; the store learns the new instant
                // too, so "Shown from" after a reopen is the last time the instance was reached.
                val kept = synchronized(lock) { today }?.copy(fetchedAtMs = now)
                if (kept != null) keep(kept, seq)
                // The glance is confirmed current, so whatever an earlier answer said about the
                // instance (too old, refused) no longer holds: the problem is the glance's own again.
                emit(gen) {
                    it.copy(
                        fetchedAtMs = kept?.fetchedAtMs ?: it.fetchedAtMs, reachable = true, loading = false,
                        problem = problemOf(kept?.glance ?: it.glance),
                    )
                }
            }
            GlanceRead.Unauthorised -> signOut(gen)
            GlanceRead.TooOld -> emit(gen) { it.copy(reachable = true, loading = false, problem = Problem.TooOld) }
            is GlanceRead.Refused -> emit(gen) { it.copy(reachable = true, loading = false, problem = Problem.Refused(read.message)) }
            is GlanceRead.Nearest -> {
                // The client names a nearest day only on the day route; on today it cannot happen.
                log("today's glance answered with a nearest day, ${read.localDate}")
                unreachable(gen)
            }
            is GlanceRead.Unreachable -> unreachable(gen)
        }
    }

    /**
     * A finished day, read live and never stored. A day with no data is followed to the nearest day
     * the instance names, once: a nearest that names another nearest is a server going in circles,
     * and today is the one day that always answers. A refusal goes back to today too, as on the web.
     */
    private fun readDay(gen: Int, localDate: String, followNearest: Boolean) {
        when (val read = reads.day(localDate)) {
            is GlanceRead.Fresh -> {
                val glance = parseOrNull(read.json, localDate) ?: return unreachable(gen)
                // 2.6 to 2.10 ignore ?day= and answer today's glance: the day route is 2.13.0's.
                if (glance.today != localDate) {
                    log("asked for $localDate, the instance answered ${glance.today}: it predates the day route")
                    return emit(gen) {
                        it.copy(shownDay = shownDayOf(it.glance), reachable = true, loading = false, problem = Problem.TooOld)
                    }
                }
                val now = clock()
                emit(gen) {
                    GlanceUiState(
                        shownDay = shownDayOf(glance), glance = glance, fetchedAtMs = now,
                        reachable = true, loading = false, problem = problemOf(glance),
                    )
                }
            }
            is GlanceRead.Nearest -> if (followNearest) {
                emit(gen) { it.copy(shownDay = read.localDate) }
                readDay(gen, read.localDate, followNearest = false)
            } else {
                log("$localDate answered with another nearest day, ${read.localDate}; back to today")
                backToToday(gen)
            }
            is GlanceRead.Refused -> backToToday(gen)
            GlanceRead.Unauthorised -> signOut(gen)
            GlanceRead.TooOld -> emit(gen) {
                it.copy(shownDay = shownDayOf(it.glance), reachable = true, loading = false, problem = Problem.TooOld)
            }
            GlanceRead.NotModified -> {
                // A day read sends no ETag, so a 304 is not an answer to it.
                log("$localDate answered 304 to a read without an ETag")
                unreachable(gen)
            }
            is GlanceRead.Unreachable -> unreachable(gen)
        }
    }

    /**
     * Today's glance, in memory and on disk, from today read number [seq]. Nothing after [close], and
     * nothing older than an answer already kept. The disk write is inside the lock so the file's
     * order is memory's order; it is one small file, and it is what makes close-then-delete final.
     * A store that refuses costs only the instant open.
     */
    private fun keep(kept: GlanceStore.Kept, seq: Int) {
        synchronized(lock) {
            if (closed || seq < todayKept) return
            todayKept = seq
            today = kept
            if (!store.save(server, personId, kept.etag, kept.fetchedAtMs, kept.json)) {
                log("today's glance could not be kept on the device")
            }
        }
    }

    /** The glance, or null after logging why not: a body the parser rejects is an unreachable read. */
    private fun parseOrNull(json: String, day: String): Glance? = try {
        GlanceParser.parse(json)
    } catch (e: GlanceParseException) {
        log("the glance for $day could not be read: ${e.message}")
        null
    }
}
