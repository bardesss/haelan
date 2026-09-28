package com.haelan.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The log sheet's decisions, each a plain call on [LogSheetState]: what a tap, a mood, a note and
 * the chip editor do the moment they happen, and when their answers land, in whichever order.
 */
class LogSheetStateTest {

    private val log = DayLog(
        presets = listOf("caffeine", "alcohol", "illness"),
        mood = 3,
        counts = mapOf("caffeine" to 1, "sauna" to 2),
        note = "Slept badly.",
        today = "2026-09-27",
    )

    private val sheet = LogSheetState.open("2026-09-27", "2026-09-27", log)

    private fun problem(message: String) = SheetProblem.Said(message)

    // Opening and stepping.

    @Test
    fun `the sheet opens drawn from the log it was given, the note in the field`() {
        assertEquals(log, sheet.log)
        assertEquals("Slept badly.", sheet.noteText)
        assertEquals("Slept badly.", sheet.noteSaved)
        assertTrue(sheet.isToday)
    }

    @Test
    fun `a stepped day opens loading, then draws its log and the real today it names`() {
        val stepped = LogSheetState.open("2026-09-20", "2026-09-27", null)
        assertNull(stepped.log)
        val loaded = stepped.loaded(log.copy(note = null, today = "2026-09-28"))
        assertEquals("2026-09-28", loaded.today)
        assertEquals("", loaded.noteText)
    }

    @Test
    fun `a read landing under text typed since keeps the text and learns the saved note`() {
        val typed = sheet.noteTyped("Half a thought")
        val loaded = typed.loaded(log.copy(note = "From the server"))
        assertEquals("Half a thought", loaded.noteText)
        assertEquals("From the server", loaded.noteSaved)
    }

    @Test
    fun `a failed read shows only when there is nothing drawn`() {
        val loading = LogSheetState.open("2026-09-20", "2026-09-27", null)
        assertEquals(SheetProblem.Unreachable, loading.loadFailed(SheetProblem.Unreachable).loadProblem)
        assertNull(sheet.loadFailed(SheetProblem.Unreachable).loadProblem)
    }

    @Test
    fun `the days either side step one calendar day, and › stops on today`() {
        assertEquals("2026-09-26", sheet.previousDay)
        assertNull(sheet.nextDay)
        val past = LogSheetState.open("2026-08-31", "2026-09-27", log)
        assertEquals("2026-09-01", past.nextDay)
        assertEquals("2026-08-30", past.previousDay)
    }

    @Test
    fun `yesterday is the day before the real today`() {
        assertTrue(LogSheetState.open("2026-09-26", "2026-09-27", log).isYesterday)
        assertFalse(LogSheetState.open("2026-09-25", "2026-09-27", log).isYesterday)
        assertFalse(sheet.isYesterday)
    }

    @Test
    fun `reopened keeps the log and taps in flight, and drops the undo, the problems and edit mode`() {
        val busy = sheet.tapped("alcohol").tapLogged(1, "alcohol", "e1").tapped("caffeine")
            .copy(chipsProblem = problem("x")).editStarted().noteTyped("unsaved")
        val again = busy.reopened()
        assertEquals(2, again.count("caffeine"))
        assertEquals(1, again.count("alcohol"))
        assertNull(again.undo)
        assertNull(again.chipsProblem)
        assertNull(again.edit)
        assertEquals("Slept badly.", again.noteText)
    }

    // Chips.

    @Test
    fun `a tap counts at once, and landing moves it from the delta into the log`() {
        val tapped = sheet.tapped("caffeine")
        assertEquals(2, tapped.count("caffeine"))
        assertEquals(1, tapped.log?.counts?.get("caffeine"))
        val landed = tapped.tapLogged(tapped.tapSeq, "caffeine", "e1")
        assertEquals(2, landed.count("caffeine"))
        assertEquals(2, landed.log?.counts?.get("caffeine"))
        assertEquals(emptyMap<String, Int>(), landed.deltas)
        assertEquals(UndoSlot("caffeine", "e1", 1), landed.undo)
    }

