// @vitest-environment happy-dom
//
// happy-dom for getComputedStyle and MutationObserver: mountBasemap reads the map's colours off the
// root element and restyles when its data-theme changes, and both are what these tests drive. No
// WebGL anywhere - MapLibre's Map is a stand-in that records what it was handed.
import { afterEach, describe, expect, it } from 'vitest'
import { emitCss, resolveMap, resolveSemantic, mapVar, MAP_KEYS, type Theme } from '@haelan/tokens'
import type { StyleSpecification } from 'maplibre-gl'
import {
  basemapStyle, readMapColors, routeBounds, routeGeoJSON, mountBasemap, MAP_COLOR_VARS,
  OPENFREEMAP_TILEJSON, OPENFREEMAP_GLYPHS, type MapColors,
} from '../src/pages/activity/basemap.js'
import type { RoutePoint } from '../src/data/useSessions.js'

function point(latitude: number, longitude: number): RoutePoint {
  return {
    atMs: 0, latitude, longitude,
    altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
  }
}

const NEAR = point(52.00, 5)
const FAR = point(52.01, 5)

// Every colour distinct, so an assertion that one landed on a layer cannot pass by coincidence
// because two roles happened to share a value.
const COLORS: MapColors = {
  land: '#000001', water: '#000002', park: '#000003', building: '#000004',
  road: '#000005', roadMajor: '#000006', label: '#000007', labelHalo: '#000008', route: '#000009',
}

type AnyLayer = { id: string, type: string, source?: string, 'source-layer'?: string, paint?: Record<string, unknown> }
const layers = (style: StyleSpecification) => style.layers as AnyLayer[]
const layer = (style: StyleSpecification, id: string) => {
  const found = layers(style).find((l) => l.id === id)
  if (!found) throw new Error(`no layer ${id}`)
  return found
}

