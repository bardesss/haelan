import type { ExpressionSpecification, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import { mapVar, semanticVar, type MapToken, type SemanticToken } from '@haelan/tokens'
import type { RoutePoint } from '../../data/useSessions.js'
import { loadMapLibre } from './loadMapLibre.js'

// `import type` only, above: erased entirely at compile time, so naming MapLibre's own types here
// costs the off-by-default household nothing. The library's *value* is reached only through
// loadMapLibre's dynamic imports, from mountBasemap below, which WorkoutRoute calls once the
// setting is on - see WorkoutRoute's module comment for why a static import anywhere would undo it.

/**
 * OpenFreeMap's vector tiles, in the OpenMapTiles schema, and nobody else's.
 *
 * Vector rather than the raster tiles this card drew first, because a raster tile arrives already
 * coloured by whoever drew it: the dark theme could only get there by inverting OpenStreetMap's
 * light tiles with raster paint, and neither theme's map was ever in this app's palette. A vector
 * tile carries geometry and nothing else, so every colour below is ours, read off the same tokens
 * the rest of the page is painted with.
 *
 * One host for everything the map fetches - this TileJSON, the tiles it names, and the glyphs the
 * labels need - so the sentence About.tsx shows before an admin switches this on names one party
 * and it is the whole list. The style asks for no sprite, since it draws no icons, which keeps it
 * that way.
 */
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet'
export const OPENFREEMAP_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'

/**
 * OpenFreeMap's attribution, word for word and link for link as its own TileJSON states it. Set on
 * the source explicitly as well, rather than trusting the TileJSON to supply it: the source's own
 * option wins over the fetched one, so this is what shows whatever that file says on the day.
 */
export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> '
  + '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

/** A fontstack OpenFreeMap serves: its own published styles label with this one. */
const LABEL_FONT = ['Noto Sans Regular']

/**
 * Every colour the basemap is drawn in, already resolved. The style function takes these rather
 * than reading the document itself so a test can hand it explicit colours and assert where each one
 * went, with no stylesheet in sight.
 */
export interface MapColors {
  land: string
  water: string
  park: string
  building: string
  road: string
  roadMajor: string
  label: string
  labelHalo: string
  /** The route line, from `--accent`. Empty when no stylesheet has applied it yet - see below. */
  route: string
}

const MAP_SOURCES = {
  land: 'land',
  water: 'water',
  park: 'park',
  building: 'building',
  road: 'road',
  roadMajor: 'road-major',
  label: 'label',
  labelHalo: 'label-halo',
} as const satisfies Record<Exclude<keyof MapColors, 'route'>, MapToken>

const ROUTE_SOURCE: SemanticToken = 'accent'

/** Every custom property readMapColors reads, so a test can hold the list against the stylesheet. */
export const MAP_COLOR_VARS: readonly string[] = [...Object.values(MAP_SOURCES).map(mapVar), semanticVar(ROUTE_SOURCE)]

/**
 * The map's colours off the document, the way charts/tokens.ts reads the chart's.
 *
 * MapLibre parses colours itself and never resolves `var(--map-water)`, so each token has to be
 * read and handed over resolved. They arrive as the hex packages/tokens emits - its layering test
 * holds every map token to a six-digit hex, which matters here more than anywhere, since MapLibre
 * cannot parse the OKLCH or color-mix values a stylesheet could otherwise use - and a theme switch is
 * a second read, not a second palette kept in this file.
 *
 * A missing map token throws, as a missing chart token does: the stylesheet always defines them,
 * so absence is a rename that app-side code did not follow, and a map silently drawn in MapLibre's
 * default black is a worse way to find that out. The route is the exception, kept from the raster
 * version of this card: an empty `--accent` omits `line-color` so MapLibre's own default draws the
 * line, and a line in the wrong colour is still a route the household can see.
 */
export function readMapColors(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): MapColors {
  const out = { route: style.getPropertyValue(semanticVar(ROUTE_SOURCE)).trim() } as MapColors
  for (const [key, token] of Object.entries(MAP_SOURCES) as [keyof typeof MAP_SOURCES, MapToken][]) {
    const value = style.getPropertyValue(mapVar(token)).trim()
    if (!value) throw new Error(`missing map token ${mapVar(token)}`)
    out[key] = value
  }
  return out
}

/** The bounding box MapLibre fits the map to on load: every recorded point's own extremes, in the
 *  [[west, south], [east, north]] shape its own `bounds` option takes. */
export function routeBounds(points: readonly RoutePoint[]): [[number, number], [number, number]] {
  const lons = points.map((point) => point.longitude)
  const lats = points.map((point) => point.latitude)
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]]
}

