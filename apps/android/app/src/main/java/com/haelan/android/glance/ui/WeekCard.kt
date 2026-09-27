package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.Glance
import com.haelan.android.glance.format.WeekRowKind

/**
 * The week, the web's WeekCard: steps and active time as the seven-day total with the per-day
 * average after it, time asleep as the per-night average alone, each with its seven bars. The rows
 * are [com.haelan.android.glance.format.GlanceWords.weekLines], which already leaves out a row with
 * no figure and the sleep row without a night. No link: the week has no page of its own.
 */
@Composable
internal fun WeekCard(glance: Glance, text: CardText, onOpenDay: (String) -> Unit) {
    val colors = LocalGlanceColors.current
    DashCard(
        title = stringResource(if (glance.finished) R.string.glance_week_title_finished else R.string.glance_week_title),
        subtitle = stringResource(if (glance.finished) R.string.glance_week_subtitle_finished else R.string.glance_week_subtitle),
        link = null,
        onOpenPage = {},
    ) {
        text.words.weekLines(glance).forEach { row ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                    Column(Modifier.weight(1f)) {
                        CardLabel(row.label)
                        Text(
                            buildAnnotatedString {
                                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(row.value) }
                                append(" ")
                                withStyle(SpanStyle(color = colors.textMuted)) { append(row.per) }
                            },
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                    // The web's tones: steps in the accent, active time in the positive colour, sleep in
                    // the scale's fourth stop, which reads on both the light and the dark card.
                    val tone = when (row.kind) {
                        WeekRowKind.STEPS -> colors.accent
                        WeekRowKind.ACTIVE -> colors.positive
                        WeekRowKind.ASLEEP -> colors.scale4
                    }
                    WeekBars(row, tone, glance.today, text, onOpenDay)
                }
            }
        }
    }
}
