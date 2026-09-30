import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { FilledSplit } from '@haelan/core/split-heart-rate'
import { exerciseCategory, rateOf } from '@haelan/core/exercise-category'
import { Card } from '../../../components/Card.js'
import { formatNumber } from '../../../format.js'
import type { WorkoutSessionDetail } from '../../../data/useSessions.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { RouteDrawing } from '../WorkoutRoute.js'
import { formatPace } from '../pace.js'
import { formatFigureValue } from '../../detail/figureText.js'
import { elevationProfile } from './workoutText.js'

// The elevation profile's own box, in view units; the SVG stretches it to the card's width.
const PROFILE_WIDTH = 400
const PROFILE_HEIGHT = 40
// A split shorter than this is the run's leftover end, labelled by its distance ("0.2") rather
// than as one more whole kilometre.
const WHOLE_KM_METRES = 950
// The pace bar's shortest length, as a share of the longest, so the slowest kilometre still draws.
const BAR_FLOOR = 0.4

// A ride's split speed, the figure unit its speed is judged in, printed in km/h (formatFigureValue).
const SPEED = { metric: 'speed', value: null, unit: 'meters_per_second', precision: 2 }

/**
 * Each split's bar length as a share of the row: the fastest kilometre fills it, the slowest gets
 * BAR_FLOOR, the rest in between by pace, or for a ride by speed, the number printed beside it.
 * Drawing only - it says which kilometre was quicker, which the number beside it already says - so
 * it compares these splits with each other, never with a usual. Null for a split with no pace.
 */
function barShares(rows: readonly FilledSplit[], speed: boolean): (number | null)[] {
  // Larger is quicker either way: a speed as it is, a pace turned round.
  const quickness = (r: FilledSplit) => (r.paceSecondsPerKm === null ? null : speed ? 1000 / r.paceSecondsPerKm : -r.paceSecondsPerKm)
  const values = rows.flatMap((r) => { const v = quickness(r); return v === null ? [] : [v] })
  const quickest = Math.max(...values)
  const slowest = Math.min(...values)
  return rows.map((r) => {
    const v = quickness(r)
    if (v === null) return null
    if (slowest === quickest) return 1
    return BAR_FLOOR + (1 - BAR_FLOOR) * (v - slowest) / (quickest - slowest)
  })
}

/**
 * The kilometre table: the provider's automatic splits, trimmed from WorkoutSplits' table to the
 * split, its pace (a ride's speed in km/h) with a bar, and its heart rate, with the same dagger and footnote for a heart
 * rate filled from the trace (splitHeartRate.ts). Laps are not shown here: none has ever been
 * recorded in this archive (WorkoutSplits.tsx's own measurement), and a lap is a different claim
 * from an automatic kilometre.
 */
