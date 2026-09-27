package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.CalendarUiState
import com.haelan.android.glance.Glance
import com.haelan.android.glance.GlanceUiState
import com.haelan.android.glance.GlanceUiState.Problem
import com.haelan.android.glance.format.GlanceFormat
import com.haelan.android.glance.format.GlanceWords
import com.haelan.android.glance.format.WorkoutWords
import java.time.ZoneId
import java.util.Locale

/** The four cards the glance can show. */
enum class CardKind { NIGHT, RECOVERY, TODAY, WEEK }

/**
 * One card on the page. [wide] is recovery with the page to itself (no night above it), which on
 * the web puts the seven-day index strip beside the dials; on a phone it goes under them.
 */
data class CardSlot(val kind: CardKind, val wide: Boolean = false)

/** Whether recovery has anything to draw: the index or either reading beside it. */
internal fun hasRecovery(glance: Glance): Boolean = with(glance.recovery) {
    index.value != null || restingHeartRate.value != null || hrv.value != null
}

/** Whether any week row has a figure. */
internal fun hasWeek(glance: Glance): Boolean = with(glance.week) {
    steps != null || activeMinutes != null || asleep != null
}

/**
 * The cards and their order, the web's dashboardRows.ts read for a phone, where every card has the
 * row to itself: night, recovery, today, week. The same rules decide which show, rather than cards
 * hiding themselves: no night, no night card, and recovery goes wide; no recovery reading at all,
 * no recovery card; no week figure, no week card. Today always shows: the page's first-run state
 * catches the day with nothing at all before this is asked.
 */
internal fun cardRows(glance: Glance): List<CardSlot> {
    val night = glance.sleep != null
    return buildList {
        if (night) add(CardSlot(CardKind.NIGHT))
        if (hasRecovery(glance)) add(CardSlot(CardKind.RECOVERY, wide = !night))
        add(CardSlot(CardKind.TODAY))
        if (hasWeek(glance)) add(CardSlot(CardKind.WEEK))
    }
}

/** What goes under the top bar. */
sealed interface GlanceBody {
    /** Nothing to draw yet. */
    data object Waiting : GlanceBody

    /** The web's first run: "Nothing here yet", said once instead of four empty cards. */
    data object Empty : GlanceBody

    /** Nothing kept and the instance not reached: one page with Try again, not a spinner forever. */
    data object Unreachable : GlanceBody

    data class Cards(val glance: Glance, val cards: List<CardSlot>) : GlanceBody
}

/**
 * The body for [state]. The first-run rule is the repository's (holdsNoValue, set as
 * [Problem.FirstRun] on every glance it draws), read here rather than decided a second time.
 */
internal fun bodyOf(state: GlanceUiState?): GlanceBody {
    val glance = state?.glance
    return when {
        state?.problem == Problem.FirstRun -> GlanceBody.Empty
        glance == null && state?.reachable == false && !state.loading -> GlanceBody.Unreachable
        glance == null -> GlanceBody.Waiting
        else -> GlanceBody.Cards(glance, cardRows(glance))
    }
}

/** The one line under the top bar, over whatever the body is. */
sealed interface GlanceNotice {
    /** The glance on screen could not be confirmed: "Shown from 07:42, not reachable". */
    data class Offline(val fetchedAtMs: Long) : GlanceNotice

    /** The instance predates the glance, or the day route: it wants updating. */
    data object TooOld : GlanceNotice

    /** The instance refused today's glance, in its own words. */
    data class Refused(val message: String) : GlanceNotice
}

/**
 * The line for [state], or none. What the instance said about itself comes first; failing that, a
 * glance shown from the device while the instance is out of reach says since when. With nothing
 * shown there is nothing to date, and the Unreachable body says it instead.
 */
internal fun noticeOf(state: GlanceUiState?): GlanceNotice? {
    val problem = state?.problem
    val fetchedAtMs = state?.fetchedAtMs
    return when {
        problem == Problem.TooOld -> GlanceNotice.TooOld
        problem is Problem.Refused -> GlanceNotice.Refused(problem.message)
        state?.reachable == false && state.glance != null && fetchedAtMs != null -> GlanceNotice.Offline(fetchedAtMs)
        else -> null
    }
}

/**
 * Everything a card needs to word itself: the sentences, the workout rows, and the locale and zone
 * the few words built in place (a long date, a clock time) are written in. One per composition.
 */
