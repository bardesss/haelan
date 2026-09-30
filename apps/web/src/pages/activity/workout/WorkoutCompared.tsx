import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Link } from '../../../router.js'
import { formatShortDate } from '../../../format.js'
import type { WorkoutFigure, WorkoutPageData, RecordRef } from '../../../data/useWorkoutPage.js'
import { formatFigureDifference, formatFigureRange, formatFigureValue } from '../../detail/figureText.js'
import { exerciseCategory, rateOf } from '@haelan/core/exercise-category'
import { bestMonth, filledNote, workoutPath } from './workoutText.js'

// The table's rows, in the mockup's order: the four measures the previous workout's values cover.
// The first is the rate the category reads (rateOf, through the shared core map): a ride's speed,
// a swim's pace per 100 m, pace per km for the rest (previousOf sends each for exactly this row),
// so an indoor ride led by its moving time still sets its speed beside the last one and a swim
// never shows a pace per km. A time hero (a strength session's moving time) leads with that time,
// the figure the page is about, ahead of the four.
const ROWS = ['distance', 'averageHeartRate', 'cardioLoad'] as const
type Row = typeof ROWS[number] | 'pace' | 'speed' | 'swimPace' | 'movingTime' | 'elapsed'
const rowsFor = (hero: string, exerciseType: string | null): readonly Row[] => {
  const rate = rateOf(exerciseCategory(exerciseType)) ?? 'pace'
  const time: Row[] = hero === 'movingTime' || hero === 'elapsed' ? [hero] : []
  return [...time, rate, ...ROWS]
}

// The Records best each row can name, with the words that say what it measures where the row's own
// figure is a different one: a pace row is the workout's average, and its best the fastest
// kilometre; an elapsed row's best the longest session. The furthest is a distance like the row.
// Records keeps no best heart rate or load, which would not be a best if it did.
function bestOf(page: WorkoutPageData, key: Row): { ref: RecordRef, value: number, words: string } | null {
  const fastestKm = page.best['fastest-1k'] ?? null
  const { furthest, longest } = page.best
  if (key === 'pace' && fastestKm !== null) return { ref: fastestKm, value: fastestKm.value, words: 'bestFastestKm' }
  if (key === 'distance' && furthest !== null) return { ref: furthest, value: furthest.value, words: 'bestValue' }
  if (key === 'elapsed' && longest !== null) return { ref: longest, value: longest.value / 1000, words: 'bestLongest' }
  return null
}

/**
 * "Compared with": this workout beside the previous one of its type, the usual range for the type
 * and the Records best, for pace, distance, average heart rate and cardio load (after the hero's own
 * time, for a time hero). A row the workout has no reading for is left out; the previous column
 * goes when there is no previous one, the usual column when no row has a real usual, the best
 * column when no row has a best. On a phone the best and the usual columns both go (the hero and
 * the rows above already say the usual), so the table fits its card rather than scrolling sideways
 * out of sight. With nothing to set beside this workout's own values - a first session of a type,
 * say - the card goes too.
 *
 * The table's caption and the footnote under it name only the columns that are there, and their
 * words about the usual and the best sit in `.workout-compared-wide`, which goes on a phone with
 * the columns themselves. Each difference is taken between the values as printed
 * (formatFigureDifference), so a row adds up.
 */