    @Test
    fun `a failed tap takes its count back and says why`() {
        val failed = sheet.tapped("alcohol").tapFailed("alcohol", problem("2026-09-28 is after today"))
        assertEquals(0, failed.count("alcohol"))
        assertEquals(problem("2026-09-28 is after today"), failed.chipsProblem)
        assertNull(failed.undo)
    }

    @Test
    fun `a new tap takes the previous tap's undo away at once`() {
        val first = sheet.tapped("caffeine").tapLogged(1, "caffeine", "e1")
        assertNull(first.tapped("alcohol").undo)
    }

    @Test
    fun `an earlier tap landing late does not take the undo slot from a later one`() {
        val both = sheet.tapped("caffeine").tapped("alcohol")
        val laterLanded = both.tapLogged(2, "alcohol", "e2")
        val earlierLanded = laterLanded.tapLogged(1, "caffeine", "e1")
        assertEquals(UndoSlot("alcohol", "e2", 2), earlierLanded.undo)
        assertEquals(2, earlierLanded.count("caffeine"))
        assertEquals(1, earlierLanded.count("alcohol"))
    }

    @Test
    fun `an earlier tap landing after a later one started never shows its undo`() {
        val both = sheet.tapped("caffeine").tapped("alcohol")
        assertNull(both.tapLogged(1, "caffeine", "e1").undo)
    }

    @Test
    fun `undo empties the slot and drops the count at once, and landing takes it off the log`() {
        val logged = sheet.tapped("caffeine").tapLogged(1, "caffeine", "e1")
        val undoing = logged.undoing()!!
        assertNull(undoing.undo)
        assertEquals(1, undoing.count("caffeine"))
        val undone = undoing.undone("caffeine")
        assertEquals(1, undone.count("caffeine"))
        assertEquals(1, undone.log?.counts?.get("caffeine"))
    }

    @Test
    fun `a failed undo puts the count back`() {
        val logged = sheet.tapped("caffeine").tapLogged(1, "caffeine", "e1")
        val failed = logged.undoing()!!.undoFailed("caffeine", SheetProblem.Unreachable)
        assertEquals(2, failed.count("caffeine"))
        assertEquals(SheetProblem.Unreachable, failed.chipsProblem)
    }

    @Test
    fun `undo with nothing to undo is nothing`() {
        assertNull(sheet.undoing())
    }

    @Test
    fun `the ten seconds running out empty the slot only if it is still that tap's`() {
        val first = sheet.tapped("caffeine").tapLogged(1, "caffeine", "e1")
        assertNull(first.undoExpired(1).undo)
        val second = first.tapped("alcohol").tapLogged(2, "alcohol", "e2")
        assertEquals(UndoSlot("alcohol", "e2", 2), second.undoExpired(1).undo)
    }

    @Test
    fun `an undo that takes a count to zero drops the kind from the counts`() {
        val undone = LogSheetState.open("2026-09-27", "2026-09-27", log.copy(counts = emptyMap()))
            .tapped("alcohol").tapLogged(1, "alcohol", "e1").undoing()!!.undone("alcohol")
        assertEquals(emptyMap<String, Int>(), undone.log?.counts)
    }

    @Test
    fun `a read landing between a tap and its answer counts the tap once`() {
        val tapped = sheet.tapped("caffeine")
        val since = tapped.generation
        // The read already counts the tap: the instance had filed it when it answered.
        val read = tapped.loaded(log.copy(counts = mapOf("caffeine" to 2)))
        assertEquals(3, read.count("caffeine"))
        val landed = read.tapLogged(tapped.tapSeq, "caffeine", "e1", since)
        assertEquals(2, landed.count("caffeine"))
        assertEquals(emptyMap<String, Int>(), landed.deltas)
        assertEquals(UndoSlot("caffeine", "e1", 1), landed.undo)
    }

