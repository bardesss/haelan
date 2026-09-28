package com.haelan.android.glance

import com.haelan.android.glance.QuickLogClient.Answer
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The log sheet's calls, driven through a fake instance: what is read and when, what a write
 * refreshes, and what a reopened sheet shows while the answers behind it are still out.
 *
 * Unconfined unless a test needs an answer held back, when [QueueDispatcher] runs the calls in the
 * order the test chooses.
 */
class LogSheetModelTest {

    private val today = "2026-09-27"
    private val glanceLog = DayLog(listOf("caffeine", "alcohol"), 3, mapOf("caffeine" to 1), "Slept badly.", today)
    private val calls = FakeCalls()
    private var refreshed = 0
    private var signedOut = 0

    private fun model(dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Unconfined) =
        LogSheetModel({ calls }, dispatcher, onWrote = { refreshed++ }, onSignedOut = { signedOut++ })

    private val model = model()
    private val sheet get() = model.state.value

    @Test
    fun `the screen's day opens from the glance's log, without a read`() {
        model.open(today, glanceLog)
        assertEquals(glanceLog, sheet?.log)
        assertEquals(emptyList<String>(), calls.sent)
    }

    @Test
    fun `a write that lands refreshes the glance, and one that fails does not`() {
        model.open(today, glanceLog)
        model.tap("caffeine")
        assertEquals(1, refreshed)
        calls.tapAnswer = Answer.Refused("2026-09-28 is after today")
        model.tap("caffeine")
        assertEquals(1, refreshed)
        assertEquals(SheetProblem.Said("2026-09-28 is after today"), sheet?.chipsProblem)
        assertEquals(2, sheet?.count("caffeine"))
    }