class CardText(val words: GlanceWords, val workouts: WorkoutWords, val locale: Locale, val zone: ZoneId)

/** The [CardText] for the phone's language and [zone], rebuilt when either changes. */
@Composable
fun rememberCardText(zone: ZoneId): CardText {
    val resources = LocalResources.current
    val locale = glanceLocale(LocalConfiguration.current.locales[0])
    return remember(resources, locale, zone) {
        val strings = ResourceStrings(resources)
        CardText(GlanceWords(strings, locale, zone), WorkoutWords(strings, locale), locale, zone)
    }
}

/**
 * The glance: the web dashboard's phone layout, the cards stacked under a top bar that greets on
 * today and names the date on a finished day. Draws [state] and nothing else; every tap leaves
 * through a callback, [onOpenDay] for an arrow, a strip dot, a week bar or a calendar day (a local
 * date from the payload) and [onOpenPage] for a card's link or a workout row (the web path it would
 * open, and the card's heading as the opened page's title).
 *
 * A row under the top bar carries the day controls ([DayNavState]): ‹ and ›, the calendar, and
 * Today on a past day. Pulling the page down asks again ([onRefresh]), as Try again does on the unreachable page;
 * the pull's spinner shows only for a pull, since the page also revalidates on its own (on resume,
 * after a sync) and the web does not announce those either.
 *
 * [nowMs] is read once for the greeting, which is the only thing on the page the payload does not
 * say: it is the person's hour, not a fact about their data.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlanceScreen(
    state: GlanceUiState?,
    text: CardText,
    nowMs: Long,
    onOpenSync: () -> Unit,
    onOpenDay: (String) -> Unit,
    onOpenPage: (path: String, title: String) -> Unit,
    calendar: CalendarUiState? = null,
    onToday: () -> Unit = {},
    onRefresh: () -> Unit = {},
    onOpenCalendar: (selected: String, today: String) -> Unit = { _, _ -> },
    onShowMonth: (String) -> Unit = {},
    onCloseCalendar: () -> Unit = {},
) {
    val shownDay = state?.shownDay
    val nav = DayNavState.from(state)
    val title = if (shownDay == null) text.words.greeting(nowMs) else GlanceFormat.headerDate(shownDay, text.locale, short = true)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = {
                    IconButton(onClick = onOpenSync) {
                        Icon(
                            painter = painterResource(R.drawable.ic_sync),
                            contentDescription = stringResource(R.string.glance_sync_open),
                        )
                    }
                },
            )
        },
    ) { padding ->
        // Set by a pull and cleared when the read it started lands, so a revalidation nobody asked
        // for (on resume, after a sync) never spins the pull indicator.
        var pulled by remember { mutableStateOf(false) }
        val loading = state?.loading == true
        LaunchedEffect(loading) { if (!loading) pulled = false }
        Column(Modifier.fillMaxSize().padding(padding)) {
            // Outside the scroll and the stepping dim, on every body: always reachable, always at
            // full strength, and the page keeps its shape whether or not there is a day to step to.
            DayRow(nav, onOpenDay, onToday, onOpenCalendar)
            PullToRefreshBox(
                isRefreshing = pulled && loading,
                onRefresh = {
                    pulled = true
                    onRefresh()
                },
                modifier = Modifier.fillMaxWidth().weight(1f),
            ) {
                Column(Modifier.fillMaxSize()) {
                    noticeOf(state)?.let { Notice(it, text) }
                    Box(Modifier.fillMaxWidth().weight(1f)) {
                        when (val body = bodyOf(state)) {
                            GlanceBody.Waiting -> Centred { if (loading) CircularProgressIndicator() }
                            GlanceBody.Empty -> Centred { EmptyGlance() }
                            GlanceBody.Unreachable -> Centred { UnreachableGlance(onRefresh) }
                            is GlanceBody.Cards -> Cards(body, shownDay, nav.stepping, text, onOpenDay, onOpenPage)
                        }
                    }
                }
            }
        }
    }
    if (calendar != null) {
        CalendarSheet(
            calendar = calendar,
            text = text,
            onShowMonth = onShowMonth,
            onPick = onOpenDay,
            onToday = onToday,
            onDismiss = onCloseCalendar,
        )
    }
}

/**
 * ‹, ›, the calendar and, on a past day, Today: the web's DayNav, on its own row under the top bar
 * as the web header has it, since a 360dp bar holding them beside the title and sync left the title
 * a few letters. Disabled rather than hidden where there is nowhere to go, so the row keeps its
 * shape; Today alone comes and goes, at the far end, as on the web. Touch only: the web's arrow keys
 * and T are a keyboard's, and a phone has none.
 */
