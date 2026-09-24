import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import type { WorkoutSession } from '../../data/useSessions.js'
import { SessionRow } from '../activity/SessionRow.js'

/**
 * Today's workouts, one row each, every row opening the workout's own page.
 *
 * The rows are the Activity list's own SessionRow, fed the objects the glance already carries
 * (`day.workouts`, merged across sources on the server by mergedWorkouts.ts), so a run reads the
 * same here as there and the page still makes its one read. Oldest first, the order the day
 * happened in, which is the order the server sends; the Activity list sorts newest first because
 * it spans weeks, and a single day has no such reason.
 *
 * Inside the today column rather than a card of its own: a workout is part of what the day has
 * held so far, beside its steps and active minutes, and a full-width card under the three columns
 * read as a separate subject. It was one, span 12 on its own row, for its first release.
 *
 * Renders nothing at all on a day with none, so the column reads exactly as it did before there
 * was anything to list: a morning before the run is not a heading saying "nothing yet" under
 * figures that already say what the day holds.
 */
export function TodayWorkouts({ workouts }: { workouts: readonly WorkoutSession[] }): ReactNode {
  const { t } = useTranslation()
  if (workouts.length === 0) return null
  return (
    <div className="today-workouts">
      <span className="label">{t('glance.workouts.title')}</span>
      {workouts.map((session) => <SessionRow key={session.id} session={session} />)}
    </div>
  )
}
