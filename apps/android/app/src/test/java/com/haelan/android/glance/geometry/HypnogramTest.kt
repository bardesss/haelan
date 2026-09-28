package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceNightSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HypnogramTest {

    private val minute = 60_000L
    private val bed = 1_787_175_600_000L

    private fun segment(stage: String, from: Long, to: Long) = GlanceNightSegment(stage, bed + from * minute, bed + to * minute)

    @Test
    fun `a night whose first segment starts after bedtime opens on a gap`() {
        // Asleep at bed + 20, the last stage ending at bed + 100: 100 minutes over a 100 wide plot.
        val night = listOf(segment("LIGHT", 20, 50), segment("DEEP", 50, 80), segment("AWAKE", 80, 100))
        val layout = hypnogramLayout(night, bed, width = 100f)
        assertEquals(
            listOf(
                HypnoBlock(HypnoStage.LIGHT, 20f, 50f),
                HypnoBlock(HypnoStage.DEEP, 50f, 80f),
                HypnoBlock(HypnoStage.AWAKE, 80f, 100f),
            ),
            layout.blocks,
        )
    }

    @Test
    fun `deep is the lowest row and awake the highest`() {
        assertEquals(listOf(0, 1, 2, 3), listOf(HypnoStage.AWAKE, HypnoStage.REM, HypnoStage.LIGHT, HypnoStage.DEEP).map { it.row })
        assertEquals(HypnogramLayout.ROWS - 1, HypnoStage.DEEP.row)
    }

    @Test
    fun `an unstaged segment is a gap, not a guessed stage`() {
        val night = listOf(segment("LIGHT", 0, 30), segment("ASLEEP", 30, 60), segment("REM", 60, 90), segment("RESTLESS", 90, 120))
        val layout = hypnogramLayout(night, bed, width = 90f)
        // The width ends where the last staged segment does, 90 minutes in.
        assertEquals(listOf(HypnoBlock(HypnoStage.LIGHT, 0f, 30f), HypnoBlock(HypnoStage.REM, 60f, 90f)), layout.blocks)
    }

    @Test
    fun `totals read deep to awake, only the stages the night has`() {
        val night = listOf(segment("AWAKE", 0, 10), segment("LIGHT", 10, 70), segment("DEEP", 70, 110), segment("LIGHT", 110, 130))
        assertEquals(
            listOf(StageTotal(HypnoStage.DEEP, 40), StageTotal(HypnoStage.LIGHT, 80), StageTotal(HypnoStage.AWAKE, 10)),
            hypnogramLayout(night, bed, 100f).totals,
        )
    }

    @Test
    fun `a stage's total is rounded once, not per segment`() {
        // Three light segments of 1.5 minutes each: 4.5 rounds to 5 once, where rounding each would give 6.
        val half = minute / 2
        val night = (0 until 3).map { i ->
            GlanceNightSegment("LIGHT", bed + i * 3 * half, bed + i * 3 * half + 3 * half)
        }
        assertEquals(listOf(StageTotal(HypnoStage.LIGHT, 5)), hypnogramLayout(night, bed, 100f).totals)
    }

    @Test
    fun `a night never staged has no blocks and no totals`() {
        val layout = hypnogramLayout(listOf(segment("ASLEEP", 0, 400)), bed, 100f)
        assertTrue(layout.blocks.isEmpty())
        assertTrue(layout.totals.isEmpty())
    }
}
