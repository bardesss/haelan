package com.haelan.android.glance

import com.haelan.android.glance.QuickLogClient.Answer
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Everything the log sheet can be asked to do; [LogSheetModel] in the app. */
interface LogSheetActions {
    fun step(day: String)
    fun dismiss()
    fun retryLoad()
    fun chooseMood(score: Int?)
    fun tap(kind: String)
    fun undo()
    fun undoExpired(seq: Int)
    fun typeNote(text: String)
    fun commitNote()
    fun startEdit()
    fun cancelEdit()
    fun typeDraft(text: String)
    fun addDraft()
    fun addSuggestion(kind: String)
    fun removeKind(kind: String)
    fun moveKind(kind: String, by: Int)
    fun saveEdit()
}

/**
 * The log sheet's calls and its state: [LogSheetState] decides, this sends. Every call runs on
 * [dispatcher] and its answer is fed back into the state of the day it was made for.
 *
 * The state is kept per day for the model's life, not only for the day on screen. A tap still out
 * when the reader steps away or closes the sheet lands in its own day's state, so reopening that
 * day shows the count with it, and a note saved as the sheet closes is already that day's note
 * when it reopens, whether or not the save or the glance refresh behind it has landed yet (the
 * web's useSaveNote fix: an edit to the old note would otherwise save over the new one).
 *
 * The screen's own day opens from the glance's `log`, or from its kept state until a glance has
 * caught up with it ([LogSheetState.caughtUpWith]); any other day opens from what is kept and reads
 * `GET /quick-log/day/{date}` behind it. The read waits for every write for that day still out, and
 * is asked again if another starts while it is out, so its answer never lands between a write and
 * that write's own answer: a tap it already counts would otherwise be counted a second time when
 * the tap's answer folds its one in (the web's LogPanel waits the same way, in `refreshed`).
 *
 * The chips are the person's, not the day's, so a saved list goes to every kept day.
 *
 * After every write that lands, [onWrote] refreshes the screen's glance; a 401 calls [onSignedOut].
 * The public methods are called on the main thread.
 */
