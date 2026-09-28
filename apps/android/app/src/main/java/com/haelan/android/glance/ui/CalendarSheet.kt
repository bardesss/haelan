package com.haelan.android.glance.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.CalendarUiState
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.geometry.CalendarCell
import com.haelan.android.glance.geometry.SleepDot
import com.haelan.android.glance.geometry.StepsDot
import com.haelan.android.glance.geometry.calendarGrid
import com.haelan.android.glance.geometry.monthReachable
import com.haelan.android.glance.geometry.shiftMonth
import kotlinx.coroutines.launch

/**
 * The month calendar, the web's GlanceCalendar as its phone sheet: a Monday-first month of days,
 * each day with data carrying two dots - last night's sleep against its usual range on the left,
 * the day's steps against their usual on the right - and every other day grey and disabled.
 *
 * The dots are the server's verdicts (the calendar route), never judged here, and which days can be
 * picked is [calendarGrid]'s rule: those listed, never after today or before the archive's first
 * day. The month arrows stop at the first day's month and today's. A month still loading is drawn
 * all grey, so nothing can be picked from a listing that has not arrived.
 *
 * Touch only, like the rest of the phone glance: the web's arrow-key grid is its keyboard path, and
 * TalkBack walks these cells as buttons, each named with its date and both verdicts in words.
 *
 * Picking a day, or Today, hands it on and slides the sheet away; [onDismiss] runs once it is gone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarSheet(
    calendar: CalendarUiState,
    text: CardText,
    onShowMonth: (String) -> Unit,
    onPick: (String) -> Unit,
    onToday: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun leave(then: () -> Unit) {
        then()
        scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() }
    }
    val title = stringResource(R.string.glance_day_nav_calendar)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            MonthHead(calendar, text, onShowMonth)
            MonthGrid(calendar, text) { day -> leave { onPick(day) } }
            Legend()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.glance_calendar_grey_days),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { leave(onToday) }, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text(stringResource(R.string.glance_calendar_today))
                }
            }
        }
    }
}

/** The month's title between its two arrows, each disabled where the archive or today stops it. */
@Composable
private fun MonthHead(calendar: CalendarUiState, text: CardText, onShowMonth: (String) -> Unit) {
    val previous = shiftMonth(calendar.month, -1)
    val next = shiftMonth(calendar.month, 1)
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(
            onClick = { onShowMonth(previous) },
            enabled = monthReachable(previous, calendar.firstDay, calendar.today),
        ) {
            Icon(painterResource(R.drawable.ic_chevron_left), stringResource(R.string.glance_calendar_previous_month))
        }
        Text(
            GlanceFormat.monthTitle(calendar.month, text.locale),
            style = MaterialTheme.typography.titleSmall,
            textAlign = TextAlign.Center,
            // Announced when an arrow changes it, as the web's aria-live title is.
            modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
        )
        IconButton(
            onClick = { onShowMonth(next) },
            enabled = monthReachable(next, calendar.firstDay, calendar.today),
        ) {
            Icon(painterResource(R.drawable.ic_chevron_right), stringResource(R.string.glance_calendar_next_month))
        }
    }
}

/** The weekday heads and the weeks, a finger's 44dp per day as the web's phone sheet gives it. */
@Composable
private fun MonthGrid(calendar: CalendarUiState, text: CardText, onPick: (String) -> Unit) {
    val weekdays = remember(text.locale) { GlanceFormat.weekdays(text.locale) }
    val weeks = remember(calendar) {
        calendarGrid(calendar.month, calendar.loaded?.days.orEmpty(), calendar.today, calendar.firstDay)
    }
    val colors = LocalGlanceColors.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            weekdays.forEach { (initials, name) ->
                Text(
                    initials,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textFaint,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).semantics { contentDescription = name },
                )
            }
        }
        weeks.forEach { week ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                week.forEach { cell ->
                    Box(Modifier.weight(1f).height(44.dp)) {
                        if (cell != null) DayCell(cell, cell.localDate == calendar.selected, text, onPick)
                    }
                }
            }
        }
    }
}

/**
 * One day. Chosen: filled with the accent, its number and dots in the page colour; today: outlined;
 * grey: the disabled text colour and no dots. The web's cal-day states, one for one.
 */
