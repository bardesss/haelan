package com.haelan.android.glance

import com.haelan.android.glance.GlanceClient.GlanceRead
import com.haelan.android.glance.GlanceUiState.Problem
import com.haelan.android.glance.ui.showsLogButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * The state the glance screen renders, driven through a fake instance and the in-memory store.
 *
 * The repository runs on [Dispatchers.Unconfined] here: its reads block rather than suspend, so
 * every call below has finished, state and store included, by the time it returns. The one test
 * about two reads racing uses [QueueDispatcher] instead, to finish them in the order it needs.
 */
class GlanceRepositoryTest {

    private val server = "https://h.example"
    private val reads = FakeReads()
    private val storage = MemoryStorage()
    private val store = GlanceStore(storage)
    private var now = 500L
    private val logged = mutableListOf<String>()
    private var repository = repository(Dispatchers.Unconfined)

    private val todayJson = glanceFixture("today.json")
    private val emptyJson = glanceFixture("empty.json")
    private val pastJson = glanceFixture("past-day.json")

    private fun repository(dispatcher: kotlinx.coroutines.CoroutineDispatcher) =
        GlanceRepository(reads, store, server, "p1", { now }, dispatcher, log = { logged += it })

    private val state get() = repository.state.value

    /** Stored the way a previous run of the app left it: empty.json, so it tells apart from today.json. */
    private fun storedEarlier() = store.save(server, "p1", "\"v1\"", 100L, emptyJson)

    @After
    fun close() = repository.close()

    private fun signedOutWithin(ms: Long): Boolean =
        runBlocking { withTimeoutOrNull(ms) { repository.signedOut.first() } } != null

    @Test
    fun `open draws the stored glance before it asks the instance, then the fresh one`() {
        storedEarlier()
        var onScreenWhenAsked: GlanceUiState? = null
        reads.onToday = { onScreenWhenAsked = state }
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")

        repository.open()

        val then = checkNotNull(onScreenWhenAsked)
        assertEquals(GlanceParser.parse(emptyJson), then.glance)
        assertEquals(100L, then.fetchedAtMs)
        assertTrue(then.loading)
        assertEquals(listOf<String?>("\"v1\""), reads.etagsSent)

        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertEquals(500L, state.fetchedAtMs)
        assertNull(state.shownDay)
        assertTrue(state.reachable)
        assertFalse(state.loading)
        assertNull(state.problem)
    }

