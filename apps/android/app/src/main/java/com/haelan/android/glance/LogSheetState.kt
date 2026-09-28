package com.haelan.android.glance

import java.time.LocalDate

/** Why a sheet read or write failed, for the line under the section it was made in. */
sealed interface SheetProblem {
    /** The instance's own sentence, which for these routes says what was wrong with the request. */
    data class Said(val message: String) : SheetProblem

    /** No answer: the line the web shell shows when the instance did not answer. */
    data object Unreachable : SheetProblem
}

/** A mood mark not yet confirmed: [score] 1-5, or null for the mark being cleared. */
data class MoodMark(val score: Int?)

/** The one tap Undo can take back: the latest, by its [seq]. */
data class UndoSlot(val kind: String, val eventId: String, val seq: Int)

/** Why a kind could not be added, or the chips not saved. */
sealed interface EditProblem {
    /** "{{kind}} is already a chip", naming the chip as it is written, not as typed. */
    data class Duplicate(val kind: String) : EditProblem

    /** "At most 16 chips". */
    data object Full : EditProblem

    /** The save was refused, or never answered. */
    data class Failed(val problem: SheetProblem) : EditProblem
}

/**
 * The chips in edit mode: the list as it is being edited (nothing is sent until Done), the add
 * field's text, and the kind the last move put somewhere, for the web's "moved to position" line.
 */
data class PresetEdit(
    val kinds: List<String>,
    val draft: String = "",
    val problem: EditProblem? = null,
    val saving: Boolean = false,
    val moved: String? = null,
) {
    val full: Boolean get() = kinds.size >= LogSheetState.MAX_PRESETS

    /** Whether the Add button beside the field is live: something typed, and room for it. */
    val canAdd: Boolean get() = draft.isNotBlank() && !full
}

/** A note save to send: [body] for [day], and the note it replaces, to put back if it fails. */
data class NoteSave(val day: String, val body: String, val previous: String)

/**
 * The log sheet for one day, as a value: everything the web's LogBody keeps in its hooks and refs,
 * held so every transition is a plain function a JUnit test can call. [LogSheetModel] runs the
 * calls and feeds their answers back; the composable only draws what is here.
 *
 * - **Counts** are the day log's plus a delta per kind for taps and undos in flight, so a tap
 *   counts at once and a run of quick taps never waits on one another. A tap that lands moves its
 *   one from the delta into the log's count; one that fails takes it back.
 * - **The mood** shows [moodMark] while one is in flight; only the latest mark ([moodSeq]) clears
 *   it, so an earlier mark settling late cannot drop the one made after it.
 * - **Undo** holds the latest tap alone: every tap takes a sequence number, and a tap settling
 *   after a later one has started never takes the slot from it.
 * - **The note** is the field's [noteText] and [noteSaved], what the instance holds as far as the
 *   sheet knows. A commit moves [noteSaved] the moment the save starts, so a done key, a lost
 *   focus and a dismiss in a row send one save, not three. The day log takes the new note at the
 *   same moment, so a sheet reopened before the save lands shows it (the web's useSaveNote fix).
 * - **Edit mode** is [edit], null outside it.
 *
 * [inFlight] counts the calls not yet answered, which is how [caughtUpWith] knows the log here may
 * still be ahead of any glance the screen reads.
 *
 * [generation] moves with every read that replaces the log. A tap or an undo answered after a read
 * that landed while it was out does not fold its one into the log: the read is the newer account,
 * and folding again would count the tap twice. [LogSheetModel] holds its reads back until no write
 * is out, so this is the second line, not the first.
 */
