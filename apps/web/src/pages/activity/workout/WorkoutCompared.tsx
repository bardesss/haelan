import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Link } from '../../../router.js'
import { formatShortDate } from '../../../format.js'
import type { WorkoutFigure, WorkoutPageData, RecordRef } from '../../../data/useWorkoutPage.js'
import { formatFigureDifference, formatFigureValue } from '../../detail/figureText.js'
import { bestMonth, workoutPath } from './workoutText.js'

// The table's rows, in the mockup's order: the four measures the previous workout's values cover.
const ROWS = ['pace', 'distance', 'averageHeartRate', 'cardioLoad'] as const
type Row = typeof ROWS[number]

// The Records best each row can name: the fastest kilometre as a pace, the furthest as a distance.
// Records keeps no best heart rate or load, which would not be a best if it did.
function bestOf(page: WorkoutPageData, key: Row): RecordRef | null {
  if (key === 'pace') return page.best.fastestKmSeconds
  if (key === 'distance') return page.best.furthestMeters
  return null
}

/**
 * The previous workout's reading beside this one's: better or worse only where the figure has a
 * direction the server sent (pace: less is better), from the sign of the difference and nothing
 * else. More distance, heart rate or load is neither, so those differences stay the plain colour.
 */
function diffClass(figure: WorkoutFigure, difference: number): string {
  if (figure.direction === 'neutral' || Math.round(difference) === 0) return 'workout-diff'
  return (difference > 0) === (figure.direction === 'up') ? 'workout-diff better' : 'workout-diff worse'
}

/**
 * "Compared with": this workout beside the previous one of its type, the usual range for the type
 * and the Records best, for pace, distance, average heart rate and cardio load. A row the workout
 * has no reading for is left out; the previous column goes when there is no previous one, the
 * usual column when no row has a real usual, the best column when no row has a best (and on a
 * phone, where the mockup drops it). With nothing to set beside this workout's own values - a
 * first session of a type, say - the card goes too.
 */
export function WorkoutCompared({ page }: { page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const absent = t('common.absent')
  const rows = ROWS.flatMap((key) => {
    const figure = page.figures[key]
    return figure === undefined || figure.value === null ? [] : [{ key, figure, value: figure.value }]
  })
  const { previous } = page
  const usualOf = (figure: WorkoutFigure) => {
    const { baseline } = figure
    if (baseline === null || baseline.thin) return null
    const low = formatFigureValue(figure, baseline.low, language, t)
    const high = formatFigureValue(figure, baseline.high, language, t)
    return low === high ? low : `${low} – ${high}`
  }
  const withUsual = rows.some(({ figure }) => usualOf(figure) !== null)
  const withBest = rows.some(({ key }) => bestOf(page, key) !== null)
  if (rows.length === 0 || (previous === null && !withUsual && !withBest)) return null

  return (
    <Card span={12} label={t('activity.workout.page.compared.label')}>
      <div className="table-scroll">
        <table className="override-table workout-compared">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{t('activity.workout.page.compared.this')}</th>
              {previous !== null && (
                <th scope="col">
                  <Link to={workoutPath(previous.sessionId)}>
                    {t('activity.workout.page.compared.previous', { date: formatShortDate(previous.localDate, page.localDate, language) })}
                  </Link>
                </th>
              )}
              {withUsual && <th scope="col">{t('activity.workout.page.compared.usual')}</th>}
              {withBest && <th scope="col" className="workout-compared-best">{t('activity.workout.page.compared.best')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, figure, value }) => {
              const before = previous?.values[key]
              const best = bestOf(page, key)
              return (
                <tr key={key}>
                  <th scope="row">{t(`activity.workout.page.figures.${key}`)}</th>
                  <td className="workout-compared-this">{formatFigureValue(figure, value, language, t)}</td>
                  {previous !== null && (
                    <td>
                      {before === undefined ? absent : (
                        <>
                          {formatFigureValue(figure, before, language, t)}
                          <span className={diffClass(figure, value - before)}>{formatFigureDifference(figure, value - before, language, t)}</span>
                        </>
                      )}
                    </td>
                  )}
                  {withUsual && <td>{usualOf(figure) ?? absent}</td>}
                  {withBest && (
                    <td className="workout-compared-best">
                      {best === null ? absent : t('activity.workout.page.compared.bestValue', {
                        value: formatFigureValue(figure, best.value, language, t),
                        month: bestMonth(best.localDate, page.localDate, language),
                      })}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="dash-caption">{t('activity.workout.page.compared.caption')}</p>
    </Card>
  )
}
