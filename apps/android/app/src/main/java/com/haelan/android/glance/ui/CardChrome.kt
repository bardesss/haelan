package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The chrome every glance card wears, the web's cardShared.tsx: a card, a head row with its title,
// a muted span beside it and a link to the page that says the rest, then the card's own content.

/**
 * A card's link: its words, the web path it opens, and the title the opened page's top bar shows
 * (the card's own heading, as the card shows it; the web app never titles its pages).
 */
data class CardLink(val text: String, val path: String, val pageTitle: String)

/**
 * A glance card. The card is painted with the token card surface rather than the Material one:
 * the data drawn on it (a strip dot's rim, a gauge marker's ring) is ringed in that colour, and on a
 * wallpaper-tinted card the rings would show.
 */
@Composable
internal fun DashCard(
    title: String,
    subtitle: String?,
    link: CardLink?,
    onOpenPage: (path: String, title: String) -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalGlanceColors.current
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = colors.surfaceCard, contentColor = colors.textPrimary),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(title) }
                        if (subtitle != null) {
                            append(" ")
                            withStyle(SpanStyle(color = colors.textMuted, fontWeight = FontWeight.SemiBold)) { append(subtitle) }
                        }
                    },
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                if (link != null) {
                    TextButton(onClick = { onOpenPage(link.path, link.pageTitle) }) { Text(link.text) }
                }
            }
            content()
        }
    }
}

/** A small upper-case label over a figure or a chart ("STEPS"), as the web's `.label`. */
@Composable
internal fun CardLabel(text: String, modifier: Modifier = Modifier, textAlign: TextAlign? = null) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
        color = LocalGlanceColors.current.textMuted,
        modifier = modifier,
        textAlign = textAlign,
    )
}

/** The faint line under a strip ("last 7 nights"), as the web's `.dash-caption`. */
@Composable
internal fun Caption(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = LocalGlanceColors.current.textFaint, modifier = modifier)
}
