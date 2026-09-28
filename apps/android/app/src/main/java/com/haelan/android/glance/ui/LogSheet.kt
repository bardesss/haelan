package com.haelan.android.glance.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.haelan.android.R
import com.haelan.android.glance.LogSheetActions
import com.haelan.android.glance.LogSheetState
import com.haelan.android.glance.PresetEdit
import com.haelan.android.glance.format.LogWords
import kotlinx.coroutines.launch

/** The sheet's words for the phone's language, rebuilt when it changes. */
@Composable
private fun rememberLogWords(text: CardText): LogWords {
    val resources = LocalResources.current
    return remember(resources, text.locale) { LogWords(ResourceStrings(resources), text.locale) }
}

/**
 * The log sheet (M9c's log panel, as the phone's Material bottom sheet): the day it logs for with
 * ‹ › and ✕, how the day felt, a chip per preset counting the day's taps, and the day's note.
 * Draws [state] and nothing else; every gesture leaves through [actions], and [LogSheetState]
 * decides what it does.
 *
 * The undo line is a Snackbar inside the sheet, where the web's undo line sits between the chips
 * and the note: the screen's own Scaffold is under the scrim while the sheet is up. It lasts
 * [SnackbarDuration.Long], ten seconds, and a newer tap's slot replaces it, which cancels the old
 * one's wait.
 *
 * The note is saved on the done key, on losing focus, and as the sheet leaves composition (a
 * dismiss by swipe, scrim or back, or ✕); [LogSheetState.commitNote] makes the second and third
 * of a run free.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogSheet(state: LogSheetState, text: CardText, actions: LogSheetActions) {
    val words = rememberLogWords(text)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(actions)
    DisposableEffect(Unit) { onDispose { latest.commitNote() } }
    ModalBottomSheet(onDismissRequest = actions::dismiss, sheetState = sheetState) {
        Column(
            // imePadding so the keyboard lifts the note and the add field into view; insets the
            // sheet has already consumed are not counted twice.
            Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            TitleRow(state, words, actions) {
                scope.launch { sheetState.hide() }.invokeOnCompletion { actions.dismiss() }
            }
            val log = state.log
            when {
                log != null -> LogBody(state, words, actions)
                state.loadProblem != null -> Column(
                    Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    ProblemLine(words.problem(state.loadProblem))
                    TextButton(onClick = actions::retryLoad) { Text(stringResource(R.string.shell_error_retry)) }
                }
                else -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }
}

/** ‹, the title over its long date, ›, and ✕: › is disabled on today, where there is no tomorrow yet. */
@Composable
private fun TitleRow(state: LogSheetState, words: LogWords, actions: LogSheetActions, onClose: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { actions.step(state.previousDay) }) {
            Icon(painterResource(R.drawable.ic_chevron_left), stringResource(R.string.log_panel_previous_day))
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                words.title(state),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                words.subtitle(state),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        IconButton(onClick = { state.nextDay?.let(actions::step) }, enabled = state.nextDay != null) {
            Icon(painterResource(R.drawable.ic_chevron_right), stringResource(R.string.log_panel_next_day))
        }
        IconButton(onClick = onClose) {
            Icon(painterResource(R.drawable.ic_close), stringResource(R.string.control_row_close))
        }
    }
}

@Composable
private fun LogBody(state: LogSheetState, words: LogWords, actions: LogSheetActions) {
    SectionLabel(stringResource(R.string.log_panel_mood_label))
    MoodFaces(state.mood, words, actions::chooseMood)
    state.moodProblem?.let { ProblemLine(words.problem(it)) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { SectionLabel(stringResource(R.string.log_panel_chips_label)) }
        if (state.edit == null) {
            TextButton(onClick = actions::startEdit) { Text(stringResource(R.string.log_panel_chips_edit)) }
        }
    }
    val edit = state.edit
    if (edit != null) {
        PresetEditor(edit, state.suggestions, words, actions)
    } else {
        Chips(state, words, actions)
    }
    UndoLine(state, words, actions)
    state.chipsProblem?.let { ProblemLine(words.problem(it)) }

    SectionLabel(stringResource(R.string.log_panel_note_label))
    NoteField(state, actions)
    state.noteProblem?.let { ProblemLine(words.problem(it)) }
}

/** The web's `.label`: a small upper-case heading over a section. */
@Composable
private fun SectionLabel(label: String) {
    Text(
        label.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { heading() },
    )
}

