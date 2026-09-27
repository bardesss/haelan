package com.haelan.android.glance.ui

import androidx.compose.ui.graphics.Color
import com.haelan.android.R
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The data colours are the tokens the web draws the same marks with. The lookup here hands back
 * each resource id as the colour itself, so every role reads as the resource it was built from:
 * a role wired to the wrong token fails by name, which a check on the resolved colours could not
 * do, because several tokens share one value today (the light stage, the series and the accent)
 * and would hide a swap between them until the palette moves.
 */
class GlanceColorsTest {

    private val colors = glanceColorsFrom { id -> Color(id) }

    private val table = listOf(
        "stageDeep" to (colors.stageDeep to R.color.stage_deep),
        "stageLight" to (colors.stageLight to R.color.stage_light),
        "stageRem" to (colors.stageRem to R.color.stage_rem),
        "stageAwake" to (colors.stageAwake to R.color.stage_awake),
        "band" to (colors.band to R.color.chart_band),
        "series" to (colors.series to R.color.chart_series),
        "seriesAlt" to (colors.seriesAlt to R.color.chart_series_alt),
        "scale4" to (colors.scale4 to R.color.chart_scale_4),
        "negative" to (colors.negative to R.color.negative),
        "positive" to (colors.positive to R.color.positive),
        "accent" to (colors.accent to R.color.accent),
        "textMuted" to (colors.textMuted to R.color.text_muted),
        "textFaint" to (colors.textFaint to R.color.text_faint),
        "borderChosen" to (colors.borderChosen to R.color.border_chosen),
        "surfaceCard" to (colors.surfaceCard to R.color.surface_card),
    )

    @Test
    fun `each data colour is read from its own token`() {
        table.forEach { (role, pair) ->
            val (colour, id) = pair
            assertEquals("$role reads the wrong token", Color(id), colour)
        }
    }

    /**
     * Two roles on one token would look right today wherever the two values happen to agree, and
     * drift apart silently the day one of them is retuned.
     */
    @Test
    fun `no two roles are read from the same token`() {
        val colours = table.map { it.second.first }
        assertEquals(colours.size, colours.toSet().size)
    }
}