/** The one shape a geojson source's data option needs, spelled out locally rather than pulled
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

const LINES: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false]
const POLYGONS: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]
const labelText: ExpressionSpecification = ['get', 'name']

/**
 * The style handed to MapLibre when the basemap setting is on: a small one of our own over
 * OpenFreeMap's vector tiles, with the route drawn last, above everything.
 *
 * Small on purpose. This map is a backdrop for one line, not something to navigate by, so it
 * draws land, water, green space, roads in two weights, buildings once close enough to matter, and
 * the names of streets and places - and nothing else. No railways, boundaries, points of interest
 * or icons: each is one more thing on the card competing with the route for the eye.
 *
 * Labels read `name`, the local one, rather than a translated `name:en`: the street sign the
 * household ran past is the name they know the street by.
 *
 * A pure function and exported, not built inline, so a test can assert what a household that
 * switches this on is actually pointed at, and that every colour came from the tokens it was
 * handed, without mounting a WebGL canvas to find out.
 *
 * The route is part of the style, not added afterwards. It used to be added in a 'load' handler,
 * and 'load' waits for every tile in view to finish: a slow tile server left the map sitting there
 * as bare streets, and a tile that never answered kept the route off it for good. In the style it
 * draws with the first frame the tiles do, and a theme switch that swaps the style (mountBasemap)
 * carries it across with everything else.
 */
export function basemapStyle(route: readonly RoutePoint[], colors: MapColors): StyleSpecification {
  const halo = { 'text-color': colors.label, 'text-halo-color': colors.labelHalo, 'text-halo-width': 1.5 }
  return {
    version: 8,
    glyphs: OPENFREEMAP_GLYPHS,
    sources: {
      openfreemap: { type: 'vector', url: OPENFREEMAP_TILEJSON, attribution: OPENFREEMAP_ATTRIBUTION },
      'workout-route': { type: 'geojson', data: routeGeoJSON(route) },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': colors.land } },
      {
        id: 'landcover', type: 'fill', source: 'openfreemap', 'source-layer': 'landcover',
        filter: ['all', POLYGONS, ['match', ['get', 'class'], ['grass', 'wood'], true, false]],
        paint: { 'fill-color': colors.park },
      },
      {
        id: 'park', type: 'fill', source: 'openfreemap', 'source-layer': 'park',
        filter: POLYGONS, paint: { 'fill-color': colors.park },
      },
      {
        // Tunnelled water is under something else, and drawing it would paint a culvert across
        // the road above it.
        id: 'water', type: 'fill', source: 'openfreemap', 'source-layer': 'water',
        filter: ['all', POLYGONS, ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'fill-color': colors.water },
      },
      {
        id: 'waterway', type: 'line', source: 'openfreemap', 'source-layer': 'waterway',
        filter: LINES,
        paint: { 'line-color': colors.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 2] },
      },
      {
        id: 'building', type: 'fill', source: 'openfreemap', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': colors.building },
      },
      {
        // Paths are in here with the streets, at half their width, because a run goes down them
        // far more often than a map meant for driving assumes: a route along a footpath the map
        // left out would look like it cut across a field.
        id: 'road-minor', type: 'line', source: 'openfreemap', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', LINES, ['match', ['get', 'class'], ['minor', 'service', 'track', 'path'], true, false]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colors.road,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'],
            12, ['match', ['get', 'class'], 'path', 0.5, 0.75],
            18, ['match', ['get', 'class'], 'path', 4, 10]],
        },
      },
      {
        id: 'road-major', type: 'line', source: 'openfreemap', 'source-layer': 'transportation', minzoom: 6,
        filter: ['all', LINES, ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk', 'motorway'], true, false]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colors.roadMajor,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
            8, ['match', ['get', 'class'], ['motorway', 'trunk'], 1, 0.5],
            18, ['match', ['get', 'class'], ['motorway', 'trunk'], 22, 16]],
        },
      },
      {
        id: 'road-label', type: 'symbol', source: 'openfreemap', 'source-layer': 'transportation_name', minzoom: 14,
        filter: LINES,
        layout: {
          'symbol-placement': 'line', 'text-field': labelText, 'text-font': LABEL_FONT,
          'text-size': 11, 'text-rotation-alignment': 'map',
        },
        paint: halo,
      },
      {
        id: 'place-label', type: 'symbol', source: 'openfreemap', 'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb'], true, false],
        layout: {
          'text-field': labelText, 'text-font': LABEL_FONT, 'text-max-width': 8,
          'text-size': ['match', ['get', 'class'], ['city', 'town'], 14, 12],
        },
        paint: halo,
      },
      {
        id: 'workout-route-line', type: 'line', source: 'workout-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: colors.route === ''
          ? { 'line-width': 3 }
          : { 'line-color': colors.route, 'line-width': 3 },
      },
    ],
  }
}

