import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { dayMetricTarget, sampleTarget, sessionTarget } from '@haelan/core/target-key'
import { useTranslation } from '../i18n/index.js'
import { useWriteEvent, useWriteNote, useWriteOverride } from '../data/useAnnotations.js'
import { SEED_KINDS } from '../data/eventKinds.js'

/**
 * What a clicked point (or, for `session`, a whole workout) hands the panel, tagged by where it
 * came from. A by-day chart names a day and a metric, nothing else, and the target key for that
 * shape is built by dayMetricTarget. An intraday chart names one plotted (source, minute) bucket
 * instead, carrying the `n` stored rows behind it (readIntraday's own reason `n` exists at all),
 * and its target key is built by sampleTarget. The workout page names a session directly - there
 * is no point to click, the target is the page itself - and its key is built by sessionTarget.
 * All three keep `localDate`: the note action below writes against a day whatever the target
 * named, so it needs one regardless of which builder wins.
 *
 * Either way the target key is built from these fields alone, by dayMetricTarget, sampleTarget or
 * sessionTarget, the same encoders the store and the route read back with, so this component
 * never types a key of its own. A reader never sees or edits a target key at all; the click (or,
 * for a workout, opening the panel at all) is the only place one is ever named.
 */
export type AnnotateTarget =
  | { scope: 'day_metric', localDate: string, metric: string }
  | { scope: 'sample', localDate: string, metric: string, sourceId: string, utcMs: number, n: number }
  // The workout page's own target. It carries localDate because the note action writes against a
  // day whatever the target named, exactly as the other two variants do, and sessionId because
  // that is what an exclusion at this scope actually names: a recorded session, not a derived day.
  //
  // alsoSessionIds are the other copies of the same workout, the ones the server merged into
  // sessionId (packages/core/src/query/mergedWorkouts.ts). An exclusion writes one override per
  // copy: the server calls a merged workout excluded only once every copy is, because that is when
  // workout_count stops counting it - derivation drops an excluded session before it groups, so
  // excluding the primary alone would hand the event to the phone's copy and the workout would
  // stay on the list under a different id.
  | { scope: 'session', localDate: string, sessionId: string, alsoSessionIds?: readonly string[] }

type Action = 'exclude' | 'correct' | 'note' | 'event'

/**
 * Four actions, three, two, or three with a reason. `correct` is valid only at sample scope
 * (OverrideStore.validate), and a sample override names one exact instant, so it is offered only
 * when the clicked point stands for exactly one stored row. Heart rate is stored downsampled to
 * the minute, so on the chart this ships from, n is always 1; the guard is what keeps a future
 * chart over raw readings from writing a correction against an instant that stands for six.
 *
 * `session` offers only exclude and note: correct is sample scope only, which OverrideStore.validate
 * already enforces, and an event belongs to a day rather than to one workout, so offering one here
 * would write it against the day the workout happens to fall on, which is a different claim from
 * the one the reader made.
 */
function actionsFor(target: AnnotateTarget): readonly Action[] {
  if (target.scope === 'day_metric') return ['exclude', 'note', 'event']
  if (target.scope === 'session') return ['exclude', 'note']
  return target.n === 1 ? ['exclude', 'correct', 'note', 'event'] : ['exclude', 'note', 'event']
}

/**
 * The panel a reader opens by clicking a plotted point: exclude the reading, correct it (sample
 * scope only, see actionsFor), add a note or add an event, every action scoped to whatever the
 * click named.
 *
 * `applied` decides what happens after an override write, and only after one: a note or an
 * event carries no drain (useAnnotations.ts's own comment on invalidateResource says why) and
 * always closes the panel once its write lands. An override's `applied: true` means the numbers
 * behind the panel have already changed, so it closes the same way. `applied: false` means the
 * write saved but the re-derive has not caught up yet, the one state where closing would let a
 * reader walk away believing a number that has not moved. The panel stays open and says so
 * instead of closing on a write that only half finished.
 */
