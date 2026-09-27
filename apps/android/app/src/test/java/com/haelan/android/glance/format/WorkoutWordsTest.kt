package com.haelan.android.glance.format

import com.haelan.android.glance.WorkoutSession
import com.haelan.android.glance.WorkoutSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

/** The Today card's workout rows, worded as the Activity list's SessionRow words them. */
class WorkoutWordsTest {

    private val english = WorkoutWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH)
    private val dutch = WorkoutWords(MapStrings(DUTCH_TEXT), Locale.forLanguageTag("nl"))

    private fun summary(
        type: String? = "RUNNING",
        kcal: Double? = null,
        bpm: Double? = null,
        meters: Double? = null,
        pace: Double? = null,
        climb: Double? = null,
    ) = WorkoutSummary(type, kcal, bpm, meters, pace, climb)

    private fun session(summary: WorkoutSummary, minutes: Double = 42.4, excluded: Boolean = false, reason: String? = null) =
        WorkoutSession(
            id = "w1", sourceId = "watch", startMs = 0L, endMs = (minutes * 60_000).toLong(),
            startOffsetMinutes = 120, endOffsetMinutes = 120, localDate = "2026-08-20",
            summary = summary, excluded = excluded, excludeReason = reason, sources = listOf("watch"), alternateIds = emptyList(),
        )

    @Test
    fun `a run says everything it recorded`() {
        val line = english.line(session(summary(kcal = 1445.0, bpm = 151.0, meters = 7340.0, pace = 378.5, climb = 42.0)))
        assertEquals("Running", line.type)
        assertEquals("42 min", line.duration)
        assertEquals("1,445 kcal · 151 bpm", line.stats)
        assertEquals("7.3 km · 6:19 /km · 42 m gained", line.detail)
        assertNull(line.excluded)
    }

    @Test
    fun `the Dutch row groups and decimals the Dutch way`() {
        val line = dutch.line(session(summary(type = "CARDIO_WORKOUT", kcal = 1445.0, meters = 7340.0)))
        assertEquals("Cardiotraining", line.type)
        assertEquals("1.445 kcal", line.stats)
        assertEquals("7,3 km", line.detail)
    }

    @Test
    fun `a field never recorded is left out, and a recorded zero is kept`() {
        val bare = english.line(session(summary()))
        assertNull(bare.stats)
        assertNull(bare.detail)
        assertEquals("0 m gained", english.line(session(summary(climb = 0.0))).detail)
    }

    @Test
    fun `an unseeded type is humanised and a missing one is unknown`() {
        assertEquals("Cross country ski", english.typeLabel("CROSS_COUNTRY_SKI"))
        assertEquals("Onbekend", dutch.typeLabel(null))
        assertEquals("Huishoudelijke klussen", dutch.typeLabel("HOUSEHOLD_CHORES"))
    }

    @Test
    fun `an excluded workout says so, with its reason when it has one`() {
        assertEquals("Excluded: forgot to stop", english.line(session(summary(), excluded = true, reason = "forgot to stop")).excluded)
        assertEquals("Uitgesloten", dutch.line(session(summary(), excluded = true)).excluded)
    }
}