describe('basemapStyle', () => {
  // The privacy sentence at the switch names OpenFreeMap and nobody else, so every URL in the
  // style has to be one of its. No sprite: nothing here draws an icon, and a sprite would be one
  // more request to account for.
  it('points MapLibre at OpenFreeMap\'s vector tiles and glyphs, and at nothing else', () => {
    const style = basemapStyle([NEAR, FAR], COLORS)
    expect(style.sources.openfreemap).toMatchObject({ type: 'vector', url: 'https://tiles.openfreemap.org/planet' })
    expect(OPENFREEMAP_TILEJSON).toBe('https://tiles.openfreemap.org/planet')
    expect(style.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf')
    expect(OPENFREEMAP_GLYPHS).toBe(style.glyphs)
    expect(style.sprite).toBeUndefined()
    expect(Object.keys(style.sources).sort()).toEqual(['openfreemap', 'workout-route'])
  })

  it('credits OpenFreeMap, OpenMapTiles and OpenStreetMap, linked, as OpenFreeMap asks', () => {
    const attribution = (basemapStyle([NEAR, FAR], COLORS).sources.openfreemap as { attribution: string }).attribution
    expect(attribution).toContain('href="https://openfreemap.org"')
    expect(attribution).toContain('&copy; OpenMapTiles')
    expect(attribution).toContain('href="https://www.openstreetmap.org/copyright"')
  })

  // The style is hand-built over OpenMapTiles' schema, so a misspelled source layer draws nothing
  // and raises nothing. These names were read off OpenFreeMap's own TileJSON.
  it('reads only source layers the OpenMapTiles schema has', () => {
    const schema = new Set(['water', 'waterway', 'landcover', 'park', 'building', 'transportation', 'transportation_name', 'place'])
    for (const l of layers(basemapStyle([NEAR, FAR], COLORS))) {
      if (l.source === 'openfreemap') expect(schema, `${l.id} reads ${l['source-layer']}`).toContain(l['source-layer'])
    }
  })

  it('paints every base feature in the token it was handed', () => {
    const style = basemapStyle([NEAR, FAR], COLORS)
    expect(layer(style, 'land').paint).toMatchObject({ 'background-color': COLORS.land })
    expect(layer(style, 'water').paint).toMatchObject({ 'fill-color': COLORS.water })
    expect(layer(style, 'waterway').paint).toMatchObject({ 'line-color': COLORS.water })
    expect(layer(style, 'park').paint).toMatchObject({ 'fill-color': COLORS.park })
    expect(layer(style, 'landcover').paint).toMatchObject({ 'fill-color': COLORS.park })
    expect(layer(style, 'building').paint).toMatchObject({ 'fill-color': COLORS.building })
    expect(layer(style, 'road-minor').paint).toMatchObject({ 'line-color': COLORS.road })
    expect(layer(style, 'road-major').paint).toMatchObject({ 'line-color': COLORS.roadMajor })
    for (const id of ['road-label', 'place-label']) {
      expect(layer(style, id).paint).toMatchObject({ 'text-color': COLORS.label, 'text-halo-color': COLORS.labelHalo })
    }
  })

  // Nothing in the style may carry a colour of its own: a literal is a colour that is right in at
  // most one theme, which is the whole defect the raster map had.
  it('carries no colour that did not come from the tokens', () => {
    const handed = new Set(Object.values(COLORS))
    const text = JSON.stringify(basemapStyle([NEAR, FAR], COLORS))
    const colours = text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? []
    expect(colours.filter((c) => !handed.has(c))).toEqual([])
  })

  // The route rides in the style itself. Added from a 'load' handler it waited on every tile in
  // view, and a slow tile left the household looking at bare streets.
  it('carries the route in the style, drawn last, above every base layer, in the accent', () => {
    const style = basemapStyle([NEAR, FAR], COLORS)
    const route = style.sources['workout-route'] as { type: string, data: { geometry: { coordinates: number[][] } } }
    expect(route.type).toBe('geojson')
    expect(route.data.geometry.coordinates).toEqual([[5, 52], [5, 52.01]])
    expect(layers(style).map((l) => l.id)).toEqual([
      'land', 'landcover', 'park', 'water', 'waterway', 'building', 'road-minor', 'road-major',
      'road-label', 'place-label', 'workout-route-line',
    ])
    const line = layer(style, 'workout-route-line')
    expect(line.source).toBe('workout-route')
    expect(line.paint).toEqual({ 'line-color': COLORS.route, 'line-width': 3 })
  })

  it('leaves the line colour to MapLibre when the accent could not be read', () => {
    const style = basemapStyle([NEAR, FAR], { ...COLORS, route: '' })
    expect(layer(style, 'workout-route-line').paint).toEqual({ 'line-width': 3 })
  })
})

describe('routeBounds and routeGeoJSON', () => {
  it('bounds a route by its own extremes, west/south before east/north', () => {
    expect(routeBounds([point(52, 5), point(52.01, 5.02)])).toEqual([[5, 52], [5.02, 52.01]])
  })

  it('carries every point into one LineString, longitude before latitude', () => {
    const feature = routeGeoJSON([NEAR, FAR])
    expect(feature.type).toBe('Feature')
    expect(feature.geometry.coordinates).toEqual([[5, 52], [5, 52.01]])
  })
})

/** The declarations emitCss writes for one theme, as a getPropertyValue a test can hand over. */
function themeStyle(theme: Theme) {
  const values: Record<string, string> = { '--accent': resolveSemantic(theme).accent }
  for (const token of MAP_KEYS) values[mapVar(token)] = resolveMap(theme)[token]
  return { getPropertyValue: (name: string) => values[name] ?? '' }
}

/**
 * MapLibre cannot resolve `var(--map-water)`, so the map's colours are read off the document and
 * handed over resolved. What is worth asserting is the reading and the names, not the values: a
 * test that pinned a hex would be a second copy of the token and go green on exactly the drift it
 * exists to catch.
 */
describe('readMapColors', () => {
  it('reads each map colour, and the route from the accent, off the custom properties', () => {
    const colors = readMapColors(themeStyle('dark'))
    expect(colors.water).toBe(resolveMap('dark').water)
    expect(colors.roadMajor).toBe(resolveMap('dark')['road-major'])
    expect(colors.labelHalo).toBe(resolveMap('dark')['label-halo'])
    expect(colors.route).toBe(resolveSemantic('dark').accent)
    expect(readMapColors(themeStyle('light')).water).toBe(resolveMap('light').water)
  })

  it('fails loudly on a missing map token rather than drawing it in MapLibre\'s default', () => {
    const style = themeStyle('dark')
    const without = { getPropertyValue: (name: string) => (name === '--map-park' ? '' : style.getPropertyValue(name)) }
    expect(() => readMapColors(without)).toThrow(/--map-park/)
  })

  it('answers an empty route when no stylesheet has set the accent, so the caller can omit it', () => {
    const style = themeStyle('dark')
    const without = { getPropertyValue: (name: string) => (name === '--accent' ? '' : style.getPropertyValue(name)) }
    expect(readMapColors(without).route).toBe('')
  })

  // Renaming a token in @haelan/tokens would otherwise leave every test here green and the first
  // map a household opened throwing. And every value has to be hex in both themes: MapLibre parses
  // colours itself, and the color-mix() the stylesheet uses elsewhere would draw nothing at all.
  it('reads only custom properties the generated stylesheet defines, each as a hex MapLibre can parse', () => {
    const css = emitCss()
    for (const variable of MAP_COLOR_VARS) {
      const declarations = [...css.matchAll(new RegExp(`${variable}: ([^;]+);`, 'g'))].map((m) => m[1])
      expect(declarations.length, `${variable} is read by the map but never emitted`).toBeGreaterThan(0)
      for (const value of declarations) expect(value, variable).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

/**
 * The theme switch, driven through mountBasemap's real observers. What has to survive it is the
 * route: the raster version set paint on its tile layer and its line one by one, and a style swap
 * done carelessly would repaint the streets and drop the line the card exists to show.
 */
describe('mountBasemap', () => {
  const root = document.documentElement
  afterEach(() => {
    root.removeAttribute('data-theme')
    root.removeAttribute('style')
  })

  function applyTheme(theme: Theme) {
    const style = themeStyle(theme)
    for (const variable of MAP_COLOR_VARS) root.style.setProperty(variable, style.getPropertyValue(variable))
    root.setAttribute('data-theme', theme)
  }

  function fakeMapLibre() {
    const built: { style: StyleSpecification }[] = []
    const restyled: StyleSpecification[] = []
    let removed = false
    class Map {
      constructor(options: { style: StyleSpecification }) { built.push(options) }
      setStyle(style: StyleSpecification) { restyled.push(style) }
      remove() { removed = true }
    }
    return { load: () => Promise.resolve({ Map } as never), built, restyled, removed: () => removed }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('builds the map in the current theme\'s tokens and restyles it, route and all, when the theme changes', async () => {
    applyTheme('dark')
    const maplibre = fakeMapLibre()
    const unmount = mountBasemap(document.createElement('div'), [NEAR, FAR], { load: maplibre.load, root })
    await settle()
    expect(maplibre.built).toHaveLength(1)
    expect(layer(maplibre.built[0]!.style, 'water').paint).toMatchObject({ 'fill-color': resolveMap('dark').water })

    applyTheme('light')
    await settle()
    const restyled = maplibre.restyled.at(-1)
    expect(restyled, 'switching data-theme did not restyle the map').toBeDefined()
    expect(layer(restyled!, 'water').paint).toMatchObject({ 'fill-color': resolveMap('light').water })
    expect(layer(restyled!, 'land').paint).toMatchObject({ 'background-color': resolveMap('light').land })
    expect(layers(restyled!).at(-1)?.id, 'the route line has to stay on top after a theme switch').toBe('workout-route-line')
    expect(layer(restyled!, 'workout-route-line').paint).toMatchObject({ 'line-color': resolveSemantic('light').accent })
    expect((restyled!.sources['workout-route'] as { data: unknown }).data).toEqual(routeGeoJSON([NEAR, FAR]))
    unmount()
  })

  it('stops watching the theme, and removes the map, once unmounted', async () => {
    applyTheme('dark')
    const maplibre = fakeMapLibre()
    const unmount = mountBasemap(document.createElement('div'), [NEAR, FAR], { load: maplibre.load, root })
    await settle()
    unmount()
    expect(maplibre.removed()).toBe(true)
    applyTheme('light')
    await settle()
    expect(maplibre.restyled).toEqual([])
  })

  it('builds nothing when unmounted before MapLibre arrived', async () => {
    applyTheme('dark')
    const maplibre = fakeMapLibre()
    mountBasemap(document.createElement('div'), [NEAR, FAR], { load: maplibre.load, root })()
    await settle()
    expect(maplibre.built).toEqual([])
  })
})
