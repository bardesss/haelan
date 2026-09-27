package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
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
import com.haelan.android.glance.GlanceRecovery
import com.haelan.android.glance.format.GaugeKind
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.StripKind
import com.haelan.android.glance.format.Strings
import com.haelan.android.glance.geometry.dialSizes
import com.haelan.android.glance.geometry.showsStrip
import kotlin.math.roundToLong

/**
 * Recovery as three dials on one row, the web's RecoveryCard: resting heart rate and HRV as gauges
 * against their usual either side of the index's ring, the band's words under them (or why the day
 * went unscored), and the breathing-rate note on a day it rose. A gauge whose reading is for a
 * different day from the index says which. [wide] (no night card above) adds the index's seven-day
 * strip under the dials, where the web puts it beside them. The dials are sized from the row's
 * width ([dialSizes]), so all three fit a 360dp phone.
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
    DashCard(
        title = stringResource(R.string.glance_recovery_title),
        subtitle = words.recoverySubtitle(recovery, today, finished),
        link = CardLink(stringResource(R.string.glance_recovery_link), "/recovery"),
        onOpenPage = onOpenPage,
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val sizes = dialSizes(maxWidth.value)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                GaugeDial(GaugeKind.RESTING_HEART_RATE, recovery, today, finished, text, sizes.gauge, Modifier.weight(sizes.gaugeShare))
                Dial(stringResource(R.string.glance_recovery_score), null, Modifier.weight(sizes.ringShare)) {
                    ScoreRing(index.value, stringResource(R.string.glance_recovery_not_scored), words.ringDescription(recovery), size = sizes.ring.dp)
                }
                GaugeDial(GaugeKind.HRV, recovery, today, finished, text, sizes.gauge, Modifier.weight(sizes.gaugeShare))
            }
        }
        if (wide && showsStrip(index.strip)) {
            val strip = words.stripText(StripKind.RECOVERY, index, finished)
            val openNamed = stringResource(R.string.glance_open_day_named)
            Column {
                // The web's index strip draws no band: it hands Sparkline no baseline and no bands.
                Strip(
                    days = index.strip.map { it.copy(band = null) },
                    baseline = null,
                    current = today,
                    formatValue = { it.roundToLong().toString() },
                    label = strip.label,
                    description = strip.description,
                    openLabel = { Strings.fill(openNamed, mapOf("date" to GlanceFormat.longDate(it, text.locale))) },
                    onOpenDay = onOpenDay,
                )
                Caption(strip.caption)
            }
        }
        words.recoveryLine(recovery, finished)?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        words.respiratoryLine(recovery.respiratoryRate)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.negative)
        }
    }
}

/** A dial and its label under it, with the as-of line when there is one. */
@Composable
private fun Dial(label: String, extra: String?, modifier: Modifier, content: @Composable () -> Unit) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        content()
        CardLabel(label, textAlign = TextAlign.Center)
        if (extra != null) {
            Text(extra, style = MaterialTheme.typography.labelSmall, color = LocalGlanceColors.current.textFaint, textAlign = TextAlign.Center)
        }
    }
}

/** A reading's gauge, as [com.haelan.android.glance.format.GlanceWords.gaugeDial] words it, or "No reading yet" in its place. */
@Composable
private fun GaugeDial(
    kind: GaugeKind,
    recovery: GlanceRecovery,
    today: String,
    finished: Boolean,
    text: CardText,
    size: Float,
    modifier: Modifier,
) {
    val dial = text.words.gaugeDial(kind, recovery, today, finished)
    if (dial == null) {
        val name = stringResource(if (kind == GaugeKind.HRV) R.string.glance_recovery_hrv else R.string.glance_recovery_rhr)
        Dial(name, null, modifier) {
            Text(
                stringResource(if (finished) R.string.glance_no_reading_finished else R.string.glance_no_reading),
                style = MaterialTheme.typography.bodySmall,
                color = LocalGlanceColors.current.textMuted,
                textAlign = TextAlign.Center,
            )
        }
        return
    }
    Dial(dial.name, dial.asOf, modifier) {
        Gauge(dial.value, dial.baseline, dial.standing, dial.unit, dial.description, size = size.dp)
    }
}
