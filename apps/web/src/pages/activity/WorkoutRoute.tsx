import { useEffect, useRef } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { formatNumber } from '../../format.js'
import { useRouteBasemapStatus } from '../../data/useRouteBasemap.js'
import type { RoutePoint } from '../../data/useSessions.js'
import { mountBasemap } from './basemap.js'

/**
 * Whether this render may draw a basemap, which is whether it may send coordinates to a tile
 * server.
 *
 * `isFetching` is half the answer and the half that is easy to miss. react-query hands back cached
 * data immediately and revalidates behind it, so a tab holding a cached `true` from before an
 * admin switched the setting off would answer yes on the first render and request tiles before the
 * refetch could say otherwise. Waiting for the fetch in flight costs a beat on a map that is off
 * by default anyway; not waiting costs a request that cannot be taken back.
 *
 * Undefined reads as false for the same reason: the query being in flight for the first time is
 * not a yes, and a card that guessed would start the very request this setting exists to gate.
 */
export function basemapAllowed(status: { data?: { enabled: boolean }, isFetching: boolean }): boolean {
  return status.data?.enabled === true && !status.isFetching
}

/** The longer side of the drawn box, in view units. The shorter side is whatever the route's own
 *  aspect ratio makes it - see projectRoute below. */
const VIEW_DIMENSION = 320
const PADDING = 16
const POINT_RADIUS = 3

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
 * The route card: the trace drawn from the points, and nothing numeric beside it. Fix round 1 on
 * this task removed a distance and an elevation gain computed straight off these points - a second
 * measurement of a fact WorkoutTiles.tsx already states from the provider, a few percent off it for
 * reasons no reader could see, on the same page. One fact, one figure: the provider's, already on
 * the page, consistent with every other tile. This card draws where, not how far or how high.
 *
 * A basemap under the trace, when the instance-wide setting below is on - off by default, because
 * a route's first and last point is usually this household's own address, and a tile request is
 * what tells a map provider where that is. See About.tsx's own sentence at the switch for what a
 * tile request sends; this file's job is only to never send one when the setting is off, which is
 * why MapLibre is reached exclusively through loadMapLibre's dynamic import(), which only the
 * effect below ever calls (by way of basemap.ts's mountBasemap), rather than a static import at
 * the top of this module - a static one would ship the library to every
 * household that opens a workout page, on or off, undoing the whole point of Task 5 drawing the
 * trace by hand so that a household which never turns this on never downloads it.
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
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  // Undefined while the query is in flight, which reads as false below - the same "say nothing
  // rather than guess" the off-by-default setting itself argues for: a card that assumed the
  // basemap was on before the answer came back could start the very network request this design
  // exists to gate.
  const basemap = useRouteBasemapStatus()
  const basemapEnabled = basemapAllowed(basemap)

  // Every hook above the empty-route early return below, never the other way round: React calls
  // hooks in the order a component declares them, on every render, and an early return ahead of
  // one would call it on some renders and not others.
  useEffect(() => {
    if (!basemapEnabled || recorded.length === 0 || mapContainerRef.current === null) return
    // The one path from this file to MapLibre, and it is reached only once basemapEnabled is true -
    // see the module comment above for why a static import anywhere else would defeat the setting
    // this effect exists to respect. mountBasemap owns the rest: the library through loadMapLibre,
    // the style in the page's own tokens, and restyling it when the theme changes.
    return mountBasemap(mapContainerRef.current, recorded)
  }, [basemapEnabled, recorded])

  if (recorded.length === 0) return null

  const n = (value: number, precision: number) => formatNumber(value, precision, language, '')
  const { points, viewWidth, viewHeight } = projectRoute(recorded)
  const linePoints = points.map((point) => `${point.x},${point.y}`).join(' ')

  // The one sentence a screen reader gets for the drawing below: what the layout check (this
  // app's only browser-level layout coverage) cannot see at all, since it never opens this page's
  // tabs and would not be able to judge a drawn shape even if it did. This description, and the
  // card's own presence and absence, are what this task's test can actually assert; the shape of
  // the line itself, and how it looks on a real screen, are not covered anywhere in this suite.
  const description = t('activity.workout.route.description')

  return (
    <Card span={12} label={t('activity.workout.route.label')}
      basis={t('activity.workout.route.basis', { count: n(recorded.length, 0) })}>
      {basemapEnabled ? (
        // The map itself is built imperatively by the effect above, onto this element once
        // MapLibre resolves - nothing here names a tile URL or a source, so the off branch below
        // renders no trace of either.
        <div className="workout-route-map" ref={mapContainerRef} role="img" aria-label={description} />
      ) : (
        <svg className="workout-route-svg" viewBox={`0 0 ${viewWidth} ${viewHeight}`}
          role="img" aria-label={description}>
          {points.length === 1
            ? <circle className="workout-route-point" cx={points[0]!.x} cy={points[0]!.y} r={POINT_RADIUS} />
            : <polyline className="workout-route-trace" points={linePoints} />}
        </svg>
      )}
    </Card>
  )
}
