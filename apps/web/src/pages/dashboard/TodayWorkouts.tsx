import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
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
 * Renders nothing at all on a day with none, the rule every card that hides itself follows since
 * CardGrid learned to count them: no Card means no registration, so the empty-page fallback still
 * fires on a truly empty glance, and a morning before the run is not a card saying "nothing yet"
 * under three columns that already say what the day holds.
 *
 * Span 12, a run of one on its own row under the three span-4 columns. Every consecutive run of
 * cards carries one span so a hidden card leaves no hole, and this card hides more often than any
 * other on the page.
 */
export function TodayWorkouts({ workouts }: { workouts: readonly WorkoutSession[] }): ReactNode {
  const { t } = useTranslation()
  if (workouts.length === 0) return null
  return (
    <Card span={12} label={t('glance.workouts.title')}>
      <div className="today-workouts list-measured">
        {workouts.map((session) => <SessionRow key={session.id} session={session} />)}
      </div>
    </Card>
  )
}
