package com.haelan.android.glance

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.haelan.android.InstanceClient
import com.haelan.android.SessionStore
import com.haelan.android.glance.GlanceClient.CalendarRead
import com.haelan.android.glance.GlanceClient.GlanceRead
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.ZoneId

/**
 * The month calendar's sheet while it is open: the month shown, what the instance listed for it
 * (null while it loads), and the edges its arrows stop at.
 */
data class CalendarUiState(
    /** YYYY-MM. */
    val month: String,
    /** The day the sheet marks as chosen: the day on screen, or today. */
    val selected: String,
    /** The person's today, the last pickable day; a payload's word for it (GlanceUiState.today). */
    val today: String,
    /** The month's listing, or null while it loads or after a read that got none. */
    val loaded: CalendarMonth?,
    /**
     * The archive's first day, remembered across months (the web keeps it in a ref), so a month
     * still loading keeps the ‹ arrow's answer from the last one. Null until a month has said.
     */
    val firstDay: String?,
)

/**
 * The glance screen's state for as long as the screen is wanted, rotations included: the repository
 * (so the day on screen survives a rotation, where an Activity-owned one started over on today), the
 * person's zone, the open calendar, and the two freshness triggers that are not the screen's own
 * gestures, the return to the foreground and a finished sync.
 *
 * The repository is registered with [GlanceRegistry] as it is built, so a sign-out closes it before
 * deleting the stored glance, and closed through the registry when the screen is gone for good.
 *
 * The public methods are called on the main thread, as the repository's are.
 */
class GlanceViewModel(app: Application, session: SessionStore.Session) : AndroidViewModel(app) {

    companion object {
        private const val TAG = "haelan-glance"

        /**
         * How long a sync's run of per-type writes is let settle before the glance asks again. A run
         * writes one timestamp per type as each finishes, seconds apart at most; one refresh at the
         * end is the same answer as a dozen along the way, which would each cost a read.
         */
        private const val SYNC_SETTLE_MS = 2_000L

        /**
         * How long past the person's midnight the glance asks for the new today: a few seconds, so a
         * server clock a little behind the phone's has turned the day too by the time it answers.
         */
        private const val MIDNIGHT_MARGIN_MS = 5_000L

        /** Builds the model for [session]; a rotation gets the existing one back instead. */
        fun factory(app: Application, session: SessionStore.Session): ViewModelProvider.Factory =
            viewModelFactory { initializer { GlanceViewModel(app, session) } }
    }

    private val server = session.server
    private val personId = session.personId
    private val prefs = SessionStore.prefs(app)

    /** The cookie the reads send; replaced when the same person signs in again (see [useCookie]). */
    @Volatile
    private var cookie = session.cookie

    private val reads = SessionReads(GlanceClient(server, personId, cookie))

    private val repository = GlanceRegistry.app.register(
        GlanceRepository(
            reads = reads,
            store = GlanceStore.encrypted(app),
            server = server,
            personId = personId,
            clock = System::currentTimeMillis,
            dispatcher = Dispatchers.IO,
            // Read only once a read starts, after init: mutableZone is built by then.
            zone = { mutableZone.value },
        ),
    )

    val state: StateFlow<GlanceUiState> = repository.state

    private val mutableZone = MutableStateFlow(
        PersonZone.choose(SessionStore.loadTimezone(prefs, server, personId), ZoneId.systemDefault()),
    )

    /** The zone every clock time on the glance is read in: the person's, the phone's until it is known. */
    val zone: StateFlow<ZoneId> = mutableZone.asStateFlow()

    private val mutableCalendar = MutableStateFlow<CalendarUiState?>(null)

    /** The calendar sheet, or null while it is closed. */
    val calendar: StateFlow<CalendarUiState?> = mutableCalendar.asStateFlow()

    /** The first day a calendar month named, kept for the next month opened. */
    private var firstDay: String? = null

    // Conflated like the repository's: a calendar 401 can land while the screen is stopped.
    private val calendarSignedOut = Channel<Unit>(Channel.CONFLATED)

    /**
     * The log sheet: its calls follow the session's cookie as the reads do, a write that lands
     * refreshes the glance behind it, and a 401 signs out as a calendar 401 does.
     */
    private val logSheetModel = LogSheetModel(
        calls = { QuickLogClient(server, personId, cookie) },
        dispatcher = Dispatchers.IO,
        onWrote = { viewModelScope.launch { repository.refresh() } },
        onSignedOut = { calendarSignedOut.trySend(Unit) },
    )

    /** The log sheet, or null while it is closed. */
    val logSheet: StateFlow<LogSheetState?> = logSheetModel.state

    /** What the log sheet's gestures call. */
    val logActions: LogSheetActions = logSheetModel

    /** Fires when the instance refused the session, from a glance read or a calendar read. */
    val signedOut: Flow<Unit> = merge(repository.signedOut, calendarSignedOut.receiveAsFlow())

    private var syncRefresh: Job? = null

    // A field: SharedPreferences holds its listeners weakly (SyncSignal's KDoc).
    private val syncSignal = SyncSignal(prefs) { viewModelScope.launch { syncFinished() } }

    private val resumeRule = ResumeRule()