    @Test
    fun `a step saves the typed note to its own day, then reads the stepped day`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.step("2026-09-26")
        assertEquals(listOf("note 2026-09-27 Birthday", "day 2026-09-26"), calls.sent)
        assertEquals("2026-09-26", sheet?.day)
        assertEquals(calls.dayAnswer.let { (it as Answer.Ok).value }, sheet?.log)
    }

    @Test
    fun `stepping back to the screen's day draws what the sheet left there, without a read`() {
        model.open(today, glanceLog)
        model.tap("alcohol")
        model.step("2026-09-26")
        model.step(today)
        assertEquals(listOf("tap alcohol 2026-09-27", "day 2026-09-26"), calls.sent)
        assertEquals(1, sheet?.count("alcohol"))
    }

    @Test
    fun `a new today confirmed under an open sheet retitles it in place, and the typed note survives unsent`() {
        val queue = QueueDispatcher()
        val model = model(queue)
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.todayConfirmed("2026-09-28")
        val open = model.state.value
        assertEquals(today, open?.day)
        assertEquals(false, open?.isToday)
        assertEquals("2026-09-28", open?.nextDay)
        assertEquals("Birthday", open?.noteText)
        assertEquals(0, queue.tasks.size)

        // The draft goes out only when the reader leaves the sheet, and to the day it was typed for.
        model.dismiss()
        while (queue.tasks.isNotEmpty()) queue.runFirst()
        assertEquals(listOf("note 2026-09-27 Birthday"), calls.sent)
    }

    @Test
    fun `the same today confirmed again leaves the open sheet alone`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.todayConfirmed(today)
        assertEquals(today, sheet?.day)
        assertEquals("Birthday", sheet?.noteText)
    }

    @Test
    fun `dismiss saves the note once, after a blur already saved it`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.commitNote()
        model.dismiss()
        assertEquals(listOf("note 2026-09-27 Birthday"), calls.sent)
        assertNull(sheet)
    }

    @Test
    fun `a sheet reopened before the glance catches up shows the note saved as it closed`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.dismiss()
        model.open(today, glanceLog)
        assertEquals("Birthday", sheet?.noteText)
    }

    @Test
    fun `a glance that has caught up is what the next opening draws`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.dismiss()
        val newer = glanceLog.copy(note = "Birthday", counts = mapOf("caffeine" to 4))
        model.glanceArrived(today, newer)
        model.open(today, newer)
        assertEquals(4, sheet?.count("caffeine"))
    }

    @Test
    fun `an older glance arriving does not take the saved note back`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.dismiss()
        model.glanceArrived(today, glanceLog)
        model.open(today, glanceLog)
        assertEquals("Birthday", sheet?.noteText)
    }

    @Test
    fun `a note save failing after the sheet closed puts the old note back for the next opening`() {
        val queue = QueueDispatcher()
        val held = model(queue)
        calls.noteAnswer = Answer.Unreachable(RuntimeException("down"))
        held.open(today, glanceLog)
        held.typeNote("Birthday")
        held.dismiss()
        held.open(today, glanceLog)
        assertEquals("Birthday", held.state.value?.noteText)
        held.dismiss()
        queue.runFirst()
        held.open(today, glanceLog)
        assertEquals("Slept badly.", held.state.value?.noteText)
        assertEquals(0, refreshed)
    }

    @Test
    fun `a tap still out when the sheet closes lands in its own day`() {
        val queue = QueueDispatcher()
        val held = model(queue)
        held.open(today, glanceLog)
        held.tap("alcohol")
        held.dismiss()
        queue.runFirst()
        held.open(today, glanceLog)
        assertEquals(1, held.state.value?.count("alcohol"))
        assertEquals(1, held.state.value?.log?.counts?.get("alcohol"))
    }

    @Test
    fun `a stepped day's read waits for that day's note save`() {
        val queue = QueueDispatcher()
        val held = model(queue)
        held.open(today, glanceLog)
        held.step("2026-09-26")
        queue.runFirst()
        held.typeNote("Rainy")
        held.step(today)
        held.step("2026-09-26")
        // The second read of 09-26 is queued behind the note save sent for it.
        queue.runLast()
        assertEquals(listOf("day 2026-09-26"), calls.sent)
        while (queue.tasks.isNotEmpty()) queue.runFirst()
        assertEquals(listOf("day 2026-09-26", "note 2026-09-26 Rainy", "day 2026-09-26"), calls.sent)
    }

    @Test
    fun `stepping back to the screen's day after a glance caught up draws that glance, not the one it opened with`() {
        model.open(today, glanceLog)
        model.typeNote("Birthday")
        model.step("2026-09-26")
        // The refresh after the save arrives while the sheet is on the day before.
        model.glanceArrived(today, glanceLog.copy(note = "Birthday"))
        model.step(today)
        assertEquals("Birthday", sheet?.noteText)
        assertEquals("Birthday", sheet?.log?.note)
    }

    @Test
    fun `a stepped day's read waits for a tap still out on that day`() {
        val queue = QueueDispatcher()
        val held = model(queue)
        held.open(today, glanceLog)
        held.step("2026-09-26")
        queue.runFirst()
        held.tap("travel")
        held.step(today)
        held.step("2026-09-26")
        // The read runs first, and waits: the tap goes out before it asks.
        queue.runLast()
        assertEquals(listOf("day 2026-09-26"), calls.sent)
        while (queue.tasks.isNotEmpty()) queue.runFirst()
        assertEquals(listOf("day 2026-09-26", "tap travel 2026-09-26", "day 2026-09-26"), calls.sent)
        assertEquals(1, held.state.value?.count("travel"))
    }

    @Test
    fun `a read answered while a write started is asked again once the write is answered`() {
        val queue = QueueDispatcher()
        val held = model(queue)
        held.open(today, glanceLog)
        held.step("2026-09-26")
        var tapped = false
        calls.onDay = { if (!tapped) { tapped = true; held.tap("travel") } }
        while (queue.tasks.isNotEmpty()) queue.runFirst()
        assertEquals(listOf("day 2026-09-26", "tap travel 2026-09-26", "day 2026-09-26"), calls.sent)
        assertEquals(1, held.state.value?.count("travel"))
        assertEquals(emptyMap<String, Int>(), held.state.value?.deltas)
    }

    @Test
    fun `chips saved on one day are every kept day's chips`() {
        model.open(today, glanceLog)
        model.step("2026-09-26")
        model.startEdit()
        model.addSuggestion("caffeine")
        model.saveEdit()
        model.step(today)
        assertEquals(listOf("travel", "caffeine"), sheet?.log?.presets)
    }

    @Test
    fun `chips saved on another day reach the screen's day even after its kept sheet was let go`() {
        model.open(today, glanceLog)
        model.step("2026-09-26")
        // The glance caught up while the sheet was on the day before: today's kept sheet is let
        // go, so stepping back rebuilds it from the screen's log, which must carry the new chips.
        model.glanceArrived(today, glanceLog)
        model.startEdit()
        model.addSuggestion("caffeine")
        model.saveEdit()
        model.step(today)
        assertEquals(listOf("travel", "caffeine"), sheet?.log?.presets)
    }

    @Test
    fun `Done with the chips unchanged sends nothing and refreshes nothing`() {
        model.open(today, glanceLog)
        model.startEdit()
        model.saveEdit()
        assertEquals(emptyList<String>(), calls.sent)
        assertEquals(0, refreshed)
        assertNull(sheet?.edit)
    }

    @Test
    fun `Done adds a typed kind before saving, rather than dropping it`() {
        model.open(today, glanceLog)
        model.startEdit()
        model.typeDraft(" travel ")
        model.saveEdit()
        assertEquals(listOf("presets caffeine,alcohol,travel"), calls.sent)
        assertEquals(listOf("caffeine", "alcohol", "travel"), sheet?.log?.presets)
        assertNull(sheet?.edit)
    }

    @Test
    fun `Add puts the typed kind on the list, empties the field, and sends nothing until Done`() {
        model.open(today, glanceLog)
        model.startEdit()
        model.typeDraft("travel")
        model.addDraft()
        assertEquals(listOf("caffeine", "alcohol", "travel"), sheet?.edit?.kinds)
        assertEquals("", sheet?.edit?.draft)
        assertEquals(emptyList<String>(), calls.sent)
    }

    @Test
    fun `Done with a duplicate typed kind shows why, and sends nothing`() {
        model.open(today, glanceLog)
        model.startEdit()
        model.typeDraft("Caffeine")
        model.saveEdit()
        assertEquals(emptyList<String>(), calls.sent)
        assertEquals(EditProblem.Duplicate("caffeine"), sheet?.edit?.problem)
        assertEquals(0, refreshed)
    }

    @Test
    fun `undo deletes the latest tap's event`() {
        model.open(today, glanceLog)
        calls.nextEventId = "e9"
        model.tap("alcohol")
        model.undo()
        assertEquals(listOf("tap alcohol 2026-09-27", "undo e9"), calls.sent)
        assertEquals(0, sheet?.count("alcohol"))
    }

    @Test
    fun `the mood and the chips are sent as chosen`() {
        model.open(today, glanceLog)
        model.chooseMood(3)
        model.chooseMood(null)
        model.startEdit()
        model.moveKind("alcohol", -1)
        model.saveEdit()
        assertEquals(listOf("mood 2026-09-27 3", "mood 2026-09-27 null", "presets alcohol,caffeine"), calls.sent)
        assertEquals(listOf("alcohol", "caffeine"), sheet?.log?.presets)
        assertNull(sheet?.edit)
    }

    @Test
    fun `a 401 signs out`() {
        model.open(today, glanceLog)
        calls.moodAnswer = Answer.Unauthorised
        model.chooseMood(5)
        assertEquals(1, signedOut)
        assertEquals(3, sheet?.mood)
    }

    private class FakeCalls : QuickLogCalls {
        val sent = mutableListOf<String>()
        var dayAnswer: Answer<DayLog> = Answer.Ok(DayLog(listOf("travel"), 2, mapOf("travel" to 1), null, "2026-09-27"))
        var tapAnswer: Answer<LoggedEvent>? = null
        var nextEventId = "e1"
        var moodAnswer: Answer<Unit> = Answer.Ok(Unit)
        var noteAnswer: Answer<Unit> = Answer.Ok(Unit)

        var onDay: () -> Unit = {}

        override fun dayLog(localDate: String): Answer<DayLog> {
            sent += "day $localDate"
            onDay()
            return dayAnswer
        }
        override fun tap(kind: String, day: String): Answer<LoggedEvent> {
            sent += "tap $kind $day"
            return tapAnswer ?: Answer.Ok(LoggedEvent(nextEventId, kind, day))
        }
        override fun undo(eventId: String): Answer<Unit> = Answer.Ok(Unit).also { sent += "undo $eventId" }
        override fun setMood(day: String, score: Int?): Answer<Unit> = moodAnswer.also { sent += "mood $day $score" }
        override fun savePresets(kinds: List<String>): Answer<List<String>> =
            Answer.Ok(kinds).also { sent += "presets ${kinds.joinToString(",")}" }
        override fun saveNote(day: String, body: String): Answer<Unit> = noteAnswer.also { sent += "note $day $body" }
    }
}
