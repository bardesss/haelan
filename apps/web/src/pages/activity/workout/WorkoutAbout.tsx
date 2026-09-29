import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../../components/Card.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
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
 * The button only asks the page to open the annotate panel (`onAnnotate`): the panel is an overlay
 * over the whole page, so it is rendered there rather than inside a card inside a fold. It keeps its
 * `.workout-actions` row, which scripts/layout-check.mjs clicks by name once it has opened the fold.
 */
export function WorkoutAbout({ session, detail, exerciseType, onAnnotate }: {
  session: WorkoutSessionDetail
  detail: WorkoutDetail
  /** The page's own type, whose label is the page's title. */
  exerciseType: string | null
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
  const line = [
    others.length > 0
      ? t('activity.workout.page.about.merged', { source, others: othersList })
      : t('activity.workout.page.about.recordedBy', { source }),
    ...(name === null ? [] : [t('activity.workout.page.about.named', { name })]),
    ...(session.excluded ? [t('activity.workout.page.about.excluded')] : []),
    t('activity.workout.page.about.action'),
  ].join(' · ')

  return (
    <Card span={12} label={t('activity.workout.page.about.label')}>
      <p className="detail-about-line">{line}</p>
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
            <button type="button" className="button" onClick={onAnnotate}>{t('activity.workout.annotate')}</button>
          </div>
        </div>
      </details>
    </Card>
  )
}
