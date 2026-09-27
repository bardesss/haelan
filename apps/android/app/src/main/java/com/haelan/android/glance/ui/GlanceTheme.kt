package com.haelan.android.glance.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.colorResource
import com.haelan.android.R

/**
 * The colours the glance draws data with: sleep stages, the band behind a chart, the series on it,
 * a verdict's sign. They come from the token build and never from the Material scheme, because on
 * a phone with Material You the scheme follows the wallpaper, and a deep-sleep bar that changes
 * colour with the wallpaper no longer matches the web dashboard it copies.
 */
@Immutable
data class GlanceColors(
    val stageDeep: Color,
    val stageLight: Color,
    val stageRem: Color,
    val stageAwake: Color,
    val band: Color,
    val series: Color,
    val seriesAlt: Color,
    val scale4: Color,
    val negative: Color,
    val positive: Color,
    val accent: Color,
    val textMuted: Color,
    val textFaint: Color,
    val borderChosen: Color,
    val surfaceCard: Color,
)

/**
 * Which token each data role reads. Pure, so a JVM test can hand it a lookup and read back which
 * resource every role was built from; [GlanceTheme] hands it `colorResource`, which also picks the
 * night palette on its own when the phone is dark. Inline because that lookup is composable, and
 * only an inlined lambda may call one from a function that is not.
 */
inline fun glanceColorsFrom(color: (Int) -> Color): GlanceColors = GlanceColors(
    stageDeep = color(R.color.stage_deep),
    stageLight = color(R.color.stage_light),
    stageRem = color(R.color.stage_rem),
    stageAwake = color(R.color.stage_awake),
    band = color(R.color.chart_band),
    series = color(R.color.chart_series),
    seriesAlt = color(R.color.chart_series_alt),
    scale4 = color(R.color.chart_scale_4),
    negative = color(R.color.negative),
    positive = color(R.color.positive),
    accent = color(R.color.accent),
    textMuted = color(R.color.text_muted),
    textFaint = color(R.color.text_faint),
    borderChosen = color(R.color.border_chosen),
    surfaceCard = color(R.color.surface_card),
)

/** Outside a [GlanceTheme] there is no palette to read, and a silent default would be a guess. */
val LocalGlanceColors = staticCompositionLocalOf<GlanceColors> {
    error("GlanceColors read outside GlanceTheme")
}

/**
 * The chrome follows the phone: Material You's wallpaper colours from Android 12, where the phone
 * has them. Before that, the same token mapping `values/themes.xml` gives the view screens, so the
 * glance and the sync screen one tap away look like one app. The data colours are the tokens
 * either way, through [LocalGlanceColors].
 */
@Composable
fun GlanceTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val context = LocalContext.current
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else {
        tokenColorScheme(dark)
    }
    val colors = glanceColorsFrom { colorResource(it) }
    CompositionLocalProvider(LocalGlanceColors provides colors) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/**
 * `values/themes.xml` role for role. The light and dark builders differ only in the defaults for
 * the roles the XML theme leaves alone; the token colours themselves already switch with the night
 * qualifier.
 */
@Composable
private fun tokenColorScheme(dark: Boolean): ColorScheme {
    val primary = colorResource(R.color.accent)
    val onPrimary = colorResource(R.color.surface_page)
    val primaryContainer = colorResource(R.color.surface_selected)
    val onPrimaryContainer = colorResource(R.color.accent_soft)
    val secondary = colorResource(R.color.accent_soft)
    val background = colorResource(R.color.surface_page)
    val surface = colorResource(R.color.surface_card)
    val onSurface = colorResource(R.color.text_primary)
    val surfaceVariant = colorResource(R.color.surface_inset)
    val onSurfaceVariant = colorResource(R.color.text_secondary)
    val error = colorResource(R.color.negative)
    return if (dark) {
        darkColorScheme(
            primary = primary,
            onPrimary = onPrimary,
            primaryContainer = primaryContainer,
            onPrimaryContainer = onPrimaryContainer,
            secondary = secondary,
            background = background,
            onBackground = onSurface,
            surface = surface,
            onSurface = onSurface,
            surfaceVariant = surfaceVariant,
            onSurfaceVariant = onSurfaceVariant,
            error = error,
        )
    } else {
        lightColorScheme(
            primary = primary,
            onPrimary = onPrimary,
            primaryContainer = primaryContainer,
            onPrimaryContainer = onPrimaryContainer,
            secondary = secondary,
            background = background,
            onBackground = onSurface,
            surface = surface,
            onSurface = onSurface,
            surfaceVariant = surfaceVariant,
            onSurfaceVariant = onSurfaceVariant,
            error = error,
        )
    }
}
