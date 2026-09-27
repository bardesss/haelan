import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../icons.js'
import { Loading } from '../Loading.js'
import { ErrorState } from '../ErrorState.js'
import { MoodFaces } from './MoodFaces.js'
import { PresetEditor } from './PresetEditor.js'
import { useSession } from '../../auth/session.js'
import type { GlanceLog } from '../../data/useGlance.js'
import { SEED_KINDS } from '../../data/eventKinds.js'
import {
  dayLogKey, useDayLog, useQuickLogTap, useSaveNote, useSetMood, useUndoTap,
} from '../../data/useQuickLog.js'
import { formatHeaderDate, formatLongDate, nextDayOf, yesterdayOf } from '../../pages/dashboard/glanceText.js'

/** How long the undo line stays after a tap (spec M9c, "Undo"). */
const UNDO_MS = 10_000

// Looked up rather than assembled, so css-classes.test.ts reads both names as written.
const CHIP_CLASS = { on: 'log-chip is-on', off: 'log-chip' } as const

/** Whether a note needs no save: the text the server holds, or blank where it holds nothing. */
function unchanged(body: string, held: string): boolean {
  return body === held || (body.trim() === '' && held.trim() === '')
}

/** The failure line under the section whose write failed: the server's own message, which for
 *  these routes is the one sentence that says what was wrong with the request. */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The log panel's contents (M9c, "The log panel"): the day it logs for with ‹ › to step and ✕ to
 * close, how the day felt, a chip per preset counting the day's taps, and the day's note. Only the
 * contents: where it sits (a popover on a desktop, a sheet on a phone) is its container's business,
 * and `titleId` is how that container names its dialog after the heading here.
 *
 * `initial` is the day's log when the caller already has it (the glance carries today's), so the
 * panel opens drawn rather than loading. A stepped day has none and loads with the title already
 * in place, since the title needs nothing but the date.
 *
 * › is aria-disabled rather than removed on today, so the row keeps its shape and the button its
 * place in the tab order: there is no tomorrow to log for yet.
 */