    init {
        repository.open()
        readZone()
        syncSignal.start()
        // Each glance that arrives tells the log sheet what the server now holds for its day, and a
        // today glance the instance confirmed tells it which day today is.
        viewModelScope.launch {
            state.collect { ui ->
                val glance = ui.glance ?: return@collect
                if (ui.confirmed && !glance.finished) logSheetModel.todayConfirmed(glance.today)
                glance.log?.let { logSheetModel.glanceArrived(glance.today, it) }
            }
        }
        // Midnight ends today while the screen may be up with no read due: ask again then, so the
        // new today's glance arrives, and an open log sheet is retitled by its date (todayConfirmed).
        // Re-armed after each refresh it fires, and from scratch when the person's zone is read.
        viewModelScope.launch {
            zone.collectLatest { zone ->
                while (true) {
                    delay(PersonZone.untilNextMidnight(System.currentTimeMillis(), zone) + MIDNIGHT_MARGIN_MS)
                    repository.refresh()
                }
            }
        }
    }

    /**
     * The + in the top bar: the log sheet on the day the glance shows, from the glance's own log.
     * Only on a glance the instance confirmed today, as the + itself (showsLogButton).
     */
    fun openLog() {
        val ui = state.value
        if (!confirmedNow(ui, System.currentTimeMillis(), zone.value)) return
        val glance = ui.glance ?: return
        logSheetModel.open(glance.today, glance.log ?: return)
    }

    /** Opens [localDate], as a payload named it; [DayRequest.of] decides which read that is. */
    fun open(localDate: String) = request(DayRequest.of(state.value, localDate))

    /** Back to today, from the Today action or the calendar's Today. */
    fun showToday() = request(DayRequest.today(state.value))

    private fun request(request: DayRequest) {
        when (request) {
            DayRequest.Today -> repository.showToday()
            is DayRequest.Day -> repository.showDay(request.localDate)
            DayRequest.None -> Unit
        }
    }

    /** Pull to refresh and Try again: ask again for what is on screen. */
    fun refresh() = repository.refresh()

    /** The screen came back to the foreground; [ResumeRule] says whether that asks again. */
    fun resumed() {
        if (resumeRule.onResume()) repository.refresh()
    }

    /**
     * The same person signed in again, with a new session. The reads move to the new cookie, and the
     * glance asks again, since whatever the old one met (a 401 among them) no longer holds.
     */
    fun useCookie(newCookie: String) {
        if (newCookie == cookie) return
        cookie = newCookie
        reads.client = GlanceClient(server, personId, newCookie)
        readZone()
        repository.refresh()
    }

    /** Opens the calendar on [selected]'s month; [today] from the payload bounds it. */
    fun openCalendar(selected: String, today: String) {
        val month = selected.take(7)
        mutableCalendar.value = CalendarUiState(month, selected, today, loaded = null, firstDay = firstDay)
        loadMonth(month)
    }

    /** A month arrow: shows [month] and reads its listing. */
    fun showMonth(month: String) {
        val open = mutableCalendar.value ?: return
        mutableCalendar.value = open.copy(month = month, loaded = null)
        loadMonth(month)
    }

    fun closeCalendar() {
        mutableCalendar.value = null
    }

    override fun onCleared() {
        syncSignal.close()
        logSheetModel.close()
        GlanceRegistry.app.close(repository)
    }

    /** A type finished syncing: once the run settles, [shouldRefreshOnSync] says whether to ask again. */
    private fun syncFinished() {
        syncRefresh?.cancel()
        syncRefresh = viewModelScope.launch {
            delay(SYNC_SETTLE_MS)
            if (shouldRefreshOnSync(state.value)) repository.refresh()
        }
    }

    /**
     * Asks the instance for the person's zone and keeps it. A miss changes nothing: the kept zone or
     * the phone's stays, and a refused session is the glance read's to act on, not this one's.
     */
    private fun readZone() {
        val cookieNow = cookie
        viewModelScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                InstanceClient.get(server, PersonZone.ME_PATH, cookieNow) { it.body }
            }
            val zoneId = (outcome as? InstanceClient.Outcome.Ok)?.value?.let(PersonZone::parseMe)
            if (zoneId == null) {
                Log.w(TAG, "the person's timezone was not read: $outcome")
                return@launch
            }
            SessionStore.saveTimezone(prefs, server, personId, zoneId)
            mutableZone.value = ZoneId.of(zoneId)
        }
    }

    /** Reads [month]'s listing and shows it, unless the sheet has moved on or closed meanwhile. */
    private fun loadMonth(month: String) {
        viewModelScope.launch {
            val read = withContext(Dispatchers.IO) { reads.client.calendar(month) }
            val listing = when (read) {
                is CalendarRead.Fresh -> try {
                    GlanceParser.parseCalendar(read.json)
                } catch (e: GlanceParseException) {
                    Log.w(TAG, "the calendar for $month could not be read: ${e.message}")
                    null
                }
                CalendarRead.Unauthorised -> {
                    calendarSignedOut.trySend(Unit)
                    null
                }
                else -> {
                    // Every other day stays grey: nothing to pick is the honest drawing of no answer.
                    Log.w(TAG, "the calendar for $month did not load: $read")
                    null
                }
            }
            if (listing != null) firstDay = listing.firstDay
            val open = mutableCalendar.value ?: return@launch
            if (open.month != month) return@launch
            mutableCalendar.value = open.copy(loaded = listing, firstDay = firstDay)
        }
    }

    /**
     * The reads, through whichever client holds the current cookie. The repository keeps this one
     * object for its whole life, so a new sign-in swaps the client under it instead of rebuilding
     * the repository and losing the day on screen.
     */
    private class SessionReads(@Volatile var client: GlanceClient) : GlanceReads {
        override fun today(etag: String?): GlanceRead = client.today(etag)
        override fun day(localDate: String): GlanceRead = client.day(localDate)
    }
}
