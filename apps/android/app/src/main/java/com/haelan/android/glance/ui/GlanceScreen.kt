package com.haelan.android.glance.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.haelan.android.R
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
        glance == null -> GlanceBody.Waiting
        else -> GlanceBody.Cards(glance, cardRows(glance))
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
 * through a callback, [onOpenDay] for a strip dot or a week bar (a local date from the payload) and
 * [onOpenPage] for a card's link or a workout row (the web path it would open).
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
    onOpenPage: (String) -> Unit,
) {
    val shownDay = state?.shownDay
    val title = if (shownDay == null) text.words.greeting(nowMs) else GlanceFormat.headerDate(shownDay, text.locale, short = true)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
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
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (val body = bodyOf(state)) {
                GlanceBody.Waiting -> if (state?.loading == true) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                GlanceBody.Empty -> EmptyGlance(Modifier.align(Alignment.Center))
                is GlanceBody.Cards -> Cards(body, text, onOpenDay, onOpenPage)
            }
        }
    }
}

@Composable
private fun Cards(body: GlanceBody.Cards, text: CardText, onOpenDay: (String) -> Unit, onOpenPage: (String) -> Unit) {
    val glance = body.glance
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // The line the web prints under its title: the date and the span today, the past line on a
        // finished day. Under the bar rather than in it, where a phone has room for it to wrap.
        Text(
            text.words.headerLine(glance),
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

@Composable
private fun EmptyGlance(modifier: Modifier) {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
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