export function LogPanel({ day, today, initial, onStep, onClose, titleId }: {
  day: string
  today: string
  initial?: GlanceLog
  onStep: (day: string) => void
  onClose: () => void
  titleId: string
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const log = useDayLog(day, initial)
  const isToday = day === today
  // The title's date is the short one: the full one is the line beneath it, and saying it twice
  // in two sizes told the reader nothing the second time.
  const title = isToday ? t('logPanel.titleToday')
    : day === yesterdayOf(today) ? t('logPanel.titleYesterday')
      : t('logPanel.titleDay', { day: formatHeaderDate(day, language, true) })

  return (
    <div className="log-panel">
      <div className="log-top">
        <button type="button" className="icon-button" aria-label={t('logPanel.previousDay')}
          onClick={() => onStep(yesterdayOf(day))}><Icon name="chevronLeft" /></button>
        <div className="log-title">
          <h2 id={titleId}>{title}</h2>
          <small>{formatLongDate(day, language)}</small>
        </div>
        <button type="button" className="icon-button" aria-label={t('logPanel.nextDay')}
          aria-disabled={isToday ? true : undefined}
          onClick={() => { if (!isToday) onStep(nextDayOf(day)) }}><Icon name="chevronRight" /></button>
        <button type="button" className="icon-button" aria-label={t('controlRow.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {log.data !== undefined
        // Keyed on the day, so every piece of local state below (a mark not yet confirmed, counts
        // in flight, the undo line, a half-typed note) belongs to the day it was made on and is
        // gone when the reader steps to another.
        ? <LogBody key={day} day={day} isToday={isToday} isYesterday={day === yesterdayOf(today)} log={log.data} />
        : log.isError ? <ErrorState onRetry={() => { void log.refetch() }} error={log.error} /> : <Loading />}
    </div>
  )
}

function LogBody({ day, isToday, isYesterday, log }: { day: string, isToday: boolean, isYesterday: boolean, log: GlanceLog }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const personId = useSession().data?.personId
  const setMood = useSetMood()
  const tap = useQuickLogTap()
  const undo = useUndoTap()
  const saveNote = useSaveNote()
  const moodLabelId = useId()
  const noteId = useId()
  // Edit mode swaps the chips row for the editor and nothing else: the mood, the undo line and the
  // note stay where they are and keep working.
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  // Whether focus goes back to Edit on the next render: only on leaving edit mode, never on mount.
  const returnFocus = useRef(false)
  useEffect(() => {
    if (editing || !returnFocus.current) return
    returnFocus.current = false
    editButton.current?.focus()
  }, [editing])
  function leaveEditing() {
    returnFocus.current = true
    setEditing(false)
  }
  // What the add field offers: the kinds this day already has events under (a kind typed into the
  // chart panel, say), then the seed set. The editor drops the ones already on the list.
  const suggestions = [...new Set([...Object.keys(log.counts), ...SEED_KINDS])]

  /** Resolves once the day log holds the server's answer again: the refetch the hook's own
   *  invalidation already started, joined rather than repeated (cancelRefetch: false). An optimistic
   *  copy is dropped only then, so the screen never falls back to the old answer in between, and
   *  never counts a tap twice by adding it to an answer that already includes it. */
  function refreshed(): Promise<void> {
    if (personId === undefined) return Promise.resolve()
    return queryClient.invalidateQueries({ queryKey: dayLogKey(personId, day) }, { cancelRefetch: false })
  }

  // Mood: `undefined` while nothing is in flight, otherwise the mark the reader just made.
  const [pendingMood, setPendingMood] = useState<number | null | undefined>(undefined)
  const [moodError, setMoodError] = useState<string | null>(null)
  const mood = pendingMood === undefined ? log.mood : pendingMood
  // Which mark is the latest, so an earlier one settling late cannot drop the mark made after it.
  const moodSeq = useRef(0)

  function changeMood(score: number | null) {
    const seq = ++moodSeq.current
    setPendingMood(score)
    setMoodError(null)
    const settle = () => { if (seq === moodSeq.current) setPendingMood(undefined) }
    setMood.mutateAsync({ day, score }).then(
      () => refreshed().finally(settle),
      (error: unknown) => { settle(); setMoodError(failureText(error)) },
    )
  }

  // Chips: taps in flight per kind, added to the loaded counts, so a tap counts at once and a run of
  // quick taps never waits on one another. mutateAsync rather than mutate's own callbacks, which
  // TanStack fires for the latest call alone.
  const [deltas, setDeltas] = useState<Record<string, number>>({})
  const [chipsError, setChipsError] = useState<string | null>(null)
  const [undoable, setUndoable] = useState<{ kind: string, eventId: string } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shift = (kind: string, by: number) => setDeltas((current) => ({ ...current, [kind]: (current[kind] ?? 0) + by }))
  const countOf = (kind: string) => (log.counts[kind] ?? 0) + (deltas[kind] ?? 0)

  function clearUndo() {
    if (undoTimer.current !== null) clearTimeout(undoTimer.current)
    undoTimer.current = null
    setUndoable(null)
  }
  // Whether this day's body is still on screen: a tap can settle after the reader has stepped to
  // another day or closed the panel, and must not arm a timer for a line nobody will see.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (undoTimer.current !== null) clearTimeout(undoTimer.current)
    }
  }, [])
  // Which tap is the latest. Taps do not wait on one another, so they can settle out of order, and
  // only the latest one's line may show: an earlier tap settling late must not replace it.
  const tapSeq = useRef(0)

  function onTap(kind: string) {
    const seq = ++tapSeq.current
    // Only the latest tap is undoable, so the previous one's line (and its timer) goes the moment
    // another starts.
    clearUndo()
    setChipsError(null)
    shift(kind, 1)
    tap.mutateAsync({ kind, day }).then(
      (event) => {
        void refreshed().finally(() => shift(kind, -1))
        if (!mounted.current || seq !== tapSeq.current) return
        setUndoable({ kind, eventId: event.id })
        undoTimer.current = setTimeout(() => { undoTimer.current = null; setUndoable(null) }, UNDO_MS)
      },
      (error: unknown) => { shift(kind, -1); setChipsError(failureText(error)) },
    )
  }

  function onUndo() {
    if (undoable === null) return
    const { kind, eventId } = undoable
    clearUndo()
    setChipsError(null)
    shift(kind, -1)
    undo.mutateAsync({ eventId }).then(
      () => refreshed().finally(() => shift(kind, 1)),
      (error: unknown) => { shift(kind, 1); setChipsError(failureText(error)) },
    )
  }

  const kindLabel = (kind: string) => SEED_KINDS.includes(kind) ? t(`annotate.event.kinds.${kind}`) : kind
  const chipName = (kind: string, count: number) => count === 0 ? kindLabel(kind)
    : isToday ? t('logPanel.chips.countToday', { kind: kindLabel(kind), count })
      : t('logPanel.chips.countDay', { kind: kindLabel(kind), count })
  const dayName = isYesterday ? t('glance.subtitle.yesterday') : formatLongDate(day, i18n.language)

  // Note: `saved` is what the server holds as far as this panel knows, so a blur after an Enter
  // that already saved the same text sends nothing a second time.
  const [text, setText] = useState(log.note ?? '')
  const [saved, setSaved] = useState(log.note ?? '')
  const [noteError, setNoteError] = useState<string | null>(null)
  // The same two, readable from the unmount below. `savedRef` moves the moment a save starts, so a
  // blur that already saved and then a close send one PUT, not two.
  const textRef = useRef(text)
  textRef.current = text
  const savedRef = useRef(saved)

  function commitNote() {
    if (unchanged(text, saved)) return
    const previous = saved
    savedRef.current = text
    setSaved(text)
    setNoteError(null)
    saveNote.mutateAsync({ day, body: text }).catch(
      (error: unknown) => { savedRef.current = previous; setSaved(previous); setNoteError(failureText(error)) },
    )
  }

  // Closing by Escape, by a press outside the popover or by the phone's back gesture unmounts the
  // panel without a blur, and so does ‹ › re-keying this body onto another day; a half-typed note
  // is saved here instead, to the day it was typed on. `mutate` rather than mutateAsync: nothing
  // is left on screen to show a failure in.
  const saveNoteRef = useRef(saveNote.mutate)
  saveNoteRef.current = saveNote.mutate
  useEffect(() => () => {
    if (unchanged(textRef.current, savedRef.current)) return
    savedRef.current = textRef.current
    saveNoteRef.current({ day, body: textRef.current })
  }, [day])

  function onNoteKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    commitNote()
  }

  return (
    <>
      <section className="log-sec">
        <span className="label" id={moodLabelId}>{t('logPanel.mood.label')}</span>
        <MoodFaces value={mood} onChange={changeMood} labelledBy={moodLabelId} />
        {moodError !== null && <p className="log-error" role="alert">{moodError}</p>}
      </section>
      <section className="log-sec">
        <div className="log-sec-head">
          <span className="label">{t('logPanel.chips.label')}</span>
          {!editing && (
            <button type="button" ref={editButton} className="log-link" onClick={() => setEditing(true)}>
              {t('logPanel.chips.edit')}
            </button>
          )}
        </div>
        {editing
          // Done closes only once the day log holds the saved list, so the chips come back in their
          // new order rather than showing the old one for the length of a refetch.
          ? <PresetEditor kinds={log.presets} suggestions={suggestions}
              onDone={() => { void refreshed().finally(leaveEditing) }} onCancel={leaveEditing} />
          : <div className="log-chips">
            {log.presets.map((kind) => {
              const count = countOf(kind)
              return (
                <button key={kind} type="button" className={count > 0 ? CHIP_CLASS.on : CHIP_CLASS.off}
                  aria-label={chipName(kind, count)} onClick={() => onTap(kind)}>
                  {kindLabel(kind)}
                  {count > 0 && <span className="log-count" aria-hidden="true">{count}</span>}
                </button>
              )
            })}
          </div>}
        <div className="log-undo-slot" aria-live="polite">
          {undoable !== null && (
            <div className="log-undo">
              <span>{isToday
                ? t('logPanel.undo.today', { kind: kindLabel(undoable.kind) })
                : t('logPanel.undo.day', { kind: kindLabel(undoable.kind), day: dayName })}</span>
              <button type="button" className="log-link" onClick={onUndo}>{t('logPanel.undo.action')}</button>
            </div>
          )}
        </div>
        {chipsError !== null && <p className="log-error" role="alert">{chipsError}</p>}
      </section>
      <section className="log-sec">
        <label className="label" htmlFor={noteId}>{t('logPanel.note.label')}</label>
        <textarea id={noteId} className="input log-note" rows={2} value={text} placeholder={t('logPanel.note.placeholder')}
          onChange={(event) => setText(event.target.value)} onBlur={commitNote} onKeyDown={onNoteKeyDown} />
        {noteError !== null && <p className="log-error" role="alert">{noteError}</p>}
      </section>
    </>
  )
}
