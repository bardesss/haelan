package com.haelan.android.glance.format

import com.haelan.android.glance.DayLog
import com.haelan.android.glance.EditProblem
import com.haelan.android.glance.LogSheetState
import com.haelan.android.glance.SheetProblem
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

/** The log sheet's words, whole, in English and in Dutch, from the web's own logPanel text. */
class LogWordsTest {

    private val english = LogWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH)
    private val dutch = LogWords(MapStrings(DUTCH_TEXT), Locale.forLanguageTag("nl"))

    private val log = DayLog(listOf("caffeine"), null, emptyMap(), null, today = "2026-09-06")
    private fun on(day: String) = LogSheetState.open(day, "2026-09-06", log)

    @Test
    fun `the title says today, yesterday, or the short date`() {
        assertEquals("Log for today", english.title(on("2026-09-06")))
        assertEquals("Log for yesterday", english.title(on("2026-09-05")))
        assertEquals("Log for Fri, Sep 4", english.title(on("2026-09-04")))
        assertEquals("Loggen voor vandaag", dutch.title(on("2026-09-06")))
        assertEquals("Loggen voor gisteren", dutch.title(on("2026-09-05")))
        assertEquals("Loggen voor vr 4 sep", dutch.title(on("2026-09-04")))
    }

    @Test
    fun `the full date sits beneath`() {
        assertEquals("Sunday, September 6", english.subtitle(on("2026-09-06")))
        assertEquals("zondag 6 september", dutch.subtitle(on("2026-09-06")))
    }

    @Test
    fun `seed kinds are translated, a person's own kind is shown as typed`() {
        assertEquals("Caffeine", english.kind("caffeine"))
        assertEquals("Cafeïne", dutch.kind("caffeine"))
        assertEquals("Blessure", dutch.kind("injury"))
        assertEquals("Sauna", dutch.kind("Sauna"))
    }

    @Test
    fun `a chip is named with its count, for today or that day`() {
        assertEquals("Caffeine", english.chipName("caffeine", 0, isToday = true))
        assertEquals("Caffeine, 2 today", english.chipName("caffeine", 2, isToday = true))
        assertEquals("Cafeïne, 2 die dag", dutch.chipName("caffeine", 2, isToday = false))
    }

    @Test
    fun `the undo line names the day when it is not today`() {
        assertEquals("Caffeine logged", english.undoLine("caffeine", on("2026-09-06")))
        assertEquals("Alcohol gelogd voor gisteren", dutch.undoLine("alcohol", on("2026-09-05")))
        assertEquals("Caffeine logged for Friday, September 4", english.undoLine("caffeine", on("2026-09-04")))
    }

    @Test
    fun `the faces are worded Bad to Great`() {
        assertEquals(listOf("Bad", "Poor", "Okay", "Good", "Great"), (1..5).map(english::mood))
        assertEquals(listOf("Slecht", "Matig", "Gaat wel", "Goed", "Top"), (1..5).map(dutch::mood))
    }

    @Test
    fun `problems are the instance's sentence, or the shell's line when it did not answer`() {
        assertEquals("kind is empty", english.problem(SheetProblem.Said("kind is empty")))
        assertEquals("Deze instantie gaf geen antwoord.", dutch.problem(SheetProblem.Unreachable))
    }

    @Test
    fun `the editor's refusals are said in the reader's language`() {
        assertEquals("Caffeine is already a chip", english.editProblem(EditProblem.Duplicate("caffeine")))
        assertEquals("Hoogstens 16 knoppen", dutch.editProblem(EditProblem.Full))
        assertEquals("at most 16 kinds", english.editProblem(EditProblem.Failed(SheetProblem.Said("at most 16 kinds"))))
    }

    @Test
    fun `the editor's buttons and its move line name the kind`() {
        assertEquals("Remove Caffeine", english.remove("caffeine"))
        assertEquals("Cafeïne verplaatst naar plek 2", dutch.moved("caffeine", 2))
        assertEquals("Move Sauna earlier", english.moveEarlier("Sauna"))
        assertEquals("Sauna naar achteren verplaatsen", dutch.moveLater("Sauna"))
    }
}
