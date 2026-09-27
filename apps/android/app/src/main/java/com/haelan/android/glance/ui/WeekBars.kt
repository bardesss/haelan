package com.haelan.android.glance.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.Strings
import com.haelan.android.glance.format.WeekLine
import com.haelan.android.glance.geometry.weekBars

// The web's bars: every day at 55%, the day shown whole (app.css, .week-bar).
private const val DAY_ALPHA = 0.55f

/**
 * A week row's seven bars, drawn from [weekBars]: oldest first, the day shown last and whole, a
 * silent day a gap rather than a bar of no height. Each bar is named in words (its long date, the
 * row's name and its value as the row prints figures), so a screen reader hears the seven days the
 * shape draws. A bar whose day is not [current], the day already open, opens it through
 * [onOpenDay]; the others are only named.
 */
@Composable
internal fun WeekBars(row: WeekLine, color: Color, current: String, text: CardText, onOpenDay: (String) -> Unit, modifier: Modifier = Modifier) {
    val bars = weekBars(row.values)
    val barWords = stringResource(R.string.glance_week_bar)
    val openWords = stringResource(R.string.glance_week_open_bar)
    Row(
        modifier.width(112.dp).height(44.dp).semantics { contentDescription = row.barsLabel },
        verticalAlignment = Alignment.Bottom,
    ) {
        bars.forEachIndexed { index, bar ->
            val date = row.dates[index]
            val value = row.values[index]
            if (bar == null || value == null) {
                Spacer(Modifier.weight(1f))
                return@forEachIndexed
            }
            val words = mapOf(
                "date" to GlanceFormat.longDate(date, text.locale),
                "label" to row.label,
                "value" to text.words.weekBarValue(row.kind, value),
            )
            val opens = date != current
            val slot = Modifier
                .weight(1f)
                .fillMaxHeight()
                .then(if (opens) Modifier.clickable(role = Role.Button) { onOpenDay(date) } else Modifier)
                .semantics { contentDescription = Strings.fill(if (opens) openWords else barWords, words) }
                .padding(end = 3.dp)
            Box(slot, contentAlignment = Alignment.BottomCenter) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .fillMaxHeight(bar.height)
                        .background(color.copy(alpha = if (bar.shownDay) 1f else DAY_ALPHA), RoundedCornerShape(2.dp)),
                )
            }
        }
    }
}
