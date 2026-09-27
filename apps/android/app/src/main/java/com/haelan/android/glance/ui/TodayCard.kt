package com.haelan.android.glance.ui

import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.GlanceDay
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.PaceStanding
import com.haelan.android.glance.WorkoutSession
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.StripKind
import com.haelan.android.glance.format.Strings
import com.haelan.android.glance.format.TodayLine
import com.haelan.android.glance.geometry.showsStrip
import com.haelan.android.glance.geometry.traceWindow

/**
 * Today, the web's TodayCard: steps and active minutes side by side, the line under them (a
 * finished day's verdict, today's pace, or the so-far line), the seven-day steps strip, the heart
 * rate trace from local midnight with the workouts shaded on it, and the workouts themselves, each
 * row opening its own page. A finished day is the same card for a day already over: "That day"
 * with its date, and the trace across the whole day.
 */
@Composable
internal fun TodayCard(
    day: GlanceDay,
    today: String,
    finished: Boolean,
    text: CardText,
    onOpenDay: (String) -> Unit,
    onOpenPage: (String) -> Unit,
) {
    val words = text.words
    val colors = LocalGlanceColors.current
    val noReading = stringResource(if (finished) R.string.glance_no_reading_finished else R.string.glance_no_reading)
    DashCard(
        title = stringResource(if (finished) R.string.glance_today_that_day else R.string.glance_today_title),
        subtitle = if (finished) GlanceFormat.longDate(today, text.locale) else stringResource(R.string.glance_today_subtitle),
        link = CardLink(stringResource(R.string.glance_today_link), "/activity"),
        onOpenPage = onOpenPage,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.Bottom) {
                Column {
                    CardLabel(stringResource(R.string.glance_today_steps))
                    Text(words.figure(day.steps) ?: noReading, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                }
                Column {
                    CardLabel(stringResource(R.string.glance_today_active_minutes))
                    Text(
                        buildAnnotatedString {
                            append(words.figure(day.activeMinutes) ?: noReading)
                            append(" ")
                            withStyle(SpanStyle(color = colors.textMuted, fontWeight = FontWeight.Normal)) {
                                append(stringResource(R.string.activity_units_min))
                            }
                        },
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            words.todayLine(day, finished)?.let { line -> TodayLineText(line) }
        }
        if (showsStrip(day.steps.strip)) {
            val strip = words.stripText(StripKind.STEPS, day.steps, finished)
            val openNamed = stringResource(R.string.glance_open_day_named)
            Column {
                Strip(
                    days = day.steps.strip,
                    baseline = day.steps.baseline,
                    current = today,
                    formatValue = { words.value(it, day.steps.metric) },
                    label = strip.label,
                    description = strip.description,
                    openLabel = { Strings.fill(openNamed, mapOf("date" to GlanceFormat.longDate(it, text.locale))) },
                    onOpenDay = onOpenDay,
                )
                Caption(strip.caption)
            }
        }
        if (day.heartRate.points.isNotEmpty()) {
            val window = traceWindow(today, finished, text.zone)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                CardLabel(stringResource(if (finished) R.string.glance_today_heart_rate_whole_day else R.string.glance_today_heart_rate_since_midnight))
                HeartRateTrace(day.heartRate.points, window.startMs, window.endMs, day.workouts, words.traceDescription(day.heartRate, finished))
            }
        }
        if (day.workouts.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                CardLabel(stringResource(if (finished) R.string.glance_workouts_title_that_day else R.string.glance_workouts_title))
                day.workouts.forEach { WorkoutRow(it, text, onOpenPage) }
            }
        }
    }
}

/** The line under the two figures: the verdict's word, in the ahead colour above or ahead, then its usual. */
@Composable
private fun TodayLineText(line: TodayLine) {
    val colors = LocalGlanceColors.current
    val (word, rest, ahead) = when (line) {
        is TodayLine.Verdict -> Triple(line.word, line.range, line.standing == GlanceStanding.ABOVE)
        is TodayLine.Pace -> Triple(line.word, line.usualBy, line.standing == PaceStanding.AHEAD)
        is TodayLine.Usual -> Triple(null, line.text, false)
    }
    Text(
        buildAnnotatedString {
            if (word != null) {
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = if (ahead) colors.positive else colors.textPrimary)) {
                    append(word)
                }
                append(" · ")
            }
            withStyle(SpanStyle(color = colors.textMuted)) { append(rest) }
        },
        style = MaterialTheme.typography.bodyMedium,
    )
}

/**
 * One workout, the Activity list's row: type and duration, calories and heart rate, then distance,
 * pace and climb, each only when recorded. The whole row opens the workout's page; an excluded one
 * stays listed, struck through, with why.
 */
@Composable
private fun WorkoutRow(session: WorkoutSession, text: CardText, onOpenPage: (String) -> Unit) {
    val colors = LocalGlanceColors.current
    val line = text.workouts.line(session)
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button) { onOpenPage("/activity/${Uri.encode(session.id)}") }
            .padding(vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                line.type,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                textDecoration = if (session.excluded) TextDecoration.LineThrough else null,
            )
            Text(line.duration, style = MaterialTheme.typography.bodyMedium, color = colors.textMuted)
            line.stats?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.End,
                )
            }
        }
        line.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.textMuted) }
        line.excluded?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.textFaint) }
    }
}