/** What mountBasemap needs from MapLibre and the page, injectable so a test can drive a theme
 *  switch through the real observers without a WebGL canvas. */
export interface MountDeps {
  load?: () => Promise<Pick<Awaited<ReturnType<typeof loadMapLibre>>, 'Map'>>
  root?: HTMLElement
  onMap?: (map: MapLibreMap) => void
}

/**
 * Builds the map into `container` and keeps it in the page's theme; returns the teardown.
 *
 * Out here rather than inline in WorkoutRoute's effect so the only code that builds this map is
 * code a test can run: the effect never runs under the static render that file's tests use, and a
 * throwaway page built through Vite can mount exactly what the app mounts.
 *
 * A theme switch re-reads the tokens and hands MapLibre the whole style again, route included,
 * rather than setting paint properties layer by layer. setStyle diffs against the style it has, so
 * what actually changes is the paint - the tiles and the route's source are equal and left alone -
 * and a new layer added to basemapStyle rethemes with no second list here to keep in step with it.
 */
export function mountBasemap(container: HTMLElement, route: readonly RoutePoint[], deps: MountDeps = {}): () => void {
  const root = deps.root ?? document.documentElement
  const load = deps.load ?? loadMapLibre
  let cancelled = false
  let map: MapLibreMap | undefined
  let themeObserver: MutationObserver | undefined
  let unwatchScheme: (() => void) | undefined
  const colors = () => readMapColors(getComputedStyle(root))

  void load().then(({ Map }) => {
    if (cancelled) return
    const instance = new Map({
      container,
      style: basemapStyle(route, colors()),
      bounds: routeBounds(route),
      fitBoundsOptions: { padding: 24 },
      // Always spelled out. MapLibre folds the attribution into an icon on any map under 640px
      // wide, which is every map on this card, and its icon is a dark glyph that vanishes on the
      // dark theme; one short line styled by app.css fits comfortably and is what OpenFreeMap asks.
      attributionControl: { compact: false },
    })
    map = instance
    deps.onMap?.(instance)
    const retheme = () => {
      if (!cancelled) instance.setStyle(basemapStyle(route, colors()))
    }
    // The two ways the effective theme changes, watched the way useChart.ts watches them: an
    // explicit choice on the root, and the system preference underneath it.
    themeObserver = new MutationObserver(retheme)
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', retheme)
    unwatchScheme = () => scheme.removeEventListener('change', retheme)
  })

  // cancelled guards the continuation above against a card that unmounted, or a setting that
  // flipped off, before the import resolved; map?.remove() tears down the one that did finish.
  return () => {
    cancelled = true
    themeObserver?.disconnect()
    unwatchScheme?.()
    map?.remove()
  }
}
