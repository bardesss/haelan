import { useEffect, useRef } from 'react'
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { formatNumber } from '../../format.js'
import { useRouteBasemapStatus } from '../../data/useRouteBasemap.js'
import type { RoutePoint } from '../../data/useSessions.js'
import { loadMapLibre } from './loadMapLibre.js'

// `import type` only, above: erased entirely at compile time, so naming MapLibre's own type here
// costs the off-by-default household nothing. The library's *value* is reached only through
// loadMapLibre's dynamic imports, called from the effect below once the setting this task adds is
// on - see that effect's own comment for why a static import anywhere in this file would undo it.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * OpenStreetMap's tiles darkened for a dark page, by MapLibre's own raster paint rather than a
 * second tile provider: a dark basemap from somebody else would be a new party learning where this
 * household runs, and About.tsx's sentence at the switch names OpenStreetMap and nobody else.
 *
 * brightness-min above brightness-max inverts the tile's lightness, the hue rotation puts water
 * back to blue after the inversion turned it orange, and the desaturation takes the result to a
 * near-neutral grey so the accent line is the most saturated thing on the card. Paint on the
 * raster layer only, which is the reason for doing it here rather than with a CSS filter on the
 * canvas: a filter would invert the route line along with the streets under it.
 */
export const DARK_RASTER_PAINT = {
  'raster-brightness-min': 0.85,
  'raster-brightness-max': 0,
  'raster-hue-rotate': 180,
  'raster-saturation': -0.7,
  'raster-contrast': -0.1,
} as const

/** The same five properties at MapLibre's own defaults, so a switch back to light resets them. */
export const LIGHT_RASTER_PAINT = {
  'raster-brightness-min': 0,
  'raster-brightness-max': 1,
  'raster-hue-rotate': 0,
  'raster-saturation': 0,
  'raster-contrast': 0,
} as const

/**
 * Whether the page is dark right now: an explicit `data-theme` on the root wins, and without one
 * the reader's system preference decides - the same two inputs, in the same order, useChart.ts
 * watches to recolour a chart.
 */
export function isDarkTheme(
  root: HTMLElement = document.documentElement,
  prefersDark: () => boolean = () => window.matchMedia('(prefers-color-scheme: dark)').matches,
): boolean {
  const pinned = root.getAttribute('data-theme')
  if (pinned === 'dark') return true
  if (pinned === 'light') return false
  return prefersDark()
}

/**
 * The style handed to MapLibre when the basemap setting is on: OpenStreetMap's own raster tiles,
 * and the route itself as a GeoJSON source with one line layer above them. A pure function and
 * exported, not built inline in the effect, so a test can assert what a household that switches
 * this on is actually pointed at without mounting a WebGL canvas to find out - this suite has no
 * browser layout coverage able to do that (WorkoutRoute.tsx's own module comment, further down,
 * names the same gap for the trace).
 *
 * The route is part of the style, not added afterwards. It used to be added in a 'load' handler,
 * and 'load' waits for every tile in view to finish: OpenStreetMap's tile server is slow enough
 * that the map sat there for many seconds as bare streets, and a tile that never answered kept the
 * route off it for good. In the style, it draws with the first frame the tiles do.
 *
 * `lineColor` empty drops the key rather than filling it - see routeLineColor.
 */
export function basemapStyle(
  route: readonly RoutePoint[],
  options: { lineColor: string, dark: boolean },
): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
      'workout-route': { type: 'geojson', data: routeGeoJSON(route) },
    },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm', paint: options.dark ? { ...DARK_RASTER_PAINT } : {} },
      {
        id: 'workout-route-line', type: 'line', source: 'workout-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: options.lineColor === ''
          ? { 'line-width': 3 }
          : { 'line-color': options.lineColor, 'line-width': 3 },
      },
    ],
  }
}

/**
 * The colour the route line is drawn in, read from the same `--accent` token the SVG trace below
 * reaches through CSS.
 *
 * MapLibre parses colours itself and never resolves `var(--accent)`, so the token has to be read
 * off the document and handed over already resolved. That indirection is worth more than pinning a
 * copy here: packages/tokens emits a different `--accent` per theme, so any literal in this file is
 * wrong in at least one of them, and the literal that shipped here first was a third blue that
 * matched neither.
 *
 * An empty answer means no stylesheet has applied the token yet. The caller omits `line-color`
 * altogether in that case rather than substituting something, so MapLibre's own default draws the
 * line: a line in the wrong colour, which is still a route the household can see.
 */
export function routeLineColor(root: HTMLElement = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue('--accent').trim()
}

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
  const basemapEnabled = basemapAllowed(basemap)

  // Every hook above the empty-route early return below, never the other way round: React calls
  // hooks in the order a component declares them, on every render, and an early return ahead of
  // one would call it on some renders and not others.
  useEffect(() => {
    if (!basemapEnabled || recorded.length === 0) return
    let cancelled = false
    let map: MapLibreMap | undefined
    let themeObserver: MutationObserver | undefined
    let unwatchScheme: (() => void) | undefined
    // The one place this file names MapLibre as a value rather than a type, and it is reached only
    // once basemapEnabled is true - see the module comment above for why a static import anywhere
    // else in this file would defeat the setting this effect exists to respect.
    // loadMapLibre rather than importing maplibre-gl here: without the worker URL it sets, the
    // tiles drew and the route line never did (see its own comment).
    void loadMapLibre().then(({ Map }) => {
      if (cancelled || mapContainerRef.current === null) return
      const instance = new Map({
        container: mapContainerRef.current,
        // Read at build time, not captured when the module loaded, and re-read by the observers
        // below: a household that switches theme with this card open gets the new accent and the
        // matching tiles without the map being rebuilt.
        style: basemapStyle(recorded, { lineColor: routeLineColor(), dark: isDarkTheme() }),
        bounds: routeBounds(recorded),
        fitBoundsOptions: { padding: 24 },
      })
      map = instance
      const retheme = () => {
        if (cancelled) return
        const paint = isDarkTheme() ? DARK_RASTER_PAINT : LIGHT_RASTER_PAINT
        for (const property of Object.keys(paint) as (keyof typeof DARK_RASTER_PAINT)[]) {
          instance.setPaintProperty('osm', property, paint[property])
        }
        const accent = routeLineColor()
        if (accent !== '') instance.setPaintProperty('workout-route-line', 'line-color', accent)
      }
      // The two ways the effective theme changes, watched the way useChart.ts watches them.
      themeObserver = new MutationObserver(retheme)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      const scheme = window.matchMedia('(prefers-color-scheme: dark)')
      scheme.addEventListener('change', retheme)
      unwatchScheme = () => scheme.removeEventListener('change', retheme)
    })
    // cancelled guards the promise continuation above against a component that unmounted, or a
    // setting that flipped off, before the import resolved; map?.remove() tears down the one that
    // did finish constructing, on the same cleanup path.
    return () => {
      cancelled = true
      themeObserver?.disconnect()
      unwatchScheme?.()
      map?.remove()
    }
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
