package com.haelan.android.glance.ui

import androidx.compose.material3.lightColorScheme
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

    private val byId: (Int) -> Color = { id -> Color(id) }

    @Test
    fun `each data colour is read from its own token`() {
        val colors = glanceColorsFrom(byId)
        val table = listOf(
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
            "textPrimary" to (colors.textPrimary to R.color.text_primary),
            "surfaceInset" to (colors.surfaceInset to R.color.surface_inset),
        )
        // The table itself names each token once, so a copy-paste slip that gave two roles the
        // same expected token (and so passed below for both) is caught here.
        val expected = table.map { it.second.second }
        assertEquals("the table names a token twice", expected.size, expected.toSet().size)
        table.forEach { (role, pair) ->
            val (colour, id) = pair
            assertEquals("$role reads the wrong token", Color(id), colour)
        }
    }

    /**
     * A dynamic scheme brings its own page tint; the glance keeps the page the sync screen has.
     * The base stands in for a dynamic scheme: its primary and background are colours no token
     * lookup here can produce, so a role that fell through to the base is told apart.
     */
    @Test
    fun `the page is the token page and the chrome stays the base scheme`() {
        val chrome = Color(1)
        val wallpaperPage = Color(2)
        val base = lightColorScheme(primary = chrome, background = wallpaperPage, surface = wallpaperPage)

        val scheme = withTokenPage(base, byId)

        assertEquals(Color(R.color.surface_page), scheme.background)
        assertEquals(Color(R.color.text_primary), scheme.onBackground)
        assertEquals(chrome, scheme.primary)
        assertEquals(wallpaperPage, scheme.surface)
    }
}