class LogSheetModel(
    private val calls: () -> QuickLogCalls,
    dispatcher: CoroutineDispatcher,
    private val onWrote: () -> Unit,
    private val onSignedOut: () -> Unit,
) : LogSheetActions, AutoCloseable {

    // Never cancelled: a note saved as the screen goes away must still be sent, and a blocking
    // call cannot be interrupted anyway. [close] only stops the answers reaching the screen.
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val lock = Any()

    /** Each day's sheet as last left; guarded by [lock]. */
    private val days = mutableMapOf<String, LogSheetState>()

    /** The day on screen, or null while the sheet is closed; guarded by [lock]. */
    private var shown: String? = null

    /** The day the screen's glance is for, whose log the sheet was opened from; guarded by [lock]. */
    private var screenDay: String? = null
    private var screenLog: DayLog? = null

    /** The writes still out per day, which a read of that day waits for; guarded by [lock]. */
    private val pending = mutableMapOf<String, MutableSet<Job>>()

    /** How many writes have started per day, so a read can tell one started while it was out; guarded by [lock]. */
    private val started = mutableMapOf<String, Int>()

    @Volatile
    private var closed = false

    private val mutableState = MutableStateFlow<LogSheetState?>(null)

    /** The sheet, or null while it is closed. */
    val state: StateFlow<LogSheetState?> = mutableState.asStateFlow()

    /** Opens the sheet on the screen's day, [day], whose glance carried [log]. */
    fun open(day: String, log: DayLog) {
        synchronized(lock) {
            screenDay = day
            screenLog = log
            show(day, log.today)
        }
    }

    /**
     * A glance arrived for [day]: the kept sheet for it is let go once the glance has caught up,
     * so the next opening draws the glance's newer counts and mood. Never the sheet on screen.
     */
    fun glanceArrived(day: String, log: DayLog) {
        synchronized(lock) {
            // The newer log is what the screen's day opens from next, whether or not the sheet
            // is on it now: stepping back to it must not rebuild it from the log it opened with.
            if (day == screenDay) screenLog = log
            if (day == shown) return
            if (days[day]?.caughtUpWith(log) == true) days.remove(day)
        }
    }

    /**
     * The instance confirmed [today] as the person's today, in a today glance. Every kept day learns
     * it, so a day that was today is now a day like any other (titled by its date, › live). A sheet
     * open on an older today (opened on the stored glance before the refresh landed, or left up
     * across midnight) stays open and is retitled in place: it no longer says "Log for today" but
     * names its date, with › leading to the new today. It keeps its day rather than move to the new
     * today, since a sheet that changed its day under the reader's finger would be worse, and it
     * stays open rather than close, since closing would drop a note still being typed: nothing
     * saves on the way out of a sheet that is already gone. The draft stays in the field, and
     * nothing is sent until the reader does something further with it.
     */
    fun todayConfirmed(today: String) {
        synchronized(lock) {
            for (day in days.keys.toList()) days[day] = days.getValue(day).copy(today = today)
            publish()
        }
    }

    override fun step(day: String) {
        synchronized(lock) {
            val current = shown?.let { days[it] } ?: return
            saveNoteOf(current)
            show(day, current.today)
        }
    }

    override fun dismiss() {
        synchronized(lock) {
            shown?.let { days[it] }?.let { saveNoteOf(it) }
            shown = null
            publish()
        }
    }

    override fun retryLoad() {
        synchronized(lock) { shown?.let { read(it) } }
    }

    /** Guarded by [lock]: shows [day], from what is kept or the glance, reading it when it is not the screen's. */
    private fun show(day: String, today: String) {
        val kept = days[day]?.reopened()
        val fromGlance = if (day == screenDay) screenLog else null
        days[day] = kept ?: LogSheetState.open(day, today, fromGlance)
        shown = day
        publish()
        if (day != screenDay) read(day)
    }

    /**
     * Reads [day]'s log once no write for it is out. An answer is kept only if no write started
     * while it was being asked for; otherwise it may or may not count that write, and the read
     * goes round again once the write has been answered.
     */
    private fun read(day: String) {
        scope.launch {
            while (true) {
                val (writes, mark) = synchronized(lock) { pending[day].orEmpty().toList() to started[day] }
                writes.joinAll()
                if (synchronized(lock) { started[day] != mark }) continue
                val answer = calls().dayLog(day)
                val kept = synchronized(lock) {
                    if (started[day] != mark) return@synchronized false
                    settle(day, answer) { state, log, problem ->
                        if (log != null) state.loaded(log) else state.loadFailed(problem!!)
                    }
                    true
                }
                if (kept) break
            }
        }
    }

    override fun chooseMood(score: Int?) {
        val next = change { it.moodChosen(score) } ?: return
        val seq = next.moodSeq
        write(next.day, { calls().setMood(next.day, score) }) { state, done, problem ->
            if (done != null) state.moodSaved(seq, score) else state.moodFailed(seq, problem!!)
        }
    }

    override fun tap(kind: String) {
        val next = change { it.tapped(kind) } ?: return
        val seq = next.tapSeq
        val since = next.generation
        write(next.day, { calls().tap(kind, next.day) }) { state, event, problem ->
            if (event != null) state.tapLogged(seq, kind, event.id, since) else state.tapFailed(kind, problem!!)
        }
    }

    override fun undo() {
        val (state, slot) = synchronized(lock) {
            val state = shown?.let { days[it] } ?: return
            val slot = state.undo ?: return
            days[state.day] = state.undoing() ?: return
            publish()
            state to slot
        }
        val since = state.generation
        write(state.day, { calls().undo(slot.eventId) }) { day, done, problem ->
            if (done != null) day.undone(slot.kind, since) else day.undoFailed(slot.kind, problem!!)
        }
    }

    override fun undoExpired(seq: Int) {
        change { it.undoExpired(seq) }
    }

    override fun typeNote(text: String) {
        change { it.noteTyped(text) }
    }

    override fun commitNote() {
        synchronized(lock) { shown?.let { days[it] }?.let { saveNoteOf(it) } }
    }

    /** Guarded by [lock]: sends [state]'s note if it needs saving, counted as saved from now. */
    private fun saveNoteOf(state: LogSheetState) {
        val (next, save) = state.commitNote()
        if (save == null) return
        days[state.day] = next
        publish()
        write(save.day, { calls().saveNote(save.day, save.body) }) { day, done, problem ->
            if (done != null) day.noteSettled() else day.noteFailed(save, problem!!)
        }
    }

    override fun startEdit() {
        change { it.editStarted() }
    }

    override fun cancelEdit() {
        change { it.editCancelled() }
    }

    override fun typeDraft(text: String) {
        change { it.draftTyped(text) }
    }

    override fun addDraft() {
        change { it.draftAdded() }
    }

    override fun addSuggestion(kind: String) {
        change { it.suggestionAdded(kind) }
    }

    override fun removeKind(kind: String) {
        change { it.kindRemoved(kind) }
    }

    override fun moveKind(kind: String, by: Int) {
        change { it.kindMoved(kind, by) }
    }

    override fun saveEdit() {
        val (day, kinds) = synchronized(lock) {
            val state = shown?.let { days[it] } ?: return
            val (next, kinds) = state.editSaving() ?: return
            days[state.day] = next
            publish()
            // An unchanged list has already left edit mode, and sends nothing.
            state.day to (kinds ?: return)
        }
        write(day, { calls().savePresets(kinds) }) { state, saved, problem ->
            if (saved == null) return@write state.editFailed(problem!!)
            // Inside settle, so under [lock]: the list is the person's, and every kept day takes it.
            for (other in days.keys.toList()) if (other != day) days[other] = days.getValue(other).presetsSaved(saved)
            screenLog = screenLog?.copy(presets = saved)
            state.editSaved(saved)
        }
    }

    override fun close() {
        closed = true
    }

    /** Applies [transition] to the sheet on screen and publishes it; the new state, or null with none. */
    private fun change(transition: (LogSheetState) -> LogSheetState): LogSheetState? = synchronized(lock) {
        val day = shown ?: return null
        val next = transition(days[day] ?: return null)
        days[day] = next
        publish()
        next
    }

    /**
     * Sends [send] for [day] and folds its answer in with [fold]: the answer's value on success,
     * otherwise null and the problem. A write that lands refreshes the glance; the sheet already
     * shows it, so only the screen behind it has something to catch up on.
     */
    private fun <T> write(
        day: String,
        send: () -> Answer<T>,
        fold: (LogSheetState, T?, SheetProblem?) -> LogSheetState,
    ): Job {
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val answer = send()
                settle(day, answer, fold)
                if (answer is Answer.Ok && !closed) onWrote()
            } finally {
                synchronized(lock) { pending[day]?.remove(coroutineContext[Job]) }
            }
        }
        // Counted before it can run, so a read deciding whether to wait always sees it.
        synchronized(lock) {
            pending.getOrPut(day) { mutableSetOf() } += job
            started[day] = (started[day] ?: 0) + 1
        }
        job.start()
        return job
    }

    /** Folds [answer] into [day]'s state, whichever day is on screen now. */
    private fun <T> settle(day: String, answer: Answer<T>, fold: (LogSheetState, T?, SheetProblem?) -> LogSheetState) {
        val (value, problem) = when (answer) {
            is Answer.Ok -> answer.value to null
            is Answer.Refused -> null to SheetProblem.Said(answer.message)
            Answer.Unauthorised, is Answer.Unreachable -> null to SheetProblem.Unreachable
        }
        if (answer is Answer.Unauthorised && !closed) onSignedOut()
        synchronized(lock) {
            val state = days[day] ?: return
            days[day] = fold(state, value, problem)
            publish()
        }
    }

    /** Guarded by [lock]. */
    private fun publish() {
        mutableState.value = shown?.let { days[it] }
    }
}
