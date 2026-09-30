import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Link } from '../../../router.js'
import type { EffortKey, WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { EFFORT_DISTANCES } from '@haelan/core/fastest-efforts'
import { formatStopwatch } from '../../detail/figureText.js'
import { formatNumber } from '../../../format.js'
import { bestMonth } from './workoutText.js'

// The mockup's rows, shortest first.
const EFFORTS: readonly EffortKey[] = ['km', 'mile', 'fiveK']
// The quiet good-day mark (PATTERNS.md): after the value in the table, before the words under it.
const MARK = '✦'
// Where a stretch lay, as the mockup words it: kilometres at one decimal at both ends, even one that
// starts under a kilometre ("0.2 – 5.2 km"), so the two ends always read in one unit.
const ALONG_DECIMALS = 1

/**
 * "Fastest efforts" (the mockup's "Snelste stukken"), beside the same route under the route card:
 * the fastest kilometre, mile and 5 km inside the run, read off its GPS route by the server, each
 * with where along the run it lay and beside the Records best of its kind with the month it was
 * set. A best that is this run's own reads "this workout", its time is marked ✦, and a line under
 * the table says it is the fastest ever and, with a best before it, by how much it beat that one.
 * On a phone the where column goes, as the mockup has it, so the table fits its card without
 * scrolling sideways.
 *
 * A distance the route is shorter than is left out, and the card with none left, as it is for
 * any workout the server reads no efforts off (anything but a run, or one without a route).
 */
export function WorkoutEfforts({ page, span }: { page: WorkoutPageData, span: 6 | 12 }): ReactNode {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const rows = EFFORTS.flatMap((key) => {
    const effort = page.efforts?.[key] ?? null
    return effort === null ? [] : [{ key, effort, distance: t(`activity.workout.page.efforts.${key}`) }]
  })
  if (rows.length === 0) return null
  const bestOf = ({ best, isBest }: typeof rows[number]['effort']) => {
    if (isBest) return t('activity.workout.page.efforts.thisWorkout')
    if (best === null) return t('common.absent')
    return t('activity.workout.page.compared.bestValue', {
      value: formatStopwatch(best.value), month: bestMonth(best.localDate, page.localDate, language),
    })
  }
  const whereOf = (key: EffortKey, fromMeters: number) => {
    const km = (meters: number) => formatNumber(meters / 1000, ALONG_DECIMALS, language, t('common.absent'))
    return `${km(fromMeters)} – ${km(fromMeters + EFFORT_DISTANCES[key])}\u00a0${t('activity.units.km')}`
  }
  // "12 s faster than in August": seconds under a minute, a stopwatch past one; the plain line when
  // there was no best before this one, or the two print the same.
  const bestLine = ({ distance, effort }: typeof rows[number]) => {
    const before = effort.previousBest
    const delta = before === null ? 0 : Math.round(before.value) - Math.round(effort.seconds)
    if (before === null || delta <= 0) return t('activity.workout.page.efforts.fastest', { distance })
    return t('activity.workout.page.efforts.fastestBy', {
      distance, month: bestMonth(before.localDate, page.localDate, language),
      delta: delta < 60 ? t('activity.workout.page.efforts.seconds', { value: delta }) : formatStopwatch(delta),
    })
  }
  return (
    <Card span={span} label={t('activity.workout.page.efforts.label')}>
      <div className="table-scroll">
        <table className="override-table workout-efforts">
          <caption className="sr-only">{t('activity.workout.page.efforts.tableCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('activity.workout.page.efforts.distance')}</th>
              <th scope="col">{t('activity.workout.page.efforts.time')}</th>
              <th scope="col" className="workout-efforts-where">{t('activity.workout.page.efforts.where')}</th>
              <th scope="col">{t('activity.workout.page.efforts.best')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, effort, distance }) => (
              <tr key={key}>
                <th scope="row">{distance}</th>
                <td className="workout-compared-this">
                  {formatStopwatch(effort.seconds)}
                  {/* The line under the table says what the mark means; a screen reader hears it there. */}
                  {effort.isBest && <> <span aria-hidden="true">{MARK}</span></>}
                </td>
                <td className="workout-efforts-where">{whereOf(key, effort.fromMeters)}</td>
                <td>{bestOf(effort)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.filter(({ effort }) => effort.isBest).map((row) => (
        <p key={row.key} className="workout-hero-line">{`${MARK} ${bestLine(row)}`}</p>
      ))}
      <p className="dash-caption workout-compared-footnote">{t('activity.workout.page.efforts.caption')}</p>
      <Link to="/records" className="card-link">{t('activity.workout.page.efforts.view')}</Link>
    </Card>
  )
}
