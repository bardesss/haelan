package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.GlanceFigure
import com.haelan.android.glance.GlanceSleep
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.Strings
import com.haelan.android.glance.format.SleepMini
import com.haelan.android.glance.format.StripKind
import com.haelan.android.glance.geometry.showsStrip

/**
 * Last night, the web's NightCard: the time asleep in display type, efficiency, bed and wake in one
 * row, the seven-night strip with its usual shaded behind it, and the compact hypnogram with its
 * one line of totals. A small figure outside its usual takes the warning colour and says which way
 * in words, so the colour is never the only signal; the plain "within your usual" line is left to
 * the strip's description, as the web leaves it to a screen reader.
 *
 * [today] is only the strip's day already shown (the night that ended on it), which a tap does not
 * open: a night is named by the date it ended on, never "today" or "yesterday".
 */
@Composable
internal fun NightCard(
    sleep: GlanceSleep,
    today: String,
    finished: Boolean,
    text: CardText,
    onOpenDay: (String) -> Unit,
    onOpenPage: (path: String, title: String) -> Unit,
) {
    val words = text.words
    val noReading = stringResource(if (finished) R.string.glance_no_reading_finished else R.string.glance_no_reading)
    val openNamed = stringResource(R.string.glance_open_day_named)
    DashCard(
        title = stringResource(if (finished) R.string.glance_sleep_title_finished else R.string.glance_sleep_title),
        subtitle = words.nightRange(sleep),
        link = CardLink(stringResource(R.string.glance_sleep_link), "/sleep/night/${sleep.localDate}", words.nightRange(sleep)),
        onOpenPage = onOpenPage,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                words.figure(sleep.asleep) ?: noReading,
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val percent = stringResource(R.string.charts_units_percent)
                Mini(stringResource(R.string.glance_sleep_efficiency), sleep.efficiency, SleepMini.EFFICIENCY, noReading, text) { "$it $percent" }
                Mini(stringResource(R.string.glance_sleep_bed), sleep.bedtime, SleepMini.BED, noReading, text) { it }
                Mini(stringResource(R.string.glance_sleep_woke), sleep.waketime, SleepMini.WOKE, noReading, text) { it }
            }
        }
        if (showsStrip(sleep.asleep.strip)) {
            val strip = words.stripText(StripKind.NIGHT, sleep.asleep, finished)
            Column {
                Strip(
                    days = sleep.asleep.strip,
                    baseline = sleep.asleep.baseline,
                    current = today,
                    formatValue = { words.value(it, sleep.asleep.metric) },
                    label = strip.label,
                    description = strip.description,
                    openLabel = { Strings.fill(openNamed, mapOf("date" to GlanceFormat.longDate(it, text.locale))) },
                    onOpenDay = onOpenDay,
                )
                Caption(strip.caption)
            }
        }
        Hypnogram(sleep.segments, sleep.startMs, text)
    }
}

/** One small figure: its label, its value (the warning colour when outside), and the note saying which way. */
@Composable
private fun Mini(
    label: String,
    figure: GlanceFigure,
    mini: SleepMini,
    noReading: String,
    text: CardText,
    withUnit: (String) -> String,
) {
    val colors = LocalGlanceColors.current
    val out = figure.standing == GlanceStanding.ABOVE || figure.standing == GlanceStanding.BELOW
    val value = text.words.figure(figure)?.let(withUnit) ?: noReading
    val note = text.words.miniNote(mini, figure)
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = colors.textFaint)) { append(label) }
            append(" ")
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = if (out) colors.negative else colors.textPrimary)) {
                append(value)
            }
            if (note != null) {
                append(" ")
                withStyle(SpanStyle(color = colors.negative)) { append(note) }
            }
        },
        style = MaterialTheme.typography.bodyMedium,
    )
}