/** The line under a section whose write failed, announced as it appears. */
@Composable
private fun ProblemLine(line: String) {
    Text(
        line,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/**
 * The five faces as a radio group that can be emptied: a tap on the marked face clears it, since
 * "no answer" is a real state for a mood (MoodFaces.tsx's own KDoc).
 */
@Composable
private fun MoodFaces(mood: Int?, words: LogWords, onChoose: (Int?) -> Unit) {
    Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        MOUTHS.forEachIndexed { index, mouth ->
            val score = index + 1
            val on = score == mood
            val shape = RoundedCornerShape(12.dp)
            Column(
                Modifier.weight(1f)
                    .heightIn(min = 64.dp)
                    .then(
                        if (on) {
                            Modifier.background(MaterialTheme.colorScheme.secondaryContainer, shape)
                                .border(1.dp, MaterialTheme.colorScheme.primary, shape)
                        } else {
                            Modifier
                        },
                    )
                    .selectable(selected = on, role = Role.RadioButton) { onChoose(if (on) null else score) }
                    .padding(vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Face(mouth, Modifier.size(32.dp))
                Text(words.mood(score), style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center)
            }
        }
    }
}

/**
 * One face: MoodFaces.tsx's 32-unit drawing (a circle, two eyes, a mouth from frown to grin),
 * stroked in the content colour.
 */
@Composable
private fun Face(mouth: Mouth, modifier: Modifier) {
    val colour = LocalContentColor.current
    Canvas(modifier) {
        val unit = size.minDimension / 32f
        val stroke = Stroke(width = 1.8f * unit, cap = StrokeCap.Round)
        drawCircle(colour, radius = 13f * unit, center = Offset(16f * unit, 16f * unit), style = stroke)
        drawCircle(colour, radius = 1.2f * unit, center = Offset(11.5f * unit, 13f * unit))
        drawCircle(colour, radius = 1.2f * unit, center = Offset(20.5f * unit, 13f * unit))
        val path = Path().apply {
            moveTo(10f * unit, mouth.endY * unit)
            quadraticTo(16f * unit, mouth.controlY * unit, 22f * unit, mouth.endY * unit)
        }
        drawPath(path, colour, style = stroke)
    }
}

/** A mouth from x 10 to 22 at [endY], bent through [controlY]: level when the two are equal. */
private class Mouth(val endY: Float, val controlY: Float)

// The web's five mouths (MoodFaces.tsx's MOUTHS), frown to grin; the level one is its `L` segment.
private val MOUTHS = listOf(Mouth(22f, 16f), Mouth(21f, 18f), Mouth(20f, 20f), Mouth(19f, 22f), Mouth(18f, 25f))

/** A chip per preset, its count beside the name once there is one, named with it for TalkBack. */
@Composable
private fun Chips(state: LogSheetState, words: LogWords, actions: LogSheetActions) {
    val log = state.log ?: return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        log.presets.forEach { kind ->
            val count = state.count(kind)
            val on = count > 0
            val name = words.chipName(kind, count, state.isToday)
            AssistChip(
                onClick = { actions.tap(kind) },
                label = {
                    Row(
                        Modifier.clearAndSetSemantics {},
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(words.kind(kind))
                        if (on) CountBadge(count)
                    }
                },
                colors = if (on) {
                    AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
                } else {
                    AssistChipDefaults.assistChipColors()
                },
                border = if (on) BorderStroke(1.dp, MaterialTheme.colorScheme.primary) else AssistChipDefaults.assistChipBorder(true),
                modifier = Modifier.heightIn(min = 44.dp).semantics { contentDescription = name },
            )
        }
    }
}

@Composable
private fun CountBadge(count: Int) {
    Box(
        Modifier.background(MaterialTheme.colorScheme.surfaceVariant, CircleShape).padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * The undo line: a Snackbar for the latest tap, for ten seconds. Keyed on the slot, so a newer tap
 * cancels the wait (and the Snackbar) of the one before it; the ten seconds running out, or a
 * swipe, empties the slot only if it is still that tap's.
 */
@Composable
private fun UndoLine(state: LogSheetState, words: LogWords, actions: LogSheetActions) {
    val host = remember { SnackbarHostState() }
    val slot = state.undo
    val message = slot?.let { words.undoLine(it.kind, state) }
    val action = stringResource(R.string.log_panel_undo_action)
    LaunchedEffect(slot) {
        if (slot == null || message == null) return@LaunchedEffect
        val result = host.showSnackbar(message, actionLabel = action, duration = SnackbarDuration.Long)
        if (result == SnackbarResult.ActionPerformed) actions.undo() else actions.undoExpired(slot.seq)
    }
    SnackbarHost(host)
}

/**
 * The day's note. Saved when it loses focus and on the keyboard's done key (which also lets focus
 * go, so the keyboard closes); emptied, it deletes the note.
 *
 * The field edits a value of its own, with its cursor and the IME's composing span, and pushes the
 * text to the model as it changes: a round trip through the StateFlow for every key can drop a
 * character or move the cursor under an IME. The model's text still decides what is saved. The
 * field starts over from it only when the model changes it on its own, which is a step to another
 * day or a read landing ([LogSheetState.generation]); comparing the two texts instead would reset
 * the field to a StateFlow value a keystroke behind it.
 */
@Composable
private fun NoteField(state: LogSheetState, actions: LogSheetActions) {
    val focus = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }
    var field by remember(state.day, state.generation) {
        mutableStateOf(TextFieldValue(state.noteText, TextRange(state.noteText.length)))
    }
    OutlinedTextField(
        value = field,
        onValueChange = {
            field = it
            actions.typeNote(it.text)
        },
        placeholder = { Text(stringResource(R.string.log_panel_note_placeholder)) },
        minLines = 2,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = {
            actions.commitNote()
            focus.clearFocus()
        }),
        modifier = Modifier.fillMaxWidth().onFocusChanged {
            if (focused && !it.isFocused) actions.commitNote()
            focused = it.isFocused
        },
    )
}

/**
 * The chips in edit mode (PresetEditor.tsx on a phone): each kind with move earlier, move later
 * and remove, the add field with the suggestions under it, and Cancel and Done. Buttons rather
 * than dragging, as the M9d spec's research revision rules; the web's keyboard path is the same
 * two moves.
 */
@Composable
private fun PresetEditor(edit: PresetEdit, suggestions: List<String>, words: LogWords, actions: LogSheetActions) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        edit.kinds.forEachIndexed { index, kind ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(words.kind(kind), modifier = Modifier.weight(1f).padding(start = 4.dp))
                IconButton(onClick = { actions.moveKind(kind, -1) }, enabled = index > 0) {
                    Icon(painterResource(R.drawable.ic_arrow_up), words.moveEarlier(kind))
                }
                IconButton(onClick = { actions.moveKind(kind, 1) }, enabled = index < edit.kinds.lastIndex) {
                    Icon(painterResource(R.drawable.ic_arrow_down), words.moveLater(kind))
                }
                IconButton(onClick = { actions.removeKind(kind) }) {
                    Icon(painterResource(R.drawable.ic_close), words.remove(kind))
                }
            }
        }
        // The web's sr-only announcement after a move, read out by TalkBack and not shown.
        edit.moved?.let { kind ->
            val position = edit.kinds.indexOf(kind) + 1
            Box(Modifier.semantics { liveRegion = LiveRegionMode.Polite; contentDescription = words.moved(kind, position) })
        }
        // The keyboard's done key adds, and so does Add beside the field, for a reader who never
        // finds the key; Done below takes a kind still typed here with it (editSaving).
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = edit.draft,
                onValueChange = actions::typeDraft,
                enabled = !edit.full,
                singleLine = true,
                placeholder = { Text(stringResource(R.string.log_panel_edit_add)) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { actions.addDraft() }),
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = actions::addDraft,
                enabled = edit.canAdd,
                modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp),
            ) { Text(stringResource(R.string.log_panel_edit_add_button)) }
        }
        if (!edit.full && suggestions.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                suggestions.forEach { kind ->
                    SuggestionChip(onClick = { actions.addSuggestion(kind) }, label = { Text(words.kind(kind)) })
                }
            }
        }
        if (edit.full) {
            Text(
                stringResource(R.string.log_panel_edit_full),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        edit.problem?.let { ProblemLine(words.editProblem(it)) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            TextButton(onClick = actions::cancelEdit) { Text(stringResource(R.string.log_panel_edit_cancel)) }
            Button(onClick = actions::saveEdit, enabled = !edit.saving) { Text(stringResource(R.string.log_panel_edit_done)) }
        }
    }
}