export function WorkoutCompared({ page }: { page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const absent = t('common.absent')
  const rows = rowsFor(page.hero, page.exerciseType).flatMap((key) => {
    const figure = page.figures[key]
    return figure === undefined || figure.value === null ? [] : [{ key, figure, value: figure.value }]
  })
  const { previous } = page
  const usualOf = (figure: WorkoutFigure) => {
    const { baseline } = figure
    if (baseline === null || baseline.thin) return null
    // The unit once, after the second number (formatFigureRange), as every other usual on the page.
    const { low, high } = formatFigureRange(figure, baseline.low, baseline.high, language, t)
    return formatFigureValue(figure, baseline.low, language, t) === high ? high : `${low} – ${high}`
  }
  const withUsual = rows.some(({ figure }) => usualOf(figure) !== null)
  const withBest = rows.some(({ key }) => bestOf(page, key) !== null)
  if (rows.length === 0 || (previous === null && !withUsual && !withBest)) return null
  const extra = withUsual && withBest ? 'usualBest' : withUsual ? 'usual' : withBest ? 'best' : null
  // The figures of this workout the phone's samples filled, said once in the footnote rather than in
  // each cell (PATTERNS.md, Cards: what a column means is its caption's and footnote's to say). A
  // filled rate runs over the elapsed time, and the clause says so only when the table shows one.
  const filledRows = rows.filter(({ key }) => filledNote(page, key, t) !== undefined).map(({ key }) => key)
  const filledRate = filledRows.find((key) => key === 'pace' || key === 'speed')
  const filledClause = filledRows.length === 0 ? null
    : t(`activity.workout.page.compared.${filledRate === 'pace' ? 'filledPace' : filledRate === 'speed' ? 'filledSpeed' : 'filled'}`)
  const captionKey = previous === null ? 'captionAlone' : 'captionWith'

  return (
    <Card span={12} label={t('activity.workout.page.compared.label')}>
      <div className="table-scroll">
        <table className="override-table workout-compared">
          <caption className="sr-only">
            {t(`activity.workout.page.compared.${previous === null ? 'tableCaptionAlone' : 'tableCaption'}`)}
            {extra !== null && <span className="workout-compared-wide">{t(`activity.workout.page.compared.${captionKey}.${extra}`)}</span>}
          </caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">{t('activity.workout.page.compared.measure')}</span></th>
              <th scope="col">{t('activity.workout.page.compared.this')}</th>
              {previous !== null && (
                <th scope="col">
                  <Link to={workoutPath(previous.sessionId)} className="card-link">
                    {t('activity.workout.page.compared.previous', { date: formatShortDate(previous.localDate, page.localDate, language) })}
                  </Link>
                </th>
              )}
              {withUsual && <th scope="col" className="workout-compared-usual">{t('activity.workout.page.compared.usual')}</th>}
              {withBest && <th scope="col" className="workout-compared-best">{t('activity.workout.page.compared.best')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, figure, value }) => {
              const before = previous?.values[key]
              const best = bestOf(page, key)
              // A rate over the elapsed time beside one over moving time differs in kind: the previous
              // value alone, with no difference that would compare unlike with unlike.
              const unlike = key === filledRate
              return (
                <tr key={key}>
                  <th scope="row">{t(`activity.workout.page.figures.${key}`)}</th>
                  <td className="workout-compared-this">
                    {formatFigureValue(figure, value, language, t)}
                  </td>
                  {previous !== null && (
                    <td>
                      {before === undefined ? absent : unlike ? formatFigureValue(figure, before, language, t) : (
                        <>
                          {/* A real space, so a screen reader says "5:36 /km -12 s", not one run-on word. One
                              run faster or slower than the last says nothing about a trend, so the
                              difference is never coloured better or worse. */}
                          {formatFigureValue(figure, before, language, t)}{' '}
                          <span className="workout-diff">{formatFigureDifference(figure, value, before, language, t)}</span>
                        </>
                      )}
                    </td>
                  )}
                  {withUsual && <td className="workout-compared-usual">{usualOf(figure) ?? absent}</td>}
                  {withBest && (
                    <td className="workout-compared-best">
                      {best === null ? absent : t(`activity.workout.page.compared.${best.words}`, {
                        value: formatFigureValue(figure, best.value, language, t),
                        month: bestMonth(best.ref.localDate, page.localDate, language),
                      })}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="dash-caption workout-compared-footnote">
        {t('activity.workout.page.compared.caption')}
        {withBest && <span className="workout-compared-wide"> · {t('activity.workout.page.compared.captionBest')}</span>}
        {filledClause !== null && ` · ${filledClause}`}
      </p>
    </Card>
  )
}
