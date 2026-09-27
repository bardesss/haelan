package com.haelan.android.glance.format

import com.haelan.android.glance.EditProblem
import com.haelan.android.glance.LogSheetState
import com.haelan.android.glance.SheetProblem
import java.util.Locale

/**
 * The log sheet's words, worded as the web's LogPanel.tsx, MoodFaces.tsx and PresetEditor.tsx word
 * them, from the same `logPanel.*` and `annotate.event.kinds.*` text. [Strings] and its key scheme
 * are the glance's (GlanceWords' KDoc), so the sheet's text is held to the web's by the same guard.
 */
class LogWords(private val strings: Strings, private val locale: Locale) {

    private fun t(key: String, vararg args: Pair<String, String>): String = strings.get(key, args.toMap())

    /** "Log for today", "Log for yesterday", or "Log for Tue, Sep 22": the short date, as the web's. */
    fun title(state: LogSheetState): String = when {
        state.isToday -> t("log_panel_title_today")
        state.isYesterday -> t("log_panel_title_yesterday")
        else -> t("log_panel_title_day", "day" to GlanceFormat.headerDate(state.day, locale, short = true))
    }

    /** The full date beneath the title. */
    fun subtitle(state: LogSheetState): String = GlanceFormat.longDate(state.day, locale)

    /** A seed kind in the reader's language; a person's own kind as they typed it. */
    fun kind(kind: String): String = if (kind in LogSheetState.SEED_KINDS) t("annotate_event_kinds_$kind") else kind

    /** A chip's spoken name: the kind alone at zero, otherwise with the day's count. */
    fun chipName(kind: String, count: Int, isToday: Boolean): String = when {
        count == 0 -> kind(kind)
        isToday -> t("log_panel_chips_count_today", "kind" to kind(kind), "count" to count.toString())
        else -> t("log_panel_chips_count_day", "kind" to kind(kind), "count" to count.toString())
    }

    /** "Caffeine logged", or "… logged for yesterday" / "… for Saturday, September 5" on another day. */
    fun undoLine(kind: String, state: LogSheetState): String = if (state.isToday) {
        t("log_panel_undo_today", "kind" to kind(kind))
    } else {
        val day = if (state.isYesterday) t("glance_subtitle_yesterday") else GlanceFormat.longDate(state.day, locale)
        t("log_panel_undo_day", "kind" to kind(kind), "day" to day)
    }

    /** A face's word, [score] 1 (Bad) to 5 (Great). */
    fun mood(score: Int): String = t("log_panel_mood_$score")

    /** A failed read or write: what the instance said, or the shell's "did not answer" line. */
    fun problem(problem: SheetProblem): String = when (problem) {
        is SheetProblem.Said -> problem.message
        SheetProblem.Unreachable -> t("shell_error_title")
    }

    /** The edit list's refusals, in the reader's language where the phone can say them. */
    fun editProblem(problem: EditProblem): String = when (problem) {
        is EditProblem.Duplicate -> t("log_panel_edit_duplicate", "kind" to kind(problem.kind))
        EditProblem.Full -> t("log_panel_edit_full")
        is EditProblem.Failed -> problem(problem.problem)
    }

    /** The line read out after a move: "Caffeine moved to position 2". */
    fun moved(kind: String, position: Int): String =
        t("log_panel_edit_moved", "kind" to kind(kind), "position" to position.toString())

    fun remove(kind: String): String = t("log_panel_edit_remove", "kind" to kind(kind))
    fun moveEarlier(kind: String): String = t("log_panel_edit_move_earlier", "kind" to kind(kind))
    fun moveLater(kind: String): String = t("log_panel_edit_move_later", "kind" to kind(kind))
}
