import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { dayMetricTarget } from '@haelan/core/target-key'
import { useTranslation } from '../i18n/index.js'
import { useWriteEvent, useWriteNote, useWriteOverride } from '../data/useAnnotations.js'

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

type Action = 'exclude' | 'correct' | 'note' | 'event'

const ACTIONS: readonly Action[] = ['exclude', 'correct', 'note', 'event']

// Spec section 6's seed set (packages/core/src/db/schema/annotations.ts's own comment on
// events.kind). A closed list here would contradict the column, which is deliberately not an
// enum: the datalist below offers these six and accepts anything the reader types past them.
const SEED_KINDS: readonly string[] = ['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine']

/**
 * The panel a reader opens by clicking a plotted point: exclude, correct, add a note or add an
 * event, all four scoped to the one day and metric the click named.
 *
 * `applied` decides what happens after an override write, and only after one: a note or an
 * event carries no drain (useAnnotations.ts's own comment on invalidateResource says why) and
 * always closes the panel once its write lands. An override's `applied: true` means the numbers
 * behind the panel have already changed, so it closes the same way. `applied: false` means the
 * correction saved but the re-derive has not caught up yet, the one state where closing would
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
  const [correctedValue, setCorrectedValue] = useState('')
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

  // No isNaN check on correctedNumber: the field it comes from is type="number", and the HTML
  // value sanitisation algorithm for that type (enforced by every real browser, and by happy-dom
  // in the test below) rejects a keystroke that would leave the value non-numeric before it ever
  // reaches this state. A non-empty correctedValue is therefore always a parseable number here;
  // an isNaN guard on it was dead code checking a state this field cannot produce.
  const correctedNumber = correctedValue.trim() === '' ? null : Number(correctedValue)
  const canSubmit =
    action === 'exclude' ? reason.trim() !== '' :
    action === 'correct' ? reason.trim() !== '' && correctedNumber !== null :
    action === 'note' ? noteBody.trim() !== '' :
    kind.trim() !== '' && startedAt !== ''

  const mutation = action === 'note' ? writeNote : action === 'event' ? writeEvent : writeOverride
  const busy = mutation.isPending

  // Sticks around after a successful exclude or correct until a later write replaces it, which
  // is what lets the note below survive a reader switching tabs to look at the other actions
  // without losing the one message this whole distinction exists to show.
  const overrideResult = writeOverride.data ?? null
  const notYetApplied = overrideResult !== null && overrideResult.applied === false

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSubmit) return

    if (action === 'exclude') {
      writeOverride.mutate({ scope: 'day_metric', targetKey, action: 'exclude', reason }, {
        onSuccess: (result) => { if (result.applied) onClose() },
      })
    } else if (action === 'correct') {
      writeOverride.mutate(
        { scope: 'day_metric', targetKey, action: 'correct', correctedValue: correctedNumber!, reason },
        { onSuccess: (result) => { if (result.applied) onClose() } },
      )
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
          {(action === 'exclude' || action === 'correct') && (
            <>
              {action === 'correct' && (
                <label className="field">
                  <span className="label">{t('annotate.correctedValueLabel')}</span>
                  <input className="input" type="number" inputMode="decimal" value={correctedValue}
                    onChange={(event) => setCorrectedValue(event.target.value)} />
                </label>
              )}
              <label className="field">
                <span className="label">{t('annotate.reasonLabel')}</span>
                <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
                {/* Unconditional, not gated on a flag: this field only ever renders inside the
                    exclude-or-correct block above, and the schema makes reason notNull for both,
                    so there is no branch here in which the hint would not apply. */}
                <span className="field-hint">{t('annotate.reasonHint')}</span>
              </label>
            </>
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
