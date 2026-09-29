import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { Card } from '../../../components/Card.js'
import { formatNumber } from '../../../format.js'
import type { WorkoutFigureKey, WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'
import { pausesOf } from './workoutText.js'

// The rest of the figures, in the mockup's order. Edwards' cardio load is among the four under the
// hero; Banister's is this card's "Load (TRIMP)".
const MORE: readonly WorkoutFigureKey[] = [
  'calories', 'steps', 'highestHeartRate', 'activeZoneMinutes', 'elevationGain', 'banister', 'elapsed', 'vo2max', 'swimLengths',
]

/**
 * More about this workout (the mockup's "Meer over deze training"): calories, steps, the highest
 * heart rate, active zone minutes, elevation gain, the Banister load, the elapsed time, VO2max and
 * a swim's lengths, each only when the workout has a reading.
 *
 * Three rows say something other than their usual. Elapsed time reads against the moving time and
 * the pauses between them ("28:04 moving · one pause"), with no bar: the pauses are the same ones
 * the trace shades (pausesOf), counted with any mid-session pause it can only mark. VO2max draws
 * its line over this and the nine runs before it, since its trend is the point of it. A swim's
 * lengths name the pool they were swum in, which is what a length measures.
 */
export function WorkoutMore({ page, detail, endMs }: {
  page: WorkoutPageData
  detail: WorkoutDetail
  endMs: number
}): ReactNode {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { figures } = page
  const pauses = useMemo(() => pausesOf(detail.events, endMs), [detail.events, endMs])

  const present = MORE.filter((key) => (figures[key]?.value ?? null) !== null)
  if (present.length === 0) return null

  const moving = figures.movingTime
  const pauseCount = pauses.spans.length + pauses.marks.length
  const elapsedParts = [
    ...(moving === undefined || moving.value === null ? [] : [t('activity.workout.page.more.moving', { value: formatFigureValue(moving, moving.value, language, t) })]),
    ...(pauseCount === 0 ? [] : [t('activity.workout.page.more.pauses', { count: pauseCount })]),
  ]
  const swim = figures.swimLengths
  const poolVerdict = swim === undefined || detail.poolLengthMeters === null ? undefined : [
    t('activity.workout.page.more.pool', { meters: formatNumber(detail.poolLengthMeters, 0, language, '') }),
    verdictLine(swim, language, t) ?? t('glance.usual.none'),
  ].join(' · ')

  return (
    <Card span={12} label={t('activity.workout.page.more.label')}>
      <div className="workout-more-rows">
        {present.map((key) => {
          const elapsed = key === 'elapsed' && elapsedParts.length > 0
          const verdict = elapsed ? elapsedParts.join(' · ') : key === 'swimLengths' ? poolVerdict : undefined
          return (
            <WorkoutFigureRow key={key} figure={figures[key]} label={t(`activity.workout.page.figures.${key}`)}
              verdict={verdict} bare={elapsed} withStrip={key === 'vo2max'} />
          )
        })}
      </div>
    </Card>
  )
}