    @Test
    fun `a read landing between an undo and its answer takes the tap off once`() {
        val logged = sheet.tapped("caffeine").tapLogged(1, "caffeine", "e1")
        val undoing = logged.undoing()!!
        val since = undoing.generation
        val read = undoing.loaded(log.copy(counts = mapOf("caffeine" to 1)))
        val undone = read.undone("caffeine", since)
        assertEquals(1, undone.count("caffeine"))
        assertEquals(emptyMap<String, Int>(), undone.deltas)
    }

    // Mood.

    @Test
    fun `a mood shows at once and lands in the log`() {
        val chosen = sheet.moodChosen(5)
        assertEquals(5, chosen.mood)
        val saved = chosen.moodSaved(chosen.moodSeq, 5)
        assertEquals(5, saved.mood)
        assertNull(saved.moodMark)
        assertEquals(5, saved.log?.mood)
    }

    @Test
    fun `clearing the mood shows no face at once, and lands as none`() {
        val cleared = sheet.moodChosen(null)
        assertNull(cleared.mood)
        assertNull(cleared.moodSaved(cleared.moodSeq, null).log?.mood)
    }

    @Test
    fun `a failed mood rolls back to the log's and says why`() {
        val failed = sheet.moodChosen(1).let { it.moodFailed(it.moodSeq, problem("score must be 1 to 5")) }
        assertEquals(3, failed.mood)
        assertEquals(problem("score must be 1 to 5"), failed.moodProblem)
    }

    @Test
    fun `an earlier mark settling late does not drop the mark made after it`() {
        val two = sheet.moodChosen(4).moodChosen(5)
        val earlier = two.moodSaved(1, 4)
        assertEquals(5, earlier.mood)
        val later = earlier.moodSaved(2, 5)
        assertEquals(5, later.mood)
        assertEquals(5, later.log?.mood)
    }

    @Test
    fun `an earlier mark landing after the later one does not overwrite it in the log`() {
        val two = sheet.moodChosen(4).moodChosen(5)
        val settled = two.moodSaved(2, 5).moodSaved(1, 4)
        assertEquals(5, settled.log?.mood)
        assertEquals(5, settled.mood)
    }

    // Note.

    @Test
    fun `a commit saves the text and counts it saved at once, in the log too`() {
        val (committed, save) = sheet.noteTyped("Birthday").commitNote()
        assertEquals(NoteSave("2026-09-27", "Birthday", "Slept badly."), save)
        assertEquals("Birthday", committed.noteSaved)
        assertEquals("Birthday", committed.log?.note)
    }

    @Test
    fun `the note is saved once on dismiss after a blur already saved it`() {
        val (blurred, first) = sheet.noteTyped("Birthday").commitNote()
        assertNotNull(first)
        val (_, second) = blurred.commitNote()
        assertNull(second)
    }

    @Test
    fun `an unchanged note sends nothing, and blank over nothing is unchanged`() {
        assertNull(sheet.commitNote().second)
        val empty = LogSheetState.open("2026-09-27", "2026-09-27", log.copy(note = null))
        assertNull(empty.noteTyped("   ").commitNote().second)
    }

    @Test
    fun `an emptied note is saved as blank and leaves no note in the log`() {
        val (committed, save) = sheet.noteTyped("").commitNote()
        assertEquals("", save?.body)
        assertNull(committed.log?.note)
    }

    @Test
    fun `a failed note save puts the old note back and says why`() {
        val (committed, save) = sheet.noteTyped("Birthday").commitNote()
        val failed = committed.noteFailed(save!!, SheetProblem.Unreachable)
        assertEquals("Slept badly.", failed.noteSaved)
        assertEquals("Slept badly.", failed.log?.note)
        assertEquals("Birthday", failed.noteText)
        assertEquals(SheetProblem.Unreachable, failed.noteProblem)
        // The field still differs from what is saved, so the next commit tries again.
        assertNotNull(failed.commitNote().second)
    }

    @Test
    fun `an earlier save failing after a later one started leaves the later one's note`() {
        val (once, first) = sheet.noteTyped("One").commitNote()
        val (twice, _) = once.noteTyped("Two").commitNote()
        val failed = twice.noteFailed(first!!, problem("no"))
        assertEquals("Two", failed.noteSaved)
        assertEquals("Two", failed.log?.note)
    }