function KilometreTable({ rows, speed }: { rows: readonly FilledSplit[], speed: boolean }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const shares = barShares(rows, speed)
  const rateOfRow = (pace: number) => (speed ? formatFigureValue(SPEED, 1000 / pace, language, t) : formatPace(pace, language))
  const anyFilled = rows.some((row) => row.averageHeartRateBpmSource === 'trace')
  return (
    <>
      <table className="workout-km">
        <thead>
          <tr>
            <th scope="col">{t('activity.workout.page.map.km')}</th>
            <th scope="col">{t(speed ? 'activity.workout.page.figures.speed' : 'activity.workout.splits.pace')}</th>
            <th scope="col"><span className="sr-only">{t(speed ? 'activity.workout.page.map.speedBar' : 'activity.workout.page.map.paceBar')}</span></th>
            <th scope="col">{t('activity.workout.splits.heartRate')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const partial = row.distanceMeters !== null && row.distanceMeters < WHOLE_KM_METRES
            const share = shares[index] ?? null
            return (
              <tr key={`${row.startMs ?? 'unknown'}-${index}`}>
                <th scope="row">{partial ? formatNumber(row.distanceMeters! / 1000, 1, language, '') : formatNumber(index + 1, 0, language, '')}</th>
                <td>{row.paceSecondsPerKm === null ? t('common.absent') : rateOfRow(row.paceSecondsPerKm)}</td>
                <td className="workout-km-bar-cell">
                  {share !== null && (
                    <span className="workout-km-bar" aria-hidden="true">
                      <span className="workout-km-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                    </span>
                  )}
                </td>
                <td>
                  {row.averageHeartRateBpm === null ? t('common.absent')
                    : `${formatNumber(row.averageHeartRateBpm, 0, language, '')}${row.averageHeartRateBpmSource === 'trace' ? '†' : ''}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {anyFilled && <p className="workout-splits-footnote">{t('activity.workout.splits.filledFromTrace')}</p>}
    </>
  )
}

/**
 * The split verdict under the table, in the server's number: "Negative split · second half 22
 * s/km faster" when the second half went quicker, positive when it went slower, even when the two
 * came out the same to the second. A ride's reads in km/h ("second half 1.2 km/h faster"), even
 * when the two are the same to the tenth it prints. The sign is the server's (workoutPage.ts's
 * splitTrendOf); this only words it.
 */
function SplitTrend({ trend }: { trend: NonNullable<WorkoutPageData['splitTrend']> }) {
  const { t, i18n } = useTranslation()
  const speed = 'secondHalfFasterByMetersPerSecond' in trend
  // Signed in the unit printed: whole seconds per km, or tenths of a km/h.
  const by = speed ? Math.round(trend.secondHalfFasterByMetersPerSecond * 36) / 10 : trend.secondHalfFasterBySecondsPerKm
  const value = formatNumber(Math.abs(by), speed ? 1 : 0, i18n.language, '')
  const suffix = speed ? 'Speed' : ''
  const [head, tail] = by > 0
    ? [t('activity.workout.page.map.negative'), t(`activity.workout.page.map.faster${suffix}`, { value })]
    : by < 0
      ? [t('activity.workout.page.map.positive'), t(`activity.workout.page.map.slower${suffix}`, { value })]
      : [t('activity.workout.page.map.even'), t(speed ? 'activity.workout.page.map.sameSpeed' : 'activity.workout.page.map.same')]
  return <p className="workout-split-trend"><strong>{head}</strong> · {tail}</p>
}

/**
 * The route and its kilometres (M10a-3): the route drawn (RouteDrawing, WorkoutRoute's own map or
 * trace, unchanged) with its height profile under it, beside the kilometre table and the split
 * verdict. Each half only when the workout has it - no route, no map; fewer than two splits, no
 * table, since one kilometre compares with nothing - and the whole card goes when neither is left.
 *
 * `route` and `autoSplits` are read defensively (`?? []`), for the reason WorkoutRoute.tsx and
 * WorkoutSplits.tsx give: an older cached answer can simply be missing either field.
 */
export function WorkoutMap({ session, page }: { session: WorkoutSessionDetail, page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const route = session.route ?? []
  const splits = session.autoSplits ?? []
  const hasRoute = route.length > 0
  const hasSplits = splits.length >= 2
  // The end of each whole kilometre, numbered on the route; the last part-kilometre gets none.
  // Memoised on the session's own array, since the drawing's basemap effect keys on it.
  const kmEndsMs = useMemo(
    () => (session.autoSplits ?? []).flatMap((split) =>
      (split.distanceMeters !== null && split.distanceMeters >= 999 && split.endMs !== null ? [split.endMs] : [])),
    [session.autoSplits],
  )
  if (!hasRoute && !hasSplits) return null

  const profile = hasRoute ? elevationProfile(route, PROFILE_WIDTH, PROFILE_HEIGHT) : null
  const gain = page.figures.elevationGain
  const basis = hasRoute
    ? t('activity.workout.route.basis', { count: formatNumber(route.length, 0, i18n.language, '') })
    : undefined

  return (
    // The basis under the map it describes, as a caption: as the card's basis it printed above the
    // ROUTE label, the one card on the page whose first line was not its label.
    <Card span={12}>
      <div className="workout-map" data-both={hasRoute && hasSplits}>
        {hasRoute && (
          <div className="workout-map-route">
            <span className="label">{t('activity.workout.route.label')}</span>
            <RouteDrawing route={route} kmEndsMs={kmEndsMs} />
            {basis !== undefined && <p className="dash-caption">{basis}</p>}
            {profile !== null && (
              <div className="workout-elevation">
                <div className="workout-elevation-head">
                  <span className="label">{t('activity.workout.page.map.elevation')}</span>
                  {gain !== undefined && gain.value !== null && (
                    <span className="workout-elevation-gain">+{formatFigureValue(gain, gain.value, i18n.language, t)}</span>
                  )}
                </div>
                <svg className="workout-elevation-svg" viewBox={`0 0 ${PROFILE_WIDTH} ${PROFILE_HEIGHT}`}
                  preserveAspectRatio="none" role="img" aria-label={t('activity.workout.page.map.elevationDescription')}>
                  <polyline className="workout-elevation-line" points={profile} />
                </svg>
              </div>
            )}
          </div>
        )}
        {hasSplits && (
          <div className="workout-map-km">
            <span className="label">{t('activity.workout.page.map.kilometres')}</span>
            <KilometreTable rows={splits} speed={rateOf(exerciseCategory(page.exerciseType)) === 'speed'} />
            {page.splitTrend !== null && <SplitTrend trend={page.splitTrend} />}
          </div>
        )}
      </div>
    </Card>
  )
}
