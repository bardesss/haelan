package com.haelan.android.glance.ui

import com.haelan.android.glance.GlanceUiState

/**
 * The top bar's day controls for one screen state, the web's DayNav read for the phone: ‹ and › to
 * the nearest days with data either side, the calendar, and on a past day a Today action.
 *
 * Where the arrows go is the payload's own `nav`, never a date computed here: the server knows which
 * days hold data, so a gap in the archive is stepped over rather than landed on. An arrow with no
 * neighbour is disabled rather than hidden, so the bar keeps its shape from one day to the next.
 *
 * **Stepping** is the web's placeholder state: a day was asked for and the glance on screen is still
 * the previous day's answer, held so the page does not blank under the finger, drawn dimmed. Its
 * `nav` names the neighbours of the wrong day, so both arrows wait for the new answer. A refresh of
 * the day already shown is not stepping: its `nav` is still the right one, and the web does not dim
 * a revalidation either.
 */
data class DayNavState(
    /** The day ‹ opens, or null when it is disabled. */
    val previous: String?,
    /** The day › opens, or null when it is disabled. */
    val next: String?,
    /**
     * Whether Today shows: on every past day, including one still loading, whatever `nav` says. On
     * yesterday `nav.next` is null while today has no data yet, and Today is then the way back.
     */
    val showToday: Boolean,
    /** The cards are the previous day's, held while the day asked for loads: drawn dimmed. */
    val stepping: Boolean,
    /**
     * The person's today, the calendar's last pickable day; null until a today glance has been
     * kept, and the calendar is disabled until then, having no edge to stop at.
     */
    val today: String?,
    /** The day the calendar opens on and marks: the day on screen, or today. */
    val selected: String?,
) {
    /** Whether the calendar can open. */
    val calendarEnabled: Boolean get() = today != null

    companion object {
        /** The controls for [state]; with nothing on screen yet every one is disabled. */
        fun from(state: GlanceUiState?): DayNavState {
            val glance = state?.glance
            val shownDay = state?.shownDay
            // The day the glance on screen was built for, in the repository's terms: its own day
            // when finished, today (null) otherwise.
            val glanceDay = glance?.takeIf { it.finished }?.today
            val stepping = state?.loading == true && glance != null && shownDay != glanceDay
            return DayNavState(
                previous = if (stepping) null else glance?.nav?.previous,
                next = if (stepping) null else glance?.nav?.next,
                showToday = shownDay != null,
                stepping = stepping,
                today = state?.today,
                selected = shownDay ?: state?.today,
            )
        }
    }
}
