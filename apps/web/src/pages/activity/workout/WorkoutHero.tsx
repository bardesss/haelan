import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { verdictTone } from '../../../components/FigureRow.js'
import { Sparkline } from '../../../charts/Sparkline.js'
import { Link } from '../../../router.js'
import { formatNumber, formatSessionDateHeading } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { useOpensDay } from '../../dashboard/cardShared.js'
import type { WorkoutFigure, WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine, workoutStripOf } from '../../detail/figureText.js'
import { bestMonth, workoutPath } from './workoutText.js'

/**
 * How far this workout's rate lies from the previous one's, as printed and without its sign, and
 * whether it was the quicker: a pace in whole seconds per km ("12 s/km"), a swim's per 100 m
 * ("4 s/100 m"), a ride's speed in km/h at one decimal ("0.8 km/h"). Null for a hero that is no
 * rate, or one the previous workout has no value for. Zero apart is `faster: null`.
 */
function rateDifference(
  hero: WorkoutFigure, before: number | undefined, language: string, t: Translate,
): { difference: string, faster: boolean | null } | null {
  if (before === undefined || hero.value === null) return null
  if (hero.key === 'speed') {
    // Tenths of a km/h, the two speeds as formatFigureValue prints them; a higher speed is faster.
    const tenths = Math.round(hero.value * 36) - Math.round(before * 36)
    const difference = `${formatNumber(Math.abs(tenths) / 10, 1, language, '')}\u00a0${t('activity.units.kmh')}`
    return { difference, faster: tenths === 0 ? null : tenths > 0 }
  }
  const key = hero.key === 'pace' ? 'secondsPerKm' : hero.key === 'swimPace' ? 'secondsPer100m' : null
  if (key === null) return null
  // Between the two paces as printed (whole seconds), as the comparison table takes its difference.
  const seconds = Math.round(hero.value) - Math.round(before)
  return { difference: t(`activity.workout.page.${key}`, { value: Math.abs(seconds) }), faster: seconds === 0 ? null : seconds < 0 }
}

/**
 * "12 s/km faster than the previous one" under a pace hero, "0.8 km/h faster" under a ride's
 * speed, "4 s/100 m faster" under a swim's pace (workoutPage.ts's previousOf sends each rate, as
 * the page's own figure reads it). Faster and slower are what a quicker and a slower rate mean, not
 * a verdict: the same words a stopwatch would use. Any other hero still names the previous one and
 * links to it, without a difference.
 */
function previousLine(page: WorkoutPageData, hero: WorkoutFigure, language: string, t: Translate): string | null {
  const { previous } = page
  if (previous === null) return null
  const date = formatSessionDateHeading(previous.localDate, language)
  const { key } = hero
  const apart = key === 'pace' || key === 'speed' || key === 'swimPace' ? rateDifference(hero, previous.values[key], language, t) : null
  if (apart === null) return t('activity.workout.page.previousOnly', { date })
  if (apart.faster === null) return t('activity.workout.page.previousSame', { date })
  return t(apart.faster ? 'activity.workout.page.previousFaster' : 'activity.workout.page.previousSlower', { difference: apart.difference, date })
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
  const fastestKm = page.best['fastest-1k'] ?? null
  if (hero.key === 'pace' && fastestKm !== null) {
    const { value, localDate } = fastestKm
    return t('activity.workout.page.bestFastestKm', {
      value: formatFigureValue(hero, value, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  if (hero.key === 'elapsed' && page.best.longest !== null) {
    const { value, localDate } = page.best.longest
    return t('activity.workout.page.bestLongest', {
      value: formatFigureValue(hero, value / 1000, language, t), month: bestMonth(localDate, page.localDate, language),
    })
  }
  return null
}

/**
 * The workout's lead, wired as the night page's hero is (NightHero): the figure its type is judged
 * by (the server's `hero`: pace on foot, speed on a bike outdoors, pace per 100 m in the water, moving time otherwise) in display type,
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
  // The server's rank on the rate the hero shows (workoutPage.ts's rankOf: a pace, a ride's speed
  // or a swim's pace per 100 m, each faster being better), so one sentence serves all three; none
  // for a time hero. "Faster than 20 of your last 20" is a sum the reader has to check; every one of
  // them is "all".
  const ranked = page.rank !== null && comparison.reason === null && band !== undefined ? page.rank : null
  const rank = ranked === null ? null
    : t(ranked.better === ranked.of ? 'activity.workout.comparison.paceAll' : 'activity.workout.comparison.pace', { better: ranked.better, of: ranked.of })
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
