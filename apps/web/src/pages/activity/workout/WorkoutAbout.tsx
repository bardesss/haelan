import { Fragment, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../../components/Card.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { syncButtonState, syncRefusal, useRunSync, useStatusSnapshot } from '../../../data/useStatusPanel.js'
import type { WorkoutSessionDetail } from '../../../data/useSessions.js'
import { gpsSentenceKey } from './workoutText.js'

/**
 * The workout page's last card, folded shut by default (the mockup's "Over deze training"), the
 * night page's NightAbout for a workout: which sources recorded it and whether copies were merged,
 * whether it is excluded, what can be said about its route, and the control to exclude it or add a
 * note. The header used to carry the first three; a reader who never excludes a workout never needs
 * them, and one who does finds them beside the button that acts on them.
 *
 * Above the fold, one line saying what is behind it: who recorded it, merged with which other
 * sources, the provider's name for it when that says something the type (the page's title) does
 * not ("Morning run"), "excluded" when it is (a fact worth seeing without opening anything), and what can be
 * done there. `<details>` rather than a state toggle, as NightAbout: the fold needs no data of its
 * own to open.
 *
 * A workout the watch has not summarised yet (the server's `pending`: a phone-only workout with no
 * Google copy) says so in the line, "your watch's figures arrive with the next sync", beside a
 * button that starts one (PendingSync). A state line, as PATTERNS.md puts every state, not a hero line.
 *
 * The button only asks the page to open the annotate panel (`onAnnotate`): the panel is an overlay
 * over the whole page, so it is rendered there rather than inside a card inside a fold. It keeps its
 * `.workout-actions` row, which scripts/layout-check.mjs clicks by name once it has opened the fold.
 */
export function WorkoutAbout({ session, detail, exerciseType, pending = false, onAnnotate }: {
  session: WorkoutSessionDetail
  detail: WorkoutDetail
  /** The page's own type, whose label is the page's title. */
  exerciseType: string | null
  /** Whether the watch's figures are still to come (the page's `pending`). */
  pending?: boolean
  onAnnotate: () => void
}): ReactNode {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  // The other sources, filtered on the primary's id rather than sliced off the front, so a
  // response that lists the primary anywhere still reads right (the old header's own rule).
  const others = (session.sources ?? []).filter((id) => id !== session.sourceId)
  const othersList = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(others.map(nameOf))
  // Possibly undefined on an older cached response (WorkoutRoute.tsx's own comment on its prop).
  const gpsKey = gpsSentenceKey(detail, (session.route ?? []).length)
  const source = nameOf(session.sourceId)
  // The name the provider gave the session, only when it is not the type again (it is, on nearly
  // every workout), which the page's title already says. The provider names it in English whatever
  // the reader's language ("Running" under "Hardlopen"), so the type's own id counts as the type too.
  const type = exerciseTypeLabel(t, exerciseType)
  const bare = (text: string) => text.toLocaleLowerCase(i18n.language).replace(/[\s_]/g, '')
  const given = detail.displayName?.trim() ?? ''
  const name = given !== '' && bare(given) !== bare(type) && bare(given) !== bare(exerciseType ?? '') ? given : null
  const parts: ReactNode[] = [
    others.length > 0
      ? t('activity.workout.page.about.merged', { source, others: othersList })
      : t('activity.workout.page.about.recordedBy', { source }),
    ...(pending ? [<PendingSync key="pending" />] : []),
    ...(name === null ? [] : [t('activity.workout.page.about.named', { name })]),
    ...(session.excluded ? [t('activity.workout.page.about.excluded')] : []),
    t('activity.workout.page.about.action'),
  ]

  return (
    <Card span={12} label={t('activity.workout.page.about.label')}>
      <p className="detail-about-line">
        {parts.map((part, i) => <Fragment key={i}>{i > 0 && ' · '}{part}</Fragment>)}
      </p>
      <details className="detail-about">
        <summary>{t('activity.workout.page.about.details')}</summary>
        <div className="workout-about-body">
          {others.length > 0 && (
            <p className="workout-also basis">{t('activity.workout.alsoRecordedBy', { sources: othersList })}</p>
          )}
          {session.excluded && (
            <p className="workout-excluded">
              {session.excludeReason !== null
                ? t('activity.sessions.excluded', { reason: session.excludeReason })
                : t('activity.sessions.excludedNoReason')}
            </p>
          )}
          {gpsKey !== null && <p className="workout-gps basis">{t(gpsKey)}</p>}
          <div className="workout-actions">
            <button type="button" className="button" onClick={onAnnotate}>{t('common.annotate')}</button>
          </div>
        </div>
      </details>
    </Card>
  )
}

/**
 * "Your watch's figures arrive with the next sync", and a button that starts one now: the status
 * panel's own sync (useRunSync), by the panel's own rules (syncButtonState, syncRefusal). The
 * button says "Syncing…" while a run goes and "Synced just now" through the server's minute of
 * cooldown after one, both disabled; a run already going (409) or any other refusal gets the
 * panel's line beside it. The status is the shell's (useStatusSnapshot), read with no poll of its
 * own. A refusal belongs to the moment it was said: a run starting or finishing forgets it, so a
 * "A sync is already running." never outlives that run.
 *
 * Nothing here waits for the run: a finished run refreshes this person's data, this page with it
 * (useRunSync for a run over before the status is re-read, the shell's useRefreshOnSyncFinish for
 * one it watches end), and a page the watch has summarised by then drops this clause.
 */
function PendingSync(): ReactNode {
  const { t } = useTranslation()
  const status = useStatusSnapshot()
  const runSync = useRunSync()
  const sync = status.data?.sync ?? null
  const { label, disabled } = syncButtonState(sync, runSync.isPending)
  const refusal = syncRefusal(runSync)
  const outcome = refusal === null ? '' : t(`status.sync.${refusal}`)
  // Forget the press's result when a run starts or one finishes. Keyed on what the status says,
  // so the first read is a baseline and never a change.
  const resetRun = runSync.reset
  const running = sync?.running === true
  const finishedAt = sync?.lastFinishedAtMs ?? null
  const seen = useRef<{ running: boolean, finishedAt: number | null } | null>(null)
  useEffect(() => {
    const was = seen.current
    seen.current = { running, finishedAt }
    if (was !== null && ((running && !was.running) || finishedAt !== was.finishedAt)) resetRun()
  }, [running, finishedAt, resetRun])
  return (
    <>
      {t('activity.workout.page.about.pending')}{' '}
      <button type="button" className="button workout-sync-now" disabled={disabled} onClick={() => runSync.mutate()}>
        {t(`status.sync.${label}`)}
      </button>
      {outcome !== '' && ' '}
      <span className="workout-sync-outcome" role="status">{outcome}</span>
    </>
  )
}
