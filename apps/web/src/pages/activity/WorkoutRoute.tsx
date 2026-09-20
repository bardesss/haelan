import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { StatTile } from '../../components/StatTile.js'
import { formatNumber } from '../../format.js'
import type { RoutePoint } from '../../data/useSessions.js'

const EARTH_RADIUS_METERS = 6_371_000
/** The longer side of the drawn box, in view units. The shorter side is whatever the route's own
 *  aspect ratio makes it - see projectRoute below. */
const VIEW_DIMENSION = 320
const PADDING = 16
const POINT_RADIUS = 3

/**
 * The great circle distance between every consecutive pair, summed. Independent of whatever
 * distance the provider reported in WorkoutTiles - firmware GPS distance and this can disagree by
 * a few percent - this one is read straight off the same points the map below draws, not a second
 * copy of the provider's own figure.
 */
export function routeDistanceMeters(points: readonly RoutePoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const lat1 = a.latitude * Math.PI / 180
    const lat2 = b.latitude * Math.PI / 180
    const dLat = (b.latitude - a.latitude) * Math.PI / 180
    const dLon = (b.longitude - a.longitude) * Math.PI / 180
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
    total += 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))
  }
  return total
}

/**
 * Metres climbed, summed over positive altitude steps only - the ordinary meaning of elevation
 * gain, not the net change between the first and last point. Null when the device recorded no
 * altitude at all, the same `!== null` presence rule this page follows everywhere else (see
 * WorkoutTiles.tsx's own Tile comment): a route that recorded altitude and climbed nothing keeps
 * its zero, and a route that recorded none at all shows no figure rather than a false one.
 */
export function routeElevationGainMeters(points: readonly RoutePoint[]): number | null {
  if (points.every((point) => point.altitudeMetres === null)) return null
  let gain = 0
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.altitudeMetres
    const curr = points[i]!.altitudeMetres
    // One endpoint recorded altitude and the other did not: contributes nothing, rather than
    // inventing a slope across a gap neither point can vouch for.
    if (prev === null || curr === null) continue
    const delta = curr - prev
    if (delta > 0) gain += delta
  }
  return gain
}

interface Projected { x: number, y: number }

/**
 * Projects every point into a small viewBox: longitude scaled by cos(latitude) so a degree of
 * longitude and a degree of latitude cover the same ground distance at this route's own latitude,
 * exact enough at the scale of a single run for no reader to see the difference. One scale factor
 * for both axes, never one each, is what keeps the shape unstretched - a route drawn on a wide
 * card has to come out the same shape as one drawn on a narrow one, only smaller.
 */
export function projectRoute(
  points: readonly RoutePoint[],
): { points: Projected[], viewWidth: number, viewHeight: number } {
  const meanLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length
  const cosLatitude = Math.cos(meanLatitude * Math.PI / 180)
  const xs = points.map((point) => point.longitude * cosLatitude)
  // Negated: latitude increases north, and an SVG's y axis increases downward, so without this a
  // route run north to south would draw as if it ran the other way.
  const ys = points.map((point) => -point.latitude)

  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const longestSpan = Math.max(spanX, spanY)
  // A single point, or several at the same spot, has no span to scale against - drawn into a
  // small fixed box instead of dividing by zero.
  const scale = longestSpan > 0 ? (VIEW_DIMENSION - 2 * PADDING) / longestSpan : 1
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)

  return {
    points: xs.map((x, i) => ({
      x: (x - minX) * scale + PADDING,
      y: (ys[i]! - minY) * scale + PADDING,
    })),
    viewWidth: spanX * scale + 2 * PADDING,
    viewHeight: spanY * scale + 2 * PADDING,
  }
}

/**
 * The route card: the trace drawn from the points, with distance and elevation beside it. No
 * basemap and no library - Task 6 adds MapLibre behind a setting, by dynamic import, so a
 * household that never turns a basemap on never downloads it; a static import here would ship it
 * to everyone regardless of the setting, which is the whole arrangement this card exists to
 * protect. This card fetches nothing of its own and imports nothing beyond what the page already
 * loaded with the session.
 *
 * `route` is typed as possibly undefined, not trusted as the always-present array
 * WorkoutSessionDetail declares it: WorkoutSplits.tsx's own comment on `autoSplits`/`laps` gives
 * the reason, and it applies unchanged here - an older cached response or any shape that predates
 * this deploy can simply be missing the field, this app has no error boundary around this section,
 * and an unguarded `.length` on `undefined` would blank the whole page rather than only leave this
 * one card off it.
 *
 * Absent entirely, not an empty map, when the session carries no points - a Google session and a
 * companion session whose route the app could not read both read as "nothing to draw" here, the
 * same absence WorkoutZones and WorkoutTrace already give their own missing data.
 */
export function WorkoutRoute({ route }: { route: readonly RoutePoint[] | undefined }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const recorded = route ?? []
  if (recorded.length === 0) return null

  const n = (value: number, precision: number) => formatNumber(value, precision, language, '')
  const distanceKm = routeDistanceMeters(recorded) / 1000
  const elevationGain = routeElevationGainMeters(recorded)
  const { points, viewWidth, viewHeight } = projectRoute(recorded)
  const linePoints = points.map((point) => `${point.x},${point.y}`).join(' ')

  // The one sentence a screen reader gets for the drawing below: what the layout check (this
  // app's only browser-level layout coverage) cannot see at all, since it never opens this page's
  // tabs and would not be able to judge a drawn shape even if it did. This description, and the
  // card's own presence and absence, are what this task's test can actually assert; the shape of
  // the line itself, and how it looks on a real screen, are not covered anywhere in this suite.
  const description = elevationGain === null
    ? t('activity.workout.route.description', { distance: n(distanceKm, 1) })
    : t('activity.workout.route.descriptionWithElevation', {
      distance: n(distanceKm, 1), elevation: n(elevationGain, 0),
    })

  return (
    <Card span={12} label={t('activity.workout.route.label')}
      basis={t('activity.workout.route.basis', { count: n(recorded.length, 0) })}>
      <div className="workout-route">
        <div className="workout-route-map">
          <svg className="workout-route-svg" viewBox={`0 0 ${viewWidth} ${viewHeight}`}
            role="img" aria-label={description}>
            {points.length === 1
              ? <circle className="workout-route-point" cx={points[0]!.x} cy={points[0]!.y} r={POINT_RADIUS} />
              : <polyline className="workout-route-trace" points={linePoints} />}
          </svg>
        </div>
        <div className="workout-route-stats">
          <div className="workout-route-stat">
            <StatTile label={t('activity.workout.tiles.distance')} value={n(distanceKm, 1)}
              unit={t('activity.units.km')} />
          </div>
          {elevationGain !== null && (
            <div className="workout-route-stat">
              <StatTile label={t('activity.workout.tiles.elevation')} value={n(elevationGain, 0)}
                unit={t('activity.units.meters')} />
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
