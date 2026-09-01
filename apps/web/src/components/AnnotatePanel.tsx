import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { dayMetricTarget } from '@haelan/core/target-key'
import { useTranslation } from '../i18n/index.js'
import { useWriteEvent, useWriteNote, useWriteOverride } from '../data/useAnnotations.js'
import { SEED_KINDS } from '../data/eventKinds.js'

/**
 * What a clicked point hands the panel: a day and a metric, nothing else. The target key is
 * built from these two fields by dayMetricTarget, the same encoder the store and the route use,
 * so this component never types a key of its own. A reader never sees or edits a target key at
 * all; the click is the only place one is ever named.
 */
export interface AnnotateTarget {
  localDate: string
  metric: string
}

type Action = 'exclude' | 'note' | 'event'

// Three, not four: there is no correct action here, and its absence is deliberate rather than an
// oversight to restore. A click on a by-day chart can only ever name a day_metric target
// (`targetKey` below is built with dayMetricTarget and nothing else), and OverrideStore.validate
// refuses `correct` at every scope but `sample`, so a corrected day_metric write answered 400 on
// every attempt. Relaxing that rule would not help either: deriveDay consults only excludedMetrics,
// so a day scoped correction has nothing in the derive path to apply it, and it would save and then
// silently change no number at all. Correcting a value stays reachable at sample scope, which needs
// an intraday chart to click a single reading on; this panel has no way to name one.
const ACTIONS: readonly Action[] = ['exclude', 'note', 'event']

/**
 * The panel a reader opens by clicking a plotted point: exclude the day's reading, add a note or
 * add an event, all three scoped to the one day and metric the click named.
 *
 * `applied` decides what happens after an override write, and only after one: a note or an
 * event carries no drain (useAnnotations.ts's own comment on invalidateResource says why) and
 * always closes the panel once its write lands. An override's `applied: true` means the numbers
 * behind the panel have already changed, so it closes the same way. `applied: false` means the
 * exclusion saved but the re-derive has not caught up yet, the one state where closing would
 * let a reader walk away believing a number that has not moved. The panel stays open and says so
 * instead of closing on a write that only half finished.
 */
export function AnnotatePanel({ target, onClose }: {
  target: AnnotateTarget
  onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const titleId = useId()

  const [action, setAction] = useState<Action>('exclude')
  const [reason, setReason] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [kind, setKind] = useState('')
  const [startedAt, setStartedAt] = useState(() => `${target.localDate}T12:00`)
  const [endedAt, setEndedAt] = useState('')
  const [eventValue, setEventValue] = useState('')
  const [eventNote, setEventNote] = useState('')

  const writeOverride = useWriteOverride()
  const writeNote = useWriteNote()
  const writeEvent = useWriteEvent()

  // Built here, from exactly the two fields the click carried, and nowhere else in this
  // component. No reason for a target key to appear as a field a reader could edit: the point
  // they clicked already said which day and which metric this panel is about.
  const targetKey = dayMetricTarget({ localDate: target.localDate, metric: target.metric })

  const canSubmit =
    action === 'exclude' ? reason.trim() !== '' :
    action === 'note' ? noteBody.trim() !== '' :
    kind.trim() !== '' && startedAt !== ''

  const mutation = action === 'note' ? writeNote : action === 'event' ? writeEvent : writeOverride
  const busy = mutation.isPending

  // Sticks around after a successful exclude until a later write replaces it, which is what lets
  // the note below survive a reader switching tabs to look at the other actions without losing
  // the one message this whole distinction exists to show.
  const overrideResult = writeOverride.data ?? null
  const notYetApplied = overrideResult !== null && overrideResult.applied === false

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSubmit) return

    if (action === 'exclude') {
      writeOverride.mutate({ scope: 'day_metric', targetKey, action: 'exclude', reason }, {
        onSuccess: (result) => { if (result.applied) onClose() },
      })
    } else if (action === 'note') {
      writeNote.mutate({ localDate: target.localDate, body: noteBody }, { onSuccess: onClose })
    } else {
      const started = new Date(startedAt)
      const ended = endedAt === '' ? null : new Date(endedAt)
      writeEvent.mutate({
        kind: kind.trim(),
        startedAtMs: started.getTime(),
        // Minutes east of UTC, the same convention localDateOf reads (packages/core's
        // derive/localDay.ts): getTimezoneOffset reports the opposite sign, minutes to add to
        // local time to reach UTC, so it is negated here rather than passed straight through.
        startedAtOffsetMinutes: -started.getTimezoneOffset(),
        endedAtMs: ended === null ? undefined : ended.getTime(),
        endedAtOffsetMinutes: ended === null ? undefined : -ended.getTimezoneOffset(),
        value: eventValue.trim() === '' ? undefined : Number(eventValue),
        note: eventNote.trim() === '' ? undefined : eventNote,
      }, { onSuccess: onClose })
    }
  }

  return (
    <div className="annotate-overlay" role="presentation" onClick={onClose}>
      <div
        className="annotate-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="annotate-header">
          <h2 id={titleId}>{t('annotate.title', { metric: target.metric, date: target.localDate })}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('annotate.close')}>
            {'×'}
          </button>
        </div>

        <div className="segmented" role="group" aria-label={t('annotate.actionLabel')}>
          {ACTIONS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="segment"
              aria-pressed={candidate === action}
              onClick={() => setAction(candidate)}
            >
              {t(`annotate.actions.${candidate}`)}
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          {action === 'exclude' && (
            <label className="field">
              <span className="label">{t('annotate.reasonLabel')}</span>
              <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
              {/* Unconditional, not gated on a flag: this field only ever renders on the exclude
                  action, and the schema makes reason notNull for it, so there is no branch here
                  in which the hint would not apply. */}
              <span className="field-hint">{t('annotate.reasonHint')}</span>
            </label>
          )}

          {action === 'note' && (
            <label className="field">
              <span className="label">{t('annotate.noteLabel')}</span>
              <input className="input" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} />
            </label>
          )}

          {action === 'event' && (
            <>
              <label className="field">
                <span className="label">{t('annotate.kindLabel')}</span>
                <input className="input" value={kind} list={`${titleId}-kinds`}
                  onChange={(event) => setKind(event.target.value)} />
                <datalist id={`${titleId}-kinds`}>
                  {SEED_KINDS.map((seed) => (
                    <option key={seed} value={seed} label={t(`annotate.event.kinds.${seed}`)} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span className="label">{t('annotate.startedAtLabel')}</span>
                <input className="input" type="datetime-local" value={startedAt}
                  onChange={(event) => setStartedAt(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('annotate.endedAtLabel')}</span>
                <input className="input" type="datetime-local" value={endedAt}
                  onChange={(event) => setEndedAt(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('annotate.eventValueLabel')}</span>
                <input className="input" type="number" inputMode="decimal" value={eventValue}
                  onChange={(event) => setEventValue(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('annotate.eventNoteLabel')}</span>
                <input className="input" value={eventNote} onChange={(event) => setEventNote(event.target.value)} />
              </label>
            </>
          )}

          {mutation.isError && <p className="form-error" role="alert">{t('annotate.saveFailed')}</p>}

          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!canSubmit || busy}>
              {busy ? t('annotate.saving') : t(`annotate.actions.${action}`)}
            </button>
          </div>
        </form>

        {notYetApplied && <p className="annotate-note">{t('annotate.notYetApplied')}</p>}
      </div>
    </div>
  )
}
