import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { verdictTone } from '../../../components/FigureRow.js'
import { Sparkline } from '../../../charts/Sparkline.js'
import { Link } from '../../../router.js'
import { formatSessionDateHeading } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { useOpensDay } from '../../dashboard/cardShared.js'
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
  // Between the two paces as printed (whole seconds), as the comparison table takes its difference.
  const seconds = Math.round(hero.value) - Math.round(before)
  if (seconds === 0) return t('activity.workout.page.previousSame', { date })
  const difference = t('activity.workout.page.secondsPerKm', { value: Math.abs(seconds) })
  return t(seconds < 0 ? 'activity.workout.page.previousFaster' : 'activity.workout.page.previousSlower', { difference, date })
}

/**
 * The Records best for this type, labelled "your best" (the M10a-1 ruling: the best as of today,
 * so it may be a session done after this one), only where it measures what the hero measures: the
 * fastest kilometre under a pace hero, the longest session under an elapsed-time hero. Records'
 * longest is start to finish, so under a moving-time hero it set a session's elapsed time beside
 * its moving time as if one could beat the other; that hero names none. Neither does a speed hero,
 * since Records keeps no fastest speed; the comparison table's distance row still carries the furthest.
 */
function bestLine(page: WorkoutPageData, hero: WorkoutFigure, language: string, t: Translate): string | null {
  if (hero.key === 'pace' && page.best.fastestKmSeconds !== null) {
    const { value, localDate } = page.best.fastestKmSeconds
    return t('activity.workout.page.bestFastestKm', {
      value: formatFigureValue(hero, value, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  if (hero.key === 'elapsed' && page.best.longestMs !== null) {
    const { value, localDate } = page.best.longestMs
    return t('activity.workout.page.bestLongest', {
      value: formatFigureValue(hero, value / 1000, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  return null
}

/**
 * The workout's lead, wired as the night page's hero is (NightHero): the figure its type is judged
 * by (the server's `hero`: pace on foot, speed on a bike, moving time otherwise) in display type,
 * its verdict in `.detail-verdict` coloured by verdictTone, how it ranks among recent workouts of
 * the type, the difference from the previous one with a way to it, the Records best, and a strip of
 * this workout and up to nine of its type before it with the usual shaded behind and both its edges
 * labelled, each dot in its own verdict's tone and opening that workout's page. Every verdict is
 * the server's; this only words them.
 *
 * The rank is left out where it cannot mean anything: with a thin usual, or when the server says
 * why the comparison has nothing to stand on (`comparison.reason`), "faster than 0 of your last 3"
 * reads as a verdict the page is not making.
 *
 * Nothing at all when the payload has no figure under the hero's key. The strip, its labels and its
 * formatter are memoised on the figure: a fresh array or function every render would rebuild the
 * chart (chart-lifecycle.test.tsx).
 */
export function WorkoutHero({ page, onOpenWorkout }: {
  page: WorkoutPageData
  /** Opens a strip dot's workout on its own page (useOpenWorkout). */
  onOpenWorkout?: (sessionId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const captionId = useId()
  const hero = page.figures[page.hero]
  const strip = useMemo(() => (hero === undefined ? null : workoutStripOf(hero)), [hero])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null || hero === undefined ? absent : formatFigureValue(hero, value, language, t)),
    [hero, language, t],
  )
  const band = hero !== undefined && hero.baseline !== null && !hero.baseline.thin ? hero.baseline : undefined
  // The usual's two edges labelled beside the band, as the night's and the dashboard's strips
  // label them. Memoised for the reason NightHero gives: a fresh object would rebuild the chart.
  const bandLabels = useMemo(() => band === undefined || hero === undefined ? undefined : {
    low: formatFigureValue(hero, band.low, language, t), high: formatFigureValue(hero, band.high, language, t),
  }, [hero, band, language, t])
  // A dot names its session's date (the strip's labels) but opens its own session (the strip's
  // ids, Sparkline's pointIds): two sessions of a type can share a day, and by date only one of
  // them could be reached. The one already open is this session, not this day (useOpensDay's
  // `current`), so a same-day sibling still opens.
  const opens = useOpensDay(page.sessionId, onOpenWorkout, 'workout')
  if (hero === undefined || hero.value === null) return null
  const label = t(`activity.workout.page.figures.${hero.key}`)
  const verdict = verdictLine(hero, language, t)
  const tone = verdictTone(hero.judged, hero.standing)
  const { comparison } = page
  const rankable = RANKED_BY_PACE.has(hero.key) && comparison.reason === null && band !== undefined
  // "Faster than 20 of your last 20" is a sum the reader has to check; every one of them is "all".
  const rank = rankable && comparison.pace !== null
    ? t(comparison.pace.better === comparison.pace.of ? 'activity.workout.comparison.paceAll' : 'activity.workout.comparison.pace',
      { better: comparison.pace.better, of: comparison.pace.of })
    : null
  const previous = previousLine(page, hero, language, t)
  const best = bestLine(page, hero, language, t)
  // A pace strip is drawn upside down so a faster run sits higher; the caption says so, since a
  // reader of any other strip on the page takes higher to mean more. It counts the earlier
  // workouts the strip actually draws, never a fixed nine: a type done three times before draws four.
  const inverse = hero.direction === 'down'
  const earlier = strip === null ? 0 : strip.values.length - 1
  const caption = [
    t('activity.workout.page.heroStrip', { count: earlier }),
    ...(inverse ? [t('activity.workout.page.higherFaster')] : []),
  ].join(' · ')

  return (
    <Card span={12} label={label}>
      <div className="dash-lead detail-hero">
        <div>
          <div className="dash-headline detail-hero-value">{formatFigureValue(hero, hero.value, language, t)}</div>
          {verdict !== null && (
            <p id={verdictId} className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdict}</p>
          )}
          {rank !== null && <p className="workout-hero-line workout-hero-rank">{rank}</p>}
          {previous !== null && <p className="workout-hero-line workout-hero-previous">{previous}</p>}
          {best !== null && <p className="workout-hero-line workout-hero-best">{best}</p>}
          {previous !== null && page.previous !== null && (
            <Link to={workoutPath(page.previous.sessionId)} className="card-link">{t('activity.workout.page.view')}</Link>
          )}
        </div>
        {strip !== null && (
          <div className="dash-lead-strip">
            {/* Described by the verdict printed beside it (or, with none, its caption), by id, so a
                screen reader hears it once rather than again from a hidden copy. */}
            <BasisContext.Provider value={verdict !== null ? verdictId : captionId}>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric={hero.metric}
                formatValue={formatValue} baseline={band} bands={strip.bands} bandLabels={bandLabels}
                pointStandings={strip.pointStandings} pointJudged={strip.pointJudged}
                height={64} dots tableToggle={false} inverse={inverse} pointIds={strip.ids} {...opens} />
            </BasisContext.Provider>
            <p id={captionId} className="dash-caption">{caption}</p>
          </div>
        )}
      </div>
    </Card>
  )
}
