import { useEffect, useRef } from 'react'
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { formatNumber } from '../../format.js'
import { useRouteBasemapStatus } from '../../data/useRouteBasemap.js'
import type { RoutePoint } from '../../data/useSessions.js'

// `import type` only, above: erased entirely at compile time, so naming MapLibre's own type here
// costs the off-by-default household nothing. The one place the library's *value* is named is the
// dynamic import() inside the effect below, reached only when the setting this task adds is on -
// see that effect's own comment for why a static import anywhere in this file would undo it.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * The style handed to MapLibre when the basemap setting is on: one raster source, OpenStreetMap's
 * own tile server, and one layer that draws it. A pure function and exported, not built inline in
 * the effect, so a test can assert what a household that switches this on is actually pointed at
 * without mounting a WebGL canvas to find out - this suite has no browser layout coverage able to
 * do that (WorkoutRoute.tsx's own module comment, further down, names the same gap for the trace).
 */
export function basemapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  }
}

/** The bounding box MapLibre fits the map to on load: every recorded point's own extremes, in the
 *  [[west, south], [east, north]] shape its own `bounds` option takes. */
export function routeBounds(points: readonly RoutePoint[]): [[number, number], [number, number]] {
  const lons = points.map((point) => point.longitude)
  const lats = points.map((point) => point.latitude)
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]]
}

/** The one shape addSource's geojson data option needs, spelled out locally rather than pulled
 *  from @types/geojson: that package sits nested under maplibre-gl's own dependency tree, not
 *  hoisted anywhere this file's typeRoots would find it, and a LineString feature is small enough
 *  to write once rather than fight the module graph for. */
interface RouteLineFeature {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'LineString', coordinates: [number, number][] }
}

/** The route as one GeoJSON LineString feature, the shape a `geojson` source takes. Longitude
 *  first, the same axis order projectRoute's own xs/ys keep, because GeoJSON's is [lon, lat]. */
export function routeGeoJSON(points: readonly RoutePoint[]): RouteLineFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: points.map((point) => [point.longitude, point.latitude]) },
  }
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
 * why MapLibre is reached exclusively through the dynamic import() inside the effect below rather
 * than a static import at the top of this module - a static one would ship the library to every
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
  const basemapEnabled = basemap.data?.enabled === true

  // Every hook above the empty-route early return below, never the other way round: React calls
  // hooks in the order a component declares them, on every render, and an early return ahead of
  // one would call it on some renders and not others.
  useEffect(() => {
    if (!basemapEnabled || recorded.length === 0) return
    let cancelled = false
    let map: MapLibreMap | undefined
    // The one place this file names MapLibre as a value rather than a type, and it is reached only
    // once basemapEnabled is true - see the module comment above for why a static import anywhere
    // else in this file would defeat the setting this effect exists to respect.
    void import('maplibre-gl').then(({ Map }) => {
      if (cancelled || mapContainerRef.current === null) return
      const instance = new Map({
        container: mapContainerRef.current,
        style: basemapStyle(),
        bounds: routeBounds(recorded),
        fitBoundsOptions: { padding: 24 },
      })
      map = instance
      // Added once the style's own tiles have somewhere to draw onto, not before - addSource on a
      // map that has not fired 'load' throws.
      instance.on('load', () => {
        if (cancelled) return
        instance.addSource('workout-route', { type: 'geojson', data: routeGeoJSON(recorded) })
        instance.addLayer({
          id: 'workout-route-line', type: 'line', source: 'workout-route',
          paint: { 'line-color': '#2f6fed', 'line-width': 3 },
        })
      })
    })
    // cancelled guards the promise continuation above against a component that unmounted, or a
    // setting that flipped off, before the import resolved; map?.remove() tears down the one that
    // did finish constructing, on the same cleanup path.
    return () => { cancelled = true; map?.remove() }
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