@Composable
private fun DayRow(
    nav: DayNavState,
    onOpenDay: (String) -> Unit,
    onToday: () -> Unit,
    onOpenCalendar: (selected: String, today: String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DayButtons(nav, onOpenDay, onOpenCalendar)
        Spacer(Modifier.weight(1f))
        if (nav.showToday) {
            TextButton(onClick = onToday) { Text(stringResource(R.string.glance_day_nav_today)) }
        }
    }
}

/** The row's three icon buttons: ‹, › and the calendar. */
@Composable
private fun DayButtons(
    nav: DayNavState,
    onOpenDay: (String) -> Unit,
    onOpenCalendar: (selected: String, today: String) -> Unit,
) {
    IconButton(onClick = { nav.previous?.let(onOpenDay) }, enabled = nav.previous != null) {
        Icon(painterResource(R.drawable.ic_chevron_left), stringResource(R.string.glance_day_nav_previous))
    }
    IconButton(onClick = { nav.next?.let(onOpenDay) }, enabled = nav.next != null) {
        Icon(painterResource(R.drawable.ic_chevron_right), stringResource(R.string.glance_day_nav_next))
    }
    IconButton(
        onClick = { nav.today?.let { today -> onOpenCalendar(nav.selected ?: today, today) } },
        enabled = nav.calendarEnabled,
    ) {
        Icon(painterResource(R.drawable.ic_calendar), stringResource(R.string.glance_day_nav_calendar))
    }
}

/** The notice line under the top bar: the offline time, or what the instance said about itself. */
@Composable
private fun Notice(notice: GlanceNotice, text: CardText) {
    val line = when (notice) {
        is GlanceNotice.Offline -> text.words.offlineLine(notice.fetchedAtMs)
        GlanceNotice.TooOld -> stringResource(R.string.glance_too_old)
        is GlanceNotice.Refused -> notice.message
    }
    Text(
        line,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/**
 * [content] centred in the space it is given, and scrollable, so the pull to refresh reaches the
 * short pages too: the pull is a nested scroll, and a page that cannot scroll never starts one.
 */
@Composable
private fun Centred(content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight),
            contentAlignment = Alignment.Center,
        ) { content() }
    }
}

@Composable
private fun Cards(
    body: GlanceBody.Cards,
    shownDay: String?,
    stepping: Boolean,
    text: CardText,
    onOpenDay: (String) -> Unit,
    onOpenPage: (path: String, title: String) -> Unit,
) {
    val glance = body.glance
    Column(
        Modifier.fillMaxSize()
            // The previous day's cards, held while the day asked for loads, are drawn dimmed as the
            // web's dashboard-grid-stale is, so they do not read as that day's.
            .alpha(if (stepping) STEPPING_ALPHA else 1f)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // The line the web prints under its title: the date and the span today, the past line on a
        // finished day. Under the bar rather than in it, where a phone has room for it to wrap.
        Text(
            text.words.dayLine(glance, shownDay, stepping),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        body.cards.forEach { slot ->
            when (slot.kind) {
                CardKind.NIGHT -> glance.sleep?.let { NightCard(it, glance.today, glance.finished, text, onOpenDay, onOpenPage) }
                CardKind.RECOVERY -> RecoveryCard(glance.recovery, glance.today, glance.finished, slot.wide, text, onOpenDay, onOpenPage)
                CardKind.TODAY -> TodayCard(glance.day, glance.today, glance.finished, text, onOpenDay, onOpenPage)
                CardKind.WEEK -> WeekCard(glance, text, onOpenDay)
            }
        }
    }
}

/** The web's `.dashboard-grid-stale { opacity: .6 }`. */
private const val STEPPING_ALPHA = 0.6f

/** Nothing kept and nothing reached: the web shell's "did not answer" page, with its Try again. */
@Composable
private fun UnreachableGlance(onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(R.string.shell_error_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.shell_error_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        TextButton(onClick = onRetry) { Text(stringResource(R.string.shell_error_retry)) }
    }
}

@Composable
private fun EmptyGlance() {
    Column(
        Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(R.string.glance_empty_title),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.glance_empty_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