    @Test
    fun `a fresh glance is stored with its ETag, and the next refresh sends it`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        val kept = checkNotNull(store.load(server, "p1"))
        assertEquals("\"v2\"", kept.etag)
        assertEquals(500L, kept.fetchedAtMs)

        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        assertEquals(listOf(null, "\"v2\""), reads.etagsSent)
    }

    @Test
    fun `a 304 keeps the glance and moves only the fetched-at instant, on screen and in the store`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.NotModified
        repository.open()

        assertEquals(GlanceParser.parse(emptyJson), state.glance)
        assertEquals(500L, state.fetchedAtMs)
        assertTrue(state.reachable)
        assertFalse(state.loading)
        val kept = checkNotNull(store.load(server, "p1"))
        assertEquals(500L, kept.fetchedAtMs)
        assertEquals("\"v1\"", kept.etag)
    }

    @Test
    fun `unreachable with a stored glance keeps it, and when it was fetched`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()

        assertEquals(GlanceParser.parse(emptyJson), state.glance)
        assertEquals(100L, state.fetchedAtMs)
        assertFalse(state.reachable)
        assertFalse(state.loading)
    }

    @Test
    fun `unreachable with nothing stored has no glance and no problem to name`() {
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()

        assertNull(state.glance)
        assertNull(state.fetchedAtMs)
        assertFalse(state.reachable)
        assertFalse(state.loading)
        assertNull(state.problem)
    }

    @Test
    fun `reaching the instance again after a miss says so`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        assertTrue(state.reachable)
    }

    @Test
    fun `a 401 signs out, once`() {
        reads.todayAnswers += GlanceRead.Unauthorised
        // Nobody collects while the read runs: the event has to wait for the screen.
        repository.open()
        assertTrue(signedOutWithin(1000))
        assertFalse(state.loading)
        assertFalse("the event is one-shot", signedOutWithin(50))
    }

    @Test
    fun `nothing but a 401 signs out`() {
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()
        assertFalse(signedOutWithin(50))
    }

    @Test
    fun `a 401 on a past day signs out too`() {
        reads.answerDay("2026-08-18", GlanceRead.Unauthorised)
        repository.showDay("2026-08-18")
        assertTrue(signedOutWithin(1000))
    }

    @Test
    fun `a 404 on today is an instance too old for the glance`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.TooOld
        repository.open()
        assertEquals(Problem.TooOld, state.problem)
        assertFalse(state.loading)
    }

    @Test
    fun `a refusal on today carries the instance's own sentence`() {
        reads.todayAnswers += GlanceRead.Refused("person not found")
        repository.open()
        assertEquals(Problem.Refused("person not found"), state.problem)
    }

    @Test
    fun `a body the parser rejects is unreachable, the last good glance kept and the reason logged`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.Fresh("{\"today\":\"2026-08-20\"}", "\"v9\"")
        repository.open()

        assertEquals(GlanceParser.parse(emptyJson), state.glance)
        assertEquals(100L, state.fetchedAtMs)
        assertFalse(state.reachable)
        assertEquals("\"v1\"", checkNotNull(store.load(server, "p1")).etag)
        assertTrue(logged.toString(), logged.any { it.contains("sleep is missing") })
    }

    @Test
    fun `a today glance too old to read, with nothing kept, is a server to update, not a network to check`() {
        // 2.6 to 2.9 answer today without week, nav and finished, which 2.13.0's glance needs.
        val older = JSONObject(todayJson).apply {
            remove("week")
            remove("nav")
            remove("finished")
        }.toString()
        reads.todayAnswers += GlanceRead.Fresh(older, "\"v1\"")
        repository.open()

        assertEquals(Problem.TooOld, state.problem)
        assertTrue(state.reachable)
        assertFalse(state.loading)
        assertNull(state.glance)
        assertNull("nothing unreadable is kept", storage.bytes)
    }

    @Test
    fun `the stored glance is unconfirmed until the instance answers for it, and the + waits`() {
        store.save(server, "p1", "\"v1\"", 100L, glanceFixture("today-quick-log.json"))
        var whenAsked: GlanceUiState? = null
        reads.onToday = { whenAsked = state }
        reads.todayAnswers += GlanceRead.NotModified
        repository.open()

        val then = checkNotNull(whenAsked)
        assertTrue("the stored glance carries a log", then.glance?.log != null)
        assertFalse(then.confirmed)
        assertFalse(showsLogButton(then))
        assertTrue(state.confirmed)
        assertTrue(showsLogButton(state))
    }

    @Test
    fun `a stored glance the instance never answered for stays unconfirmed`() {
        store.save(server, "p1", "\"v1\"", 100L, glanceFixture("today-quick-log.json"))
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()
        assertFalse(state.confirmed)
        assertFalse(showsLogButton(state))
    }

    @Test
    fun `a fresh today and a finished day are confirmed, and back to today keeps a confirmed kept glance so`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        assertTrue(state.confirmed)

        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-18")
        assertTrue(state.confirmed)

        var whenAsked: GlanceUiState? = null
        reads.onToday = { whenAsked = state }
        reads.todayAnswers += GlanceRead.NotModified
        repository.showToday()
        assertTrue("confirmed earlier in this life", checkNotNull(whenAsked).confirmed)
    }

    @Test
    fun `a record for another person is deleted on open and never drawn`() {
        store.save(server, "p2", "\"v1\"", 100L, todayJson)
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()
        assertNull(state.glance)
        assertNull(storage.bytes)
        assertEquals("no ETag for someone else's glance", listOf<String?>(null), reads.etagsSent)
    }

    @Test
    fun `a past day is shown with its own day, and never written to storage`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        val before = checkNotNull(storage.bytes).copyOf()

        now = 900L
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, "\"d1\""))
        repository.showDay("2026-08-18")

        assertEquals("2026-08-18", state.shownDay)
        assertEquals(GlanceParser.parse(pastJson), state.glance)
        assertEquals(900L, state.fetchedAtMs)
        assertFalse(state.loading)
        assertArrayEquals(before, storage.bytes)
    }

    @Test
    fun `while a day loads, the header names it and the glance on screen stays`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        var whileLoading: GlanceUiState? = null
        reads.onDay = { whileLoading = state }
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-18")

        val then = checkNotNull(whileLoading)
        assertEquals("2026-08-18", then.shownDay)
        assertEquals(GlanceParser.parse(todayJson), then.glance)
        assertTrue(then.loading)
    }

    @Test
    fun `a day with no data opens the nearest day the instance names`() {
        reads.answerDay("2026-08-16", GlanceRead.Nearest("2026-08-18"))
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-16")

        assertEquals(listOf("2026-08-16", "2026-08-18"), reads.daysAsked)
        assertEquals("2026-08-18", state.shownDay)
        assertEquals(GlanceParser.parse(pastJson), state.glance)
    }

    @Test
    fun `a nearest day is followed once, and a second one goes back to today`() {
        reads.answerDay("2026-08-16", GlanceRead.Nearest("2026-08-17"))
        reads.answerDay("2026-08-17", GlanceRead.Nearest("2026-08-15"))
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.showDay("2026-08-16")

        assertEquals(listOf("2026-08-16", "2026-08-17"), reads.daysAsked)
        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
    }

    @Test
    fun `a refused day goes back to today`() {
        reads.answerDay("2026-01-01", GlanceRead.Refused("before the first day"))
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.showDay("2026-01-01")

        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertNull("falling back is not an error to show", state.problem)
    }

    @Test
    fun `a day answer for another day is a server that ignored the day, too old for the glance`() {
        // 2.6 to 2.10 answer ?day= with today's glance: the day route is M9c's (2.13.0).
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        reads.answerDay("2026-08-18", GlanceRead.Fresh(todayJson, null))
        repository.showDay("2026-08-18")

        assertEquals(Problem.TooOld, state.problem)
        assertNull("back on the glance it still shows", state.shownDay)
        assertFalse(state.loading)
    }

    @Test
    fun `an unreachable day keeps what was shown and says it is not reachable`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        reads.answerDay("2026-08-18", GlanceRead.Unreachable(IOException("no route")))
        repository.showDay("2026-08-18")

        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertFalse(state.reachable)
        assertFalse(state.loading)
    }

    @Test
    fun `a day the parser rejects keeps what was shown, and is logged`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        reads.answerDay("2026-08-18", GlanceRead.Fresh("[]", null))
        repository.showDay("2026-08-18")

        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertFalse(state.reachable)
        assertTrue(logged.toString(), logged.any { it.contains("not a JSON object") })
    }

    @Test
    fun `back to today draws the kept glance at once, then revalidates it`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-18")

        var whenAsked: GlanceUiState? = null
        reads.onToday = { whenAsked = state }
        reads.todayAnswers += GlanceRead.NotModified
        now = 900L
        repository.showToday()

        val then = checkNotNull(whenAsked)
        assertNull(then.shownDay)
        assertEquals(GlanceParser.parse(todayJson), then.glance)
        assertEquals(500L, then.fetchedAtMs)
        assertEquals(listOf(null, "\"v2\""), reads.etagsSent)
        assertEquals(900L, state.fetchedAtMs)
    }

    @Test
    fun `refresh on a past day reads that day again, not today`() {
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-18")
        now = 900L
        repository.refresh()
        assertEquals(listOf("2026-08-18", "2026-08-18"), reads.daysAsked)
        assertEquals(emptyList<String?>(), reads.etagsSent)
        assertEquals("2026-08-18", state.shownDay)
        assertEquals(GlanceParser.parse(pastJson), state.glance)
        assertEquals(900L, state.fetchedAtMs)
        assertTrue(state.reachable)
        assertFalse(state.loading)
    }

    @Test
    fun `a 304 clears a problem an earlier answer named`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.TooOld
        repository.open()
        assertEquals(Problem.TooOld, state.problem)

        // empty.json is stored, so the glance's own problem is the first run, not nothing.
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        assertEquals(Problem.FirstRun, state.problem)

        reads.todayAnswers += GlanceRead.Refused("person not found")
        repository.refresh()
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        assertEquals(Problem.FirstRun, state.problem)
    }

    @Test
    fun `a 304 on a full glance leaves no problem`() {
        store.save(server, "p1", "\"v1\"", 100L, todayJson)
        reads.todayAnswers += GlanceRead.TooOld
        repository.open()
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        assertNull(state.problem)
    }

    @Test
    fun `a today read that answers after close is never written, so sign-out stays signed out`() {
        val queue = QueueDispatcher()
        repository.close()
        repository = repository(queue)
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")

        // Sign-out while the read is blocked in the client: close the repository, then delete the
        // store. Closing before the task runs would prove nothing, since a cancelled coroutine never
        // starts; this is the read that is already past the point cancellation can stop.
        reads.onToday = {
            repository.close()
            store.delete()
        }
        repository.refresh()
        queue.runFirst()

        assertNull(storage.bytes)
    }

    @Test
    fun `an overtaken today answer does not replace the newer one, in memory or on disk`() {
        val queue = QueueDispatcher()
        repository.close()
        repository = repository(queue)
        // Answers are handed out in the order the instance is reached: v3 first, then v2.
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v3\"")
        reads.todayAnswers += GlanceRead.Fresh(emptyJson, "\"v2\"")
        repository.refresh()
        repository.refresh()
        val earlier = queue.tasks.removeFirst()
        val later = queue.tasks.removeFirst()

        // The earlier read starts first, and while it waits on the instance the later read starts,
        // is answered (v3) and finishes; then the earlier read's own answer (v2) arrives.
        reads.onToday = {
            reads.onToday = {}
            later.run()
        }
        earlier.run()

        val kept = checkNotNull(store.load(server, "p1"))
        assertEquals("\"v3\"", kept.etag)
        assertEquals(GlanceParser.parse(todayJson), kept.glance)

        // In memory too: the next read revalidates v3, not v2.
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        queue.runFirst()
        assertEquals("\"v3\"", reads.etagsSent.last())
    }

    @Test
    fun `of two today reads the later call's answer is kept, whichever thread reaches the instance first`() {
        val queue = QueueDispatcher()
        repository.close()
        repository = repository(queue)
        // The later call's IO task runs before the earlier one's even starts: on IO that is two
        // threads, and nothing orders them. The later call is answered v3, the earlier one v2.
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v3\"")
        reads.todayAnswers += GlanceRead.Fresh(emptyJson, "\"v2\"")
        repository.refresh()
        repository.refresh()
        queue.runLast()
        queue.runFirst()

        assertEquals("\"v3\"", checkNotNull(store.load(server, "p1")).etag)
        reads.todayAnswers += GlanceRead.NotModified
        repository.refresh()
        queue.runFirst()
        assertEquals("\"v3\"", reads.etagsSent.last())
    }

    @Test
    fun `a day that turns out to be today is shown as today`() {
        // nav.next from yesterday can name today; its answer is not finished, as the web reads it.
        reads.answerDay("2026-08-20", GlanceRead.Fresh(todayJson, null))
        repository.showDay("2026-08-20")
        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
    }

    @Test
    fun `an answer overtaken by a later tap is not drawn`() {
        val queue = QueueDispatcher()
        repository.close()
        repository = repository(queue)
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")

        repository.showDay("2026-08-18")
        repository.showToday()
        queue.runLast() // today answers first
        queue.runFirst() // then the day the person already left

        assertNull(state.shownDay)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertFalse(state.loading)
    }

    @Test
    fun `a glance with no value at all is the first run`() {
        reads.todayAnswers += GlanceRead.Fresh(emptyJson, "\"v2\"")
        repository.open()
        assertEquals(Problem.FirstRun, state.problem)
    }

    @Test
    fun `the stored glance is judged for the first run too`() {
        storedEarlier()
        reads.todayAnswers += GlanceRead.Unreachable(IOException("no route"))
        repository.open()
        assertEquals(Problem.FirstRun, state.problem)
    }

    @Test
    fun `a full glance is not the first run`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        assertNull(state.problem)
    }

    /** empty.json with one thing added: each of the web's clauses, alone, is enough to show the page. */
    private fun emptyWith(edit: (JSONObject) -> Unit) =
        GlanceParser.parse(JSONObject(emptyJson).also(edit).toString())

    @Test
    fun `any one thing to show is not the first run`() {
        assertTrue(holdsNoValue(GlanceParser.parse(emptyJson)))
        val today = JSONObject(todayJson)
        val cases = mapOf<String, (JSONObject) -> Unit>(
            "sleep" to { it.put("sleep", today.get("sleep")) },
            "heart rate" to {
                it.getJSONObject("day").getJSONObject("heartRate")
                    .put("points", today.getJSONObject("day").getJSONObject("heartRate").getJSONArray("points"))
            },
            "a workout" to {
                it.getJSONObject("day").put("workouts", JSONArray().put(firstWorkout()))
            },
            "index" to { it.getJSONObject("recovery").getJSONObject("index").put("value", 61) },
            "resting heart rate" to { it.getJSONObject("recovery").getJSONObject("restingHeartRate").put("value", 55) },
            "hrv" to { it.getJSONObject("recovery").getJSONObject("hrv").put("value", 40) },
            "respiratory rate" to {
                val figure = JSONObject(it.getJSONObject("recovery").getJSONObject("hrv").toString()).put("value", 14.2)
                it.getJSONObject("recovery").put("respiratoryRate", figure)
            },
            "steps" to { it.getJSONObject("day").getJSONObject("steps").put("value", 12) },
            "active minutes" to { it.getJSONObject("day").getJSONObject("activeMinutes").put("value", 3) },
        )
        for ((name, edit) in cases) assertFalse(name, holdsNoValue(emptyWith(edit)))
    }

    /** A workout as the server sends one, from the fixture that has any. */
    private fun firstWorkout(): JSONObject {
        for (name in listOf("today.json", "past-day.json", "today-quick-log.json")) {
            val workouts = JSONObject(glanceFixture(name)).getJSONObject("day").getJSONArray("workouts")
            if (workouts.length() > 0) return workouts.getJSONObject(0)
        }
        error("no fixture carries a workout")
    }

    @Test
    fun `nothing is read before open`() {
        assertEquals(GlanceUiState(null, null, null, reachable = true, loading = false, problem = null), state)
        assertTrue(reads.etagsSent.isEmpty())
    }

    @Test
    fun `the person's today is the kept today glance's day, whichever day is on screen`() {
        assertNull(state.today)
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        assertEquals("2026-08-20", state.today)

        var whileLoading: GlanceUiState? = null
        reads.onDay = { whileLoading = state }
        reads.answerDay("2026-08-18", GlanceRead.Fresh(pastJson, null))
        repository.showDay("2026-08-18")
        assertEquals("2026-08-20", checkNotNull(whileLoading).today)
        assertEquals("2026-08-18", state.shownDay)
        assertEquals("2026-08-20", state.today)
    }

    @Test
    fun `the stored glance names today before the instance has answered`() {
        storedEarlier()
        var onScreenWhenAsked: GlanceUiState? = null
        reads.onToday = { onScreenWhenAsked = state }
        reads.todayAnswers += GlanceRead.Unreachable(IOException("down"))
        repository.open()
        assertEquals("2026-08-20", checkNotNull(onScreenWhenAsked).today)
        assertEquals("2026-08-20", state.today)
    }

    @Test
    fun `closing ends the loading a cancelled read would never end`() {
        val queue = QueueDispatcher()
        repository.close()
        repository = repository(queue)
        repository.refresh()
        assertTrue(state.loading)

        repository.close()
        assertFalse("a closed glance still reads as loading", state.loading)
    }

    @Test
    fun `a refresh on a closed glance settles at once, with no read and no loading left on`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        repository.close()

        repository.refresh()
        assertFalse("a pull on a closed glance spins for good", state.loading)
        repository.showDay("2026-08-18")
        assertFalse(state.loading)
        assertEquals(listOf<String?>(null), reads.etagsSent)
        assertEquals(emptyList<String>(), reads.daysAsked)
    }

    @Test
    fun `a read that fails in a way nobody planned for still settles, as unreachable`() {
        reads.todayAnswers += GlanceRead.Fresh(todayJson, "\"v2\"")
        repository.open()
        reads.onToday = { throw IllegalStateException("a client bug") }

        repository.refresh()

        assertFalse(state.loading)
        assertFalse(state.reachable)
        assertEquals(GlanceParser.parse(todayJson), state.glance)
        assertTrue(logged.any { "a client bug" in it })
    }
}