data class LogSheetState(
    val day: String,
    /** The person's real today, from the day log: › stops here. */
    val today: String,
    /** The day's log, or null while a stepped day loads. */
    val log: DayLog?,
    val loadProblem: SheetProblem? = null,
    val deltas: Map<String, Int> = emptyMap(),
    val moodMark: MoodMark? = null,
    val moodSeq: Int = 0,
    /** The newest mark whose answer has been folded into the log. */
    val moodSettled: Int = 0,
    val moodProblem: SheetProblem? = null,
    val tapSeq: Int = 0,
    val undo: UndoSlot? = null,
    val chipsProblem: SheetProblem? = null,
    val noteText: String = "",
    val noteSaved: String = "",
    val noteProblem: SheetProblem? = null,
    val edit: PresetEdit? = null,
    val inFlight: Int = 0,
    val generation: Int = 0,
) {
    companion object {
        /** The server's limits (packages/core/src/api/eventKinds.ts), checked here as the web does. */
        const val MAX_PRESETS = 16
        const val MAX_PRESET_LENGTH = 40

        /** The seed kinds, which have translations; a person's own kinds show as typed. */
        val SEED_KINDS = listOf("illness", "travel", "alcohol", "medication", "injury", "caffeine")

        /** The sheet opening on [day], drawn at once from [initial] when there is one. */
        fun open(day: String, today: String, initial: DayLog?): LogSheetState {
            val note = initial?.note ?: ""
            return LogSheetState(day = day, today = initial?.today ?: today, log = initial, noteText = note, noteSaved = note)
        }

        private fun noteOf(text: String): String? = text.takeIf { it.isNotBlank() }

        /** Whether a note needs no save: what the instance holds, or blank where it holds nothing. */
        private fun unchanged(text: String, held: String): Boolean = text == held || (text.isBlank() && held.isBlank())
    }

    val isToday: Boolean get() = day == today

    /**
     * The days either side, for ‹ and ›. The one date the phone works out itself: the sheet steps
     * a calendar day at a time, as the web's yesterdayOf and nextDayOf do, and the route answers
     * for any day up to today. › is off on [today], so no step ever asks for a day after it.
     */
    val previousDay: String get() = LocalDate.parse(day).minusDays(1).toString()
    val nextDay: String? get() = if (isToday) null else LocalDate.parse(day).plusDays(1).toString()
    val isYesterday: Boolean get() = LocalDate.parse(today).minusDays(1).toString() == day

    /** The face to mark: the one in flight, or the day log's. */
    val mood: Int? get() = if (moodMark != null) moodMark.score else log?.mood

    /** The count a chip shows: the log's, plus taps in flight. */
    fun count(kind: String): Int = (log?.counts?.get(kind) ?: 0) + (deltas[kind] ?: 0)

    /**
     * What the add field offers: kinds this day already has events under, then the seed set, less
     * any already on the list being edited (the web's PresetEditor, ignoring case as the server does).
     */
    val suggestions: List<String>
        get() {
            val taken = (edit?.kinds ?: log?.presets ?: emptyList()).map { it.lowercase() }.toSet()
            return ((log?.counts?.keys ?: emptySet()) + SEED_KINDS).distinct().filter { it.lowercase() !in taken }
        }

    /**
     * Whether a glance's log for this day has caught up with this one, so the sheet can open from
     * the glance again: nothing in flight, and the same note. The note is what must never go back
     * (an edit to an old note would save over the new one); counts and a mood a glance brings are
     * newer than the sheet's, whoever made them.
     */
    fun caughtUpWith(glanceLog: DayLog): Boolean = inFlight == 0 && log?.note == glanceLog.note

    /** Reopened on a day it was on before: the log and anything in flight stay, the rest starts over. */
    fun reopened(): LogSheetState =
        copy(loadProblem = null, moodProblem = null, undo = null, chipsProblem = null, noteText = noteSaved, noteProblem = null, edit = null)

    // Loading a stepped day.

    fun loaded(fresh: DayLog): LogSheetState {
        val note = fresh.note ?: ""
        // Text typed while a read was out (a sheet opened from a kept log) is the reader's; keep it.
        val text = if (unchanged(noteText, noteSaved)) note else noteText
        return copy(today = fresh.today, log = fresh, loadProblem = null, noteText = text, noteSaved = note, generation = generation + 1)
    }

    /** A failed read shows only where there is nothing to show instead. */
    fun loadFailed(problem: SheetProblem): LogSheetState = if (log == null) copy(loadProblem = problem) else this

    // Mood.

    fun moodChosen(score: Int?): LogSheetState =
        copy(moodMark = MoodMark(score), moodSeq = moodSeq + 1, moodProblem = null, inFlight = inFlight + 1)

    fun moodSaved(seq: Int, score: Int?): LogSheetState {
        val fold = seq > moodSettled && log != null
        return copy(
            log = if (fold) log?.copy(mood = score) else log,
            moodSettled = if (fold) seq else moodSettled,
            moodMark = if (seq == moodSeq) null else moodMark,
            inFlight = inFlight - 1,
        )
    }

    fun moodFailed(seq: Int, problem: SheetProblem): LogSheetState =
        copy(moodMark = if (seq == moodSeq) null else moodMark, moodProblem = problem, inFlight = inFlight - 1)

    // Chips.

    private fun shift(kind: String, by: Int): Map<String, Int> {
        val next = (deltas[kind] ?: 0) + by
        return if (next == 0) deltas - kind else deltas + (kind to next)
    }

    private fun counted(kind: String, by: Int): DayLog? = log?.let {
        val next = (it.counts[kind] ?: 0) + by
        it.copy(counts = if (next <= 0) it.counts - kind else it.counts + (kind to next))
    }

    /** A tap: counted at once, and the previous tap's Undo gone, since only the latest is undoable. */
    fun tapped(kind: String): LogSheetState =
        copy(deltas = shift(kind, 1), tapSeq = tapSeq + 1, undo = null, chipsProblem = null, inFlight = inFlight + 1)

    /** Tap [seq] landed; [since] is the [generation] it was made in (see the class KDoc). */
    fun tapLogged(seq: Int, kind: String, eventId: String, since: Int = generation): LogSheetState = copy(
        deltas = shift(kind, -1),
        log = if (since == generation) counted(kind, 1) else log,
        undo = if (seq == tapSeq) UndoSlot(kind, eventId, seq) else undo,
        inFlight = inFlight - 1,
    )

    fun tapFailed(kind: String, problem: SheetProblem): LogSheetState =
        copy(deltas = shift(kind, -1), chipsProblem = problem, inFlight = inFlight - 1)

    /** Undo pressed: the slot empties and the count drops at once. Null with nothing to undo. */
    fun undoing(): LogSheetState? {
        val slot = undo ?: return null
        return copy(deltas = shift(slot.kind, -1), undo = null, chipsProblem = null, inFlight = inFlight + 1)
    }

    fun undone(kind: String, since: Int = generation): LogSheetState =
        copy(deltas = shift(kind, 1), log = if (since == generation) counted(kind, -1) else log, inFlight = inFlight - 1)

    fun undoFailed(kind: String, problem: SheetProblem): LogSheetState =
        copy(deltas = shift(kind, 1), chipsProblem = problem, inFlight = inFlight - 1)

    /** The ten seconds are up for tap [seq]; a later tap's slot stays. */
    fun undoExpired(seq: Int): LogSheetState = if (undo?.seq == seq) copy(undo = null) else this

    // Note.

    fun noteTyped(text: String): LogSheetState = copy(noteText = text)

    /**
     * The save the field needs, if any, and the state with it already counted as saved. Null when
     * the text is what the instance holds, which is what makes a dismiss after a lost focus free.
     */
    fun commitNote(): Pair<LogSheetState, NoteSave?> {
        if (unchanged(noteText, noteSaved)) return this to null
        val save = NoteSave(day, noteText, noteSaved)
        return copy(
            noteSaved = noteText,
            log = log?.copy(note = noteOf(noteText)),
            noteProblem = null,
            inFlight = inFlight + 1,
        ) to save
    }

    fun noteSettled(): LogSheetState = copy(inFlight = inFlight - 1)

    /**
     * A save refused: the note it replaced goes back, in the log and as the saved text, unless a
     * later save has moved on since, whose own answer is still to come.
     */
    fun noteFailed(save: NoteSave, problem: SheetProblem): LogSheetState {
        val current = noteSaved == save.body
        return copy(
            noteSaved = if (current) save.previous else noteSaved,
            log = if (current) log?.copy(note = noteOf(save.previous)) else log,
            noteProblem = problem,
            inFlight = inFlight - 1,
        )
    }

    // Edit mode.

    fun editStarted(): LogSheetState = log?.let { copy(edit = PresetEdit(it.presets)) } ?: this

    fun editCancelled(): LogSheetState = copy(edit = null)

    /** The add field's text, never longer than a kind may be (the web's maxLength). */
    fun draftTyped(text: String): LogSheetState = edit?.let { copy(edit = it.copy(draft = text.take(MAX_PRESET_LENGTH))) } ?: this

    /** The add field's text as a new kind; the web's checks, in the reader's language. */
    fun draftAdded(): LogSheetState {
        val open = edit ?: return this
        val value = open.draft.trim()
        if (value.isEmpty()) return this
        return add(open, value)?.let { copy(edit = it.copy(draft = "")) } ?: copy(edit = open.copy(problem = problemAdding(open, value)))
    }

    /** A suggestion tapped: added as it is, the add field left as the reader had it. */
    fun suggestionAdded(kind: String): LogSheetState {
        val open = edit ?: return this
        return copy(edit = add(open, kind) ?: open.copy(problem = problemAdding(open, kind)))
    }

    private fun existing(open: PresetEdit, value: String): String? = open.kinds.firstOrNull { it.equals(value, ignoreCase = true) }

    private fun add(open: PresetEdit, value: String): PresetEdit? =
        if (existing(open, value) != null || open.full) null else open.copy(kinds = open.kinds + value, problem = null, moved = null)

    private fun problemAdding(open: PresetEdit, value: String): EditProblem =
        existing(open, value)?.let { EditProblem.Duplicate(it) } ?: EditProblem.Full

    fun kindRemoved(kind: String): LogSheetState =
        edit?.let { copy(edit = it.copy(kinds = it.kinds - kind, problem = null, moved = null)) } ?: this

    /** [kind] one place earlier (-1) or later (+1); nothing at either end. */
    fun kindMoved(kind: String, by: Int): LogSheetState {
        val open = edit ?: return this
        val from = open.kinds.indexOf(kind)
        val to = from + by
        if (from == -1 || to !in open.kinds.indices) return this
        val kinds = open.kinds.toMutableList().apply { add(to, removeAt(from)) }
        return copy(edit = open.copy(kinds = kinds, moved = kind))
    }

    /**
     * Done: the list to send and the state saving it, or, for a list left as it was, the state out
     * of edit mode and nothing to send. Null while a save is already out.
     *
     * A kind still in the add field goes with the list, added first with [draftAdded]'s checks;
     * one those checks refuse keeps edit mode open with the reason, and nothing is sent, rather
     * than the kind being dropped from the save unseen.
     */
    fun editSaving(): Pair<LogSheetState, List<String>?>? {
        val open = edit ?: return null
        if (open.saving) return null
        val value = open.draft.trim()
        val ready = if (value.isEmpty()) {
            open
        } else {
            add(open, value)?.copy(draft = "") ?: return copy(edit = open.copy(problem = problemAdding(open, value))) to null
        }
        if (ready.kinds == log?.presets) return copy(edit = null) to null
        return copy(edit = ready.copy(saving = true, problem = null), inFlight = inFlight + 1) to ready.kinds
    }

    /** Saved: the chips come back in the list the instance answered with, and edit mode ends. */
    fun editSaved(kinds: List<String>): LogSheetState = copy(log = log?.copy(presets = kinds), edit = null, inFlight = inFlight - 1)

    /** Another day's sheet saved the chips: they are the person's, so this day's log takes them too. */
    fun presetsSaved(kinds: List<String>): LogSheetState = copy(log = log?.copy(presets = kinds))

    fun editFailed(problem: SheetProblem): LogSheetState =
        copy(edit = edit?.copy(saving = false, problem = EditProblem.Failed(problem)), inFlight = inFlight - 1)
}
