package com.haelan.android.glance

// The ViewModel's three decisions, as pure functions over the screen's state, so each is tested
// without an Application or a main dispatcher: which read a tap on a day becomes, whether a finished
// sync asks again, and whether a return to the foreground does.

/** What a request for a day comes to, given what is on screen. */
sealed interface DayRequest {
    /** Back to today: the kept glance at once, revalidated with its ETag. */
    data object Today : DayRequest

    /** A past day, read live. */
    data class Day(val localDate: String) : DayRequest

    /** Nothing to do: that day is already on screen or already asked for. */
    data object None : DayRequest

    companion object {
        /**
         * [localDate] as a payload named it (an arrow's `nav`, a strip dot, a week bar, a calendar
         * day). The person's today goes back to today rather than being read as a past day, which
         * would skip the kept glance and its ETag; the day already on screen, or on its way, is not
         * asked again, as the web's setDay has it.
         */
        fun of(state: GlanceUiState, localDate: String): DayRequest = when (localDate) {
            state.today -> today(state)
            state.shownDay -> None
            else -> Day(localDate)
        }

        /** The Today action, or the calendar's Today: back to today, unless today is what is shown. */
        fun today(state: GlanceUiState): DayRequest = if (state.shownDay != null) Today else None
    }
}

/**
 * Whether a finished sync asks the instance again. Today is what a sync changes, so only today; a
 * past day on screen is left alone, and the person gets today's news on going back to it.
 */
fun shouldRefreshOnSync(state: GlanceUiState): Boolean = state.shownDay == null

/**
 * Whether a return to the foreground asks again. The first resume after the screen's state was
 * built comes straight after the open, which already asked; every later one is a real return
 * (from the sync screen, another app, the phone asleep), and asks.
 */
class ResumeRule {
    private var resumedBefore = false

    /** Called on each resume; true when this one should refresh. */
    fun onResume(): Boolean {
        val refresh = resumedBefore
        resumedBefore = true
        return refresh
    }
}