    // Edit mode.

    private val editing = sheet.editStarted()

    @Test
    fun `edit mode starts from the chips as they are`() {
        assertEquals(PresetEdit(listOf("caffeine", "alcohol", "illness")), editing.edit)
    }

    @Test
    fun `a typed kind is added trimmed, and the field emptied`() {
        val added = editing.draftTyped("  Sauna ").draftAdded()
        assertEquals(listOf("caffeine", "alcohol", "illness", "Sauna"), added.edit?.kinds)
        assertEquals("", added.edit?.draft)
    }

    @Test
    fun `an empty field adds nothing`() {
        assertEquals(editing, editing.draftTyped("   ").draftAdded().draftTyped(""))
    }

    @Test
    fun `a duplicate, ignoring case, names the chip as it is written`() {
        val refused = editing.draftTyped("CAFFEINE").draftAdded()
        assertEquals(EditProblem.Duplicate("caffeine"), refused.edit?.problem)
        assertEquals(3, refused.edit?.kinds?.size)
        assertEquals("CAFFEINE", refused.edit?.draft)
    }

    @Test
    fun `a full list takes no more, and says so`() {
        val full = LogSheetState.open("2026-09-27", "2026-09-27", log.copy(presets = List(16) { "k$it" })).editStarted()
        assertTrue(full.edit!!.full)
        val refused = full.draftTyped("one more").draftAdded()
        assertEquals(EditProblem.Full, refused.edit?.problem)
        assertEquals(16, refused.edit?.kinds?.size)
        assertEquals(EditProblem.Full, full.suggestionAdded("travel").edit?.problem)
    }

    @Test
    fun `the field is never longer than a kind may be`() {
        assertEquals(40, editing.draftTyped("x".repeat(60)).edit?.draft?.length)
    }

    @Test
    fun `a suggestion is added as it is, the field left alone`() {
        val added = editing.draftTyped("half").suggestionAdded("travel")
        assertEquals(listOf("caffeine", "alcohol", "illness", "travel"), added.edit?.kinds)
        assertEquals("half", added.edit?.draft)
    }

    @Test
    fun `suggestions are the day's counted kinds then the seed set, less those on the list`() {
        assertEquals(listOf("sauna", "travel", "medication", "injury"), editing.suggestions)
        assertEquals(listOf("travel", "medication", "injury"), editing.suggestionAdded("Sauna").suggestions)
    }

    @Test
    fun `remove takes the kind off the list and clears a problem`() {
        val removed = editing.draftTyped("caffeine").draftAdded().kindRemoved("alcohol")
        assertEquals(listOf("caffeine", "illness"), removed.edit?.kinds)
        assertNull(removed.edit?.problem)
    }

    @Test
    fun `move shifts a kind one place, and does nothing at either end`() {
        val later = editing.kindMoved("caffeine", 1)
        assertEquals(listOf("alcohol", "caffeine", "illness"), later.edit?.kinds)
        assertEquals("caffeine", later.edit?.moved)
        assertEquals(listOf("caffeine", "alcohol", "illness"), later.kindMoved("caffeine", -1).edit?.kinds)
        assertEquals(editing, editing.kindMoved("caffeine", -1))
        assertEquals(editing, editing.kindMoved("illness", 1))
    }

    @Test
    fun `Done sends the list once, and the saved list comes back as the chips`() {
        val (saving, kinds) = editing.kindRemoved("illness").editSaving()!!
        assertEquals(listOf("caffeine", "alcohol"), kinds)
        assertNull(saving.editSaving())
        val saved = saving.editSaved(listOf("caffeine", "alcohol"))
        assertNull(saved.edit)
        assertEquals(listOf("caffeine", "alcohol"), saved.log?.presets)
    }