@Composable
private fun DayCell(cell: CalendarCell, chosen: Boolean, text: CardText, onPick: (String) -> Unit) {
    val colors = LocalGlanceColors.current
    val page = MaterialTheme.colorScheme.background
    val shape = RoundedCornerShape(8.dp)
    val label = text.words.calendarDay(cell.localDate, cell.sleep, cell.steps)
    var modifier = Modifier.fillMaxWidth().height(44.dp)
    if (chosen && cell.enabled) modifier = modifier.background(colors.accent, shape)
    if (cell.isToday) modifier = modifier.border(1.dp, colors.borderChosen, shape)
    if (cell.enabled) modifier = modifier.clickable { onPick(cell.localDate) }
    modifier = modifier.clearAndSetSemantics {
        contentDescription = label
        role = Role.Button
        if (cell.enabled) selected = chosen else disabled()
    }
    val number = when {
        !cell.enabled -> MaterialTheme.colorScheme.onSurface.copy(alpha = DISABLED_ALPHA)
        chosen -> page
        else -> colors.textPrimary
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(
            cell.dayOfMonth.toString(),
            style = MaterialTheme.typography.bodySmall,
            color = number,
            fontWeight = if (chosen && cell.enabled) FontWeight.Bold else null,
        )
        if (cell.sleep != null && cell.steps != null) {
            Spacer(Modifier.height(2.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Dot(if (chosen) chosenDot(cell.sleep == SleepDot.WITHIN, cell.sleep == SleepDot.NOT_JUDGED, page) else sleepDot(cell.sleep))
                Dot(if (chosen) chosenDot(cell.steps == StepsDot.REACHED, cell.steps == StepsDot.NOT_JUDGED, page) else stepsDot(cell.steps))
            }
        }
    }
}

/** A dot's look: filled with a colour, or a ring in one. */
private data class DotLook(val color: Color, val ring: Boolean)

/** Sleep: within the usual range in `chart_scale_4`, outside it in `negative`, not judged a faint ring. */
@Composable
private fun sleepDot(sleep: SleepDot): DotLook {
    val colors = LocalGlanceColors.current
    return when (sleep) {
        SleepDot.WITHIN -> DotLook(colors.scale4, ring = false)
        SleepDot.OUTSIDE -> DotLook(colors.negative, ring = false)
        SleepDot.NOT_JUDGED -> DotLook(colors.textFaint, ring = true)
    }
}

/** Steps: reached in the accent, below it the accent at 35% over the card, not judged a faint ring. */
@Composable
private fun stepsDot(steps: StepsDot): DotLook {
    val colors = LocalGlanceColors.current
    return when (steps) {
        StepsDot.REACHED -> DotLook(colors.accent, ring = false)
        StepsDot.BELOW -> DotLook(colors.accent.copy(alpha = BELOW_ALPHA).compositeOver(colors.surfaceCard), ring = false)
        StepsDot.NOT_JUDGED -> DotLook(colors.textFaint, ring = true)
    }
}

/**
 * On the accent fill the verdict colours would vanish (the steps dot is the accent itself), so the
 * dots take the page colour: a favourable verdict filled, an unfavourable one a ring, no verdict a
 * fainter ring (the page at 45% over the accent), as the web's selected day draws them.
 */
@Composable
private fun chosenDot(favourable: Boolean, unjudged: Boolean, page: Color): DotLook = when {
    unjudged -> DotLook(page.copy(alpha = UNJUDGED_ON_ACCENT).compositeOver(LocalGlanceColors.current.accent), ring = true)
    favourable -> DotLook(page, ring = false)
    else -> DotLook(page, ring = true)
}

@Composable
private fun Dot(look: DotLook, size: Int = 5) {
    val modifier = Modifier.size(size.dp)
    Box(if (look.ring) modifier.border(1.dp, look.color, CircleShape) else modifier.background(look.color, CircleShape))
}

/**
 * Which of a day's two dots each row describes, drawn as a small pair with that dot lit, then the
 * row's name and its two keys. Hidden from TalkBack, which hears every day's dots in words already.
 */
@Composable
private fun Legend() {
    val colors = LocalGlanceColors.current
    Column(Modifier.clearAndSetSemantics { }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        LegendRow(
            litFirst = true,
            name = stringResource(R.string.glance_calendar_sleep_legend),
            keys = listOf(
                sleepDot(SleepDot.WITHIN) to stringResource(R.string.glance_calendar_sleep_within),
                sleepDot(SleepDot.OUTSIDE) to stringResource(R.string.glance_calendar_sleep_outside),
            ),
            lit = colors.textPrimary,
            unlit = colors.textFaint,
        )
        LegendRow(
            litFirst = false,
            name = stringResource(R.string.glance_calendar_steps_legend),
            keys = listOf(
                stepsDot(StepsDot.REACHED) to stringResource(R.string.glance_calendar_steps_reached),
                stepsDot(StepsDot.BELOW) to stringResource(R.string.glance_calendar_steps_below),
            ),
            lit = colors.textPrimary,
            unlit = colors.textFaint,
        )
    }
}

@Composable
private fun LegendRow(litFirst: Boolean, name: String, keys: List<Pair<DotLook, String>>, lit: Color, unlit: Color) {
    val muted = LocalGlanceColors.current.textMuted
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Dot(DotLook(if (litFirst) lit else unlit, ring = false))
            Dot(DotLook(if (litFirst) unlit else lit, ring = false))
        }
        Text(
            name,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.width(LEGEND_NAME_WIDTH.dp),
        )
        keys.forEach { (look, word) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Dot(look, size = 9)
                Text(word, style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
    }
}

/** Material's disabled-content emphasis, for a grey day's number: chrome, not a data colour. */
private const val DISABLED_ALPHA = 0.38f

/** The web's `color-mix(accent 35%, surface-card)` for steps below their usual. */
private const val BELOW_ALPHA = 0.35f

/** The web's `color-mix(surface-page 45%, accent)` for an unjudged dot on the chosen day. */
private const val UNJUDGED_ON_ACCENT = 0.45f

/** The legend's names in one column, so the two rows' keys line up as the web's subgrid has them. */
private const val LEGEND_NAME_WIDTH = 56
