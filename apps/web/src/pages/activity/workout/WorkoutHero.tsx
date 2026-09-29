import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Sparkline } from '../../../charts/Sparkline.js'
import { Link } from '../../../router.js'
import { formatSessionDateHeading } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { Described } from '../../dashboard/cardShared.js'
import type { WorkoutFigure, WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine, workoutStripOf } from '../../detail/figureText.js'
import { bestMonth, workoutPath } from './workoutText.js'

// The heroes whose ranking is the comparison's pace facet: faster is faster whether it is read as
// a pace or as a speed. Moving time has no facet of its own to rank by.
const RANKED_BY_PACE: ReadonlySet<string> = new Set(['pace', 'speed'])

/**
 * "12 s/km faster than the previous one" for a pace hero, the only hero the previous workout's
 * values cover (workoutPage.ts's previousOf sends pace, distance, heart rate and load). Faster and
 * slower are what a smaller and a larger pace mean, not a verdict: the same words a stopwatch
 * would use. Any other hero still names the previous one and links to it, without a difference.
 */
function previousLine(page: WorkoutPageData, hero: WorkoutFigure, language: string, t: Translate): string | null {
  const { previous } = page
  if (previous === null) return null
  const date = formatSessionDateHeading(previous.localDate, language)
  const before = hero.key === 'pace' ? previous.values.pace : undefined
  if (before === undefined || hero.value === null) return t('activity.workout.page.previousOnly', { date })
  const seconds = Math.round(hero.value - before)
  if (seconds === 0) return t('activity.workout.page.previousSame', { date })
  const difference = t('activity.workout.page.secondsPerKm', { value: Math.abs(seconds) })
  return t(seconds < 0 ? 'activity.workout.page.previousFaster' : 'activity.workout.page.previousSlower', { difference, date })
}

/**
 * The Records best for this type, labelled "your best" (the M10a-1 ruling: the best as of today,
 * so it may be a session done after this one): the fastest kilometre under a pace hero, the
 * longest session under a time hero. A speed hero names none, since Records keeps no fastest
 * speed; the comparison table's distance row still carries the furthest.
 */
function bestLine(page: WorkoutPageData, hero: WorkoutFigure, language: string, t: Translate): string | null {
  if (hero.key === 'pace' && page.best.fastestKmSeconds !== null) {
    const { value, localDate } = page.best.fastestKmSeconds
    return t('activity.workout.page.bestFastestKm', {
      value: formatFigureValue(hero, value, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  if ((hero.key === 'movingTime' || hero.key === 'elapsed') && page.best.longestMs !== null) {
    const { value, localDate } = page.best.longestMs
    return t('activity.workout.page.bestLongest', {
      value: formatFigureValue(hero, value / 1000, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  return null
}

/**
 * The workout's lead: the figure its type is judged by (the server's `hero`: pace on foot, speed
 * on a bike, moving time otherwise) in display type, where it sits against the usual for this
 * type, how it ranks among recent workouts of the type, the difference from the previous one with
 * a link to it, the Records best, and a strip of this workout and the nine of its type before it
 * with the usual shaded behind. Every verdict is the server's; this only words them.
 *
 * Nothing at all when the payload has no figure under the hero's key. The strip and its formatter
 * are memoised on the figure: a fresh array or function every render would rebuild the chart
 * (chart-lifecycle.test.tsx).
 */
export function WorkoutHero({ page }: { page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const hero = page.figures[page.hero]
  const strip = useMemo(() => (hero === undefined ? null : workoutStripOf(hero)), [hero])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null || hero === undefined ? absent : formatFigureValue(hero, value, language, t)),
    [hero, language, t],
  )
  if (hero === undefined || hero.value === null) return null
  const label = t(`activity.workout.page.figures.${hero.key}`)
  const verdict = verdictLine(hero, language, t)
  const { comparison } = page
  const rank = RANKED_BY_PACE.has(hero.key) && comparison.pace !== null
    ? t('activity.workout.comparison.pace', { better: comparison.pace.better, of: comparison.pace.of })
    : null
  const previous = previousLine(page, hero, language, t)
  const best = bestLine(page, hero, language, t)
  const caption = t('activity.workout.page.heroStrip')

  return (
    <Card span={12} label={label}>
      <div className="dash-lead workout-hero">
        <div>
          <div className="dash-headline workout-hero-value">{formatFigureValue(hero, hero.value, language, t)}</div>
          {verdict !== null && (
            <p className={hero.judged === null ? 'workout-hero-verdict' : `workout-hero-verdict ${hero.judged}`}>{verdict}</p>
          )}
          {rank !== null && <p className="workout-hero-line workout-hero-rank">{rank}</p>}
          {previous !== null && page.previous !== null && (
            <p className="workout-hero-line workout-hero-previous">
              {previous} · <Link to={workoutPath(page.previous.sessionId)}>{t('activity.workout.page.view')}</Link>
            </p>
          )}
          {best !== null && <p className="workout-hero-line workout-hero-best">{best}</p>}
        </div>
        {strip !== null && (
          <div className="dash-lead-strip">
            <Described text={verdict ?? caption} hidden>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric={hero.metric}
                formatValue={formatValue} bands={strip.bands} height={64} dots tableToggle={false} />
            </Described>
            <p className="dash-caption">{caption}</p>
          </div>
        )}
      </div>
    </Card>
  )
}