    @Test
    fun `a refused save stays in edit mode with the instance's sentence`() {
        val (saving, _) = editing.kindRemoved("illness").editSaving()!!
        val failed = saving.editFailed(problem("kinds[2] is empty"))
        assertEquals(EditProblem.Failed(problem("kinds[2] is empty")), failed.edit?.problem)
        assertFalse(failed.edit!!.saving)
    }

    @Test
    fun `Done with the list as it was leaves edit mode and sends nothing`() {
        val (left, kinds) = editing.kindMoved("caffeine", 1).kindMoved("caffeine", -1).editSaving()!!
        assertNull(kinds)
        assertNull(left.edit)
        assertEquals(0, left.inFlight)
    }

    @Test
    fun `Done adds a typed kind first, trimmed, and sends the list with it`() {
        val (saving, kinds) = editing.draftTyped("  Travel ").editSaving()!!
        assertEquals(listOf("caffeine", "alcohol", "illness", "Travel"), kinds)
        assertEquals("", saving.edit?.draft)
        assertTrue(saving.edit!!.saving)
        assertEquals(1, saving.inFlight)
    }

    @Test
    fun `Done with a duplicate typed kind stays in edit mode with the reason, and sends nothing`() {
        val (refused, kinds) = editing.draftTyped("ALCOHOL").editSaving()!!
        assertNull(kinds)
        assertEquals(EditProblem.Duplicate("alcohol"), refused.edit?.problem)
        assertEquals("ALCOHOL", refused.edit?.draft)
        assertFalse(refused.edit!!.saving)
        assertEquals(0, refused.inFlight)
    }

    @Test
    fun `Done with a typed kind and the list full stays in edit mode, and sends nothing`() {
        val full = LogSheetState.open("2026-09-27", "2026-09-27", log.copy(presets = List(16) { "k$it" })).editStarted()
        val (refused, kinds) = full.draftTyped("one more").editSaving()!!
        assertNull(kinds)
        assertEquals(EditProblem.Full, refused.edit?.problem)
        assertEquals(16, refused.edit?.kinds?.size)
    }

    @Test
    fun `Add is offered only for a typed kind while the list has room`() {
        assertFalse(editing.edit!!.canAdd)
        assertFalse(editing.draftTyped("   ").edit!!.canAdd)
        assertTrue(editing.draftTyped("travel").edit!!.canAdd)
        val full = LogSheetState.open("2026-09-27", "2026-09-27", log.copy(presets = List(16) { "k$it" })).editStarted()
        assertFalse(full.draftTyped("travel").edit!!.canAdd)
        assertTrue(full.draftTyped("travel").kindRemoved("k0").edit!!.canAdd)
    }

    @Test
    fun `chips saved from another day's sheet replace this day's`() {
        assertEquals(listOf("travel"), sheet.presetsSaved(listOf("travel")).log?.presets)
    }

    @Test
    fun `Cancel drops every change`() {
        val cancelled = editing.kindRemoved("caffeine").editCancelled()
        assertNull(cancelled.edit)
        assertEquals(log.presets, cancelled.log?.presets)
    }

    // What the glance may take back.

    @Test
    fun `calls are counted in flight until answered`() {
        val busy = sheet.tapped("caffeine").moodChosen(4)
        assertEquals(2, busy.inFlight)
        assertEquals(0, busy.tapLogged(1, "caffeine", "e1").moodFailed(1, SheetProblem.Unreachable).inFlight)
        val (noting, _) = sheet.noteTyped("n").commitNote()
        assertEquals(1, noting.inFlight)
        assertEquals(0, noting.noteSettled().inFlight)
    }

    @Test
    fun `a glance has caught up once nothing is in flight and its note is the sheet's`() {
        val (noted, _) = sheet.noteTyped("Birthday").commitNote()
        assertFalse("the save is still out", noted.caughtUpWith(log.copy(note = "Birthday")))
        val settled = noted.noteSettled()
        assertFalse("an older glance still has the old note", settled.caughtUpWith(log))
        assertTrue(settled.caughtUpWith(log.copy(note = "Birthday", counts = emptyMap())))
    }
}
