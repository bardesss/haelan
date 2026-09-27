package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.GlanceFigure
import com.haelan.android.glance.GlanceRecovery
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.Strings
import kotlin.math.roundToLong

/**
 * Recovery as three dials on one row, the web's RecoveryCard: resting heart rate and HRV as gauges
 * against their usual either side of the index's ring, the band's words under them (or why the day
 * went unscored), and the breathing-rate note on a day it rose. A gauge whose reading is for a
 * different day from the index says which. [wide] (no night card above) adds the index's seven-day
 * strip under the dials, where the web puts it beside them.
 */
@Composable
internal fun RecoveryCard(
    recovery: GlanceRecovery,
    today: String,
    finished: Boolean,
    wide: Boolean,
    text: CardText,
    onOpenDay: (String) -> Unit,
    onOpenPage: (String) -> Unit,
) {
    val words = text.words
    val colors = LocalGlanceColors.current
    val index = recovery.index
    val score = index.value
    val bandWords = words.bandWords(recovery.band)
    val indexName = stringResource(R.string.glance_recovery_index)
    val ringDescription = if (score == null) {
        stringResource(R.string.glance_recovery_score_unscored)
    } else {
        listOfNotNull("$indexName ${score.roundToLong()}", bandWords).joinToString(", ")
    }
    DashCard(
        title = stringResource(R.string.glance_recovery_title),
        subtitle = words.recoverySubtitle(recovery, today, finished),
        link = CardLink(stringResource(R.string.glance_recovery_link), "/recovery"),
        onOpenPage = onOpenPage,
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.Bottom) {
            GaugeDial(stringResource(R.string.glance_recovery_rhr), recovery.restingHeartRate, stringResource(R.string.charts_units_bpm), recovery, today, finished, text)
            Dial(stringResource(R.string.glance_recovery_score)) {
                ScoreRing(score, stringResource(R.string.glance_recovery_not_scored), ringDescription)
            }
            GaugeDial(stringResource(R.string.glance_recovery_hrv), recovery.hrv, stringResource(R.string.charts_units_milliseconds), recovery, today, finished, text)
        }
        val caption = stringResource(if (finished) R.string.glance_recovery_caption_finished else R.string.glance_recovery_caption)
        if (wide && index.strip.count { it.value != null } > 1) {
            val openNamed = stringResource(R.string.glance_open_day_named)
            Column {
                // The web's index strip draws no band: it hands Sparkline no baseline and no bands.
                Strip(
                    days = index.strip.map { it.copy(band = null) },
                    baseline = null,
                    current = today,
                    formatValue = { it.roundToLong().toString() },
                    label = stringResource(if (finished) R.string.glance_recovery_strip_finished else R.string.glance_recovery_strip),
                    description = caption,
                    openLabel = { Strings.fill(openNamed, mapOf("date" to GlanceFormat.longDate(it, text.locale))) },
                    onOpenDay = onOpenDay,
                )
                Caption(caption)
            }
        }
        val line = if (score == null) {
            stringResource(if (finished) R.string.glance_recovery_unscored_finished else R.string.glance_recovery_unscored)
        } else {
            bandWords
        }
        if (line != null) {
            Text(line, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        words.respiratoryLine(recovery.respiratoryRate)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.negative)
        }
    }
}

/** A dial and its label under it. */
@Composable
private fun Dial(label: String, extra: String? = null, content: @Composable () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        content()
        CardLabel(label)
        if (extra != null) {
            Text(extra, style = MaterialTheme.typography.labelSmall, color = LocalGlanceColors.current.textFaint)
        }
    }
}

/**
 * A reading's gauge, or "No reading yet" in its place. The gauge's description is the web's: the
 * name, the value and its unit, then the usual line.
 */
@Composable
private fun GaugeDial(
    label: String,
    figure: GlanceFigure,
    unit: String,
    recovery: GlanceRecovery,
    today: String,
    finished: Boolean,
    text: CardText,
) {
    val value = figure.value
    if (value == null) {
        Dial(label) {
            Text(
                stringResource(if (finished) R.string.glance_no_reading_finished else R.string.glance_no_reading),
                style = MaterialTheme.typography.bodySmall,
                color = LocalGlanceColors.current.textMuted,
            )
        }
        return
    }
    val words = text.words
    val asOf = if (figure.asOfDate != recovery.index.asOfDate) words.asOfLine(figure, today, finished = finished) else null
    val description = listOfNotNull("$label ${words.figure(figure)} $unit", words.usualLine(figure)).joinToString(", ")
    Dial(label, asOf) {
        // The web hands its gauge no baseline at all when the usual is thin, so the arc centres on
        // the value rather than on a usual too thin to judge by.
        Gauge(value, figure.baseline?.takeUnless { it.thin }, figure.standing, unit, description)
    }
}