export function AnnotatePanel({ target, onClose }: {
  target: AnnotateTarget
  onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const titleId = useId()

  const actions = actionsFor(target)

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

  // Built here, from exactly the fields the click (or, for a workout, the page) carried, and
  // nowhere else in this component. No reason for a target key to appear as a field a reader could
  // edit: the point they clicked already said which day and metric, or which source and instant,
  // or the page they opened already said which session, this panel is about.
  const targetKey = target.scope === 'day_metric'
    ? dayMetricTarget({ localDate: target.localDate, metric: target.metric })
    : target.scope === 'session'
      ? sessionTarget(target.sessionId)
      : sampleTarget({ source: target.sourceId, metric: target.metric, utcMs: target.utcMs })

  const canSubmit =
    action === 'exclude' ? reason.trim() !== '' :
    action === 'correct' ? reason.trim() !== '' && correctedValue.trim() !== '' :
    action === 'note' ? noteBody.trim() !== '' :
    kind.trim() !== '' && startedAt !== ''

  const mutation = action === 'note' ? writeNote : action === 'event' ? writeEvent : writeOverride
  const busy = mutation.isPending

  // Sticks around after a successful exclude or correct until a later write replaces it, which is
  // what lets the note below survive a reader switching tabs to look at the other actions without
  // losing the one message this whole distinction exists to show.
  const overrideResult = writeOverride.data ?? null
  const notYetApplied = overrideResult !== null && overrideResult.applied === false

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSubmit) return

    if (action === 'exclude') {
      // One key everywhere but a merged workout, which excludes each of its copies in turn (the
      // comment on AnnotateTarget's session variant says why). In turn rather than at once: each
      // write drains the derive queue before it answers, and the panel closes only once every one
      // of them says it applied, so a reader is never told the count moved while one copy still
      // holds it up.
      const keys = [
        targetKey,
        ...(target.scope === 'session' ? (target.alsoSessionIds ?? []).map((id) => sessionTarget(id)) : []),
      ]
      const writeFrom = (at: number, appliedSoFar: boolean): void => {
        writeOverride.mutate({ scope: target.scope, targetKey: keys[at]!, action: 'exclude', reason }, {
          onSuccess: (result) => {
            const applied = appliedSoFar && result.applied
            if (at + 1 < keys.length) writeFrom(at + 1, applied)
            else if (applied) onClose()
          },
        })
      }
      writeFrom(0, true)
    } else if (action === 'correct') {
      // Reachable only when actionsFor offered this segment, which only happens at sample scope
      // (target.n === 1), so target.scope is always 'sample' here; OverrideStore.validate would
      // 400 a correct write at any other scope regardless.
      writeOverride.mutate(
        { scope: target.scope, targetKey, action: 'correct', correctedValue: Number(correctedValue), reason },
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
          {/* A session target carries no metric to name - the workout page opens this panel for
              the session as a whole, not for one chart's reading - so annotate.title's own
              "{{metric}} on {{date}}" has nothing to fill its first slot with. sessionTitle is the
              separate copy that shape needs rather than a blank or a made-up metric name. */}
          <h2 id={titleId}>
            {target.scope === 'session'
              ? t('annotate.sessionTitle', { date: target.localDate })
              : t('annotate.title', { metric: target.metric, date: target.localDate })}
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('annotate.close')}>
            {'×'}
          </button>
        </div>

        <div className="segmented" role="group" aria-label={t('annotate.actionLabel')}>
          {actions.map((candidate) => (
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

        {/* Only reachable at sample scope: actionsFor never withholds correct at day_metric scope
            because it never offers correct there at all, so there is nothing to explain the
            absence of. */}
        {target.scope === 'sample' && target.n !== 1 && (
          <p className="annotate-note annotate-note-withheld">
            {t('annotate.correctWithheld', { count: target.n })}
          </p>
        )}

        <form onSubmit={submit}>
          {(action === 'exclude' || action === 'correct') && (
            <label className="field">
              <span className="label">{t('annotate.reasonLabel')}</span>
              <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
              {/* Unconditional, not gated on a flag: this field only ever renders on the exclude
                  and correct actions, and the schema makes reason notNull for both, so there is no
                  branch here in which the hint would not apply. */}
              <span className="field-hint">{t('annotate.reasonHint')}</span>
            </label>
          )}

          {action === 'correct' && (
            <label className="field">
              <span className="label">{t('annotate.correctedValueLabel')}</span>
              <input className="input" type="number" inputMode="decimal" value={correctedValue}
                onChange={(event) => setCorrectedValue(event.target.value)} />
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
