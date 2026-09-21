// @vitest-environment happy-dom
//
// happy-dom only for document.createElement/querySelector on the rendered string; WorkoutRoute's
// own map-mounting effect (Task 6) never runs under renderToStaticMarkup - React does not run
// effects for a string render - so the off/on markup this file asserts is exactly what a first
// paint shows before that effect has had a chance to do anything, and no WebGL canvas or echarts
// stub is needed to get it.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { WorkoutRoute, projectRoute, basemapStyle, routeBounds, routeGeoJSON, routeLineColor } from '../src/pages/activity/WorkoutRoute.js'
import { routeBasemapStatusKey } from '../src/data/useRouteBasemap.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { RoutePoint } from '../src/data/useSessions.js'

// This file is the boundary this task's brief names directly: the layout check that is this app's
// only browser-level coverage never opens the workout page's tabs, and could not judge a drawn
// polyline even if it did - the same gap that shipped an unassertable filled-day marker and an icon
// nobody caught rendering at the height of its card. What is asserted below is what a test actually
// can reach: the accessible description text (the one thing a screen reader gets for the drawing),
// the card's presence and absence, which of the two states rendered, and the pure projection and
// basemap maths in isolation. The drawn shape's real look on a real screen, and MapLibre's own
// rendered tiles, are not covered anywhere in this suite.

function point(overrides: Partial<RoutePoint> = {}): RoutePoint {
  return {
    atMs: 0, latitude: 52, longitude: 5,
    altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    ...overrides,
  }
}

const NEAR: RoutePoint = point({ latitude: 52.00 })
const FAR: RoutePoint = point({ latitude: 52.01 })

const SESSION: Session = {
  personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: false,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

/**
 * Seeded with both the session and the basemap status already in the cache, the way
 * settings-about.test.tsx's own render() is: react-query hands back cached data on the first
 * render, so a static render sees the state a case is about rather than the loading state every
 * case would otherwise share, and reaches no real network to get there. Off unless a case asks
 * otherwise - the default this whole setting is designed around.
 */
function renderCard(route: readonly RoutePoint[] | undefined, basemapEnabled = false): Element | null {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), SESSION)
  client.setQueryData(routeBasemapStatusKey(), { enabled: basemapEnabled })
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider lng="en"><WorkoutRoute route={route} /></I18nProvider>
    </QueryClientProvider>,
  )
  return host.firstElementChild
}

describe('the route card', () => {
  it('renders no card at all when the session carries no points', () => {
    expect(renderCard([])).toBeNull()
  })

  // WorkoutSplits.tsx's own precedent for autoSplits/laps applies unchanged here: an older cached
  // response can simply be missing the field, and this app has no error boundary around this
  // section, so the component must treat `undefined` exactly like an empty array rather than throw.
  it('renders no card at all when the route field is missing entirely, not just empty', () => {
    expect(renderCard(undefined)).toBeNull()
  })

  it('gives the drawing an accessible description, with no distance or elevation figure in it', () => {
    const card = renderCard([NEAR, FAR])
    expect(card).not.toBeNull()
    const svg = card!.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('The route drawn as a line')
  })

  it('draws a single point as a dot, not an invisible one-point line', () => {
    const card = renderCard([NEAR])
    expect(card!.querySelector('polyline')).toBeNull()
    expect(card!.querySelector('circle.workout-route-point')).not.toBeNull()
  })

  it('states how many points the phone recorded as the card\'s basis', () => {
    const card = renderCard([NEAR, FAR, point({ latitude: 52.02 })])
    expect(card!.querySelector('.basis')?.textContent).toBe('every point the phone recorded, 3 in total')
  })

  // Fix round 1 on this task removed the card's own distance and elevation figures: WorkoutTiles
  // already states both from the provider, and a second, independently computed number a few
  // percent off it, labelled the same thing, on the same page, is worse than no second number at
  // all. Pinned here rather than only in the removal itself, so a later change re-adding a stat
  // tile to this card has to notice and decide again, not slide it back in unnoticed.
  it('shows nothing numeric beside the drawing', () => {
    const card = renderCard([NEAR, FAR])
    expect(card!.querySelector('.value')).toBeNull()
  })
})

describe('projectRoute', () => {
  it('scales longitude and latitude by the same factor, so the drawn shape keeps its own ratio', () => {
    // Symmetric about the equator so the mean latitude is exactly zero and the cos() correction is
    // exactly 1, which makes the expected span arithmetic below exact rather than approximate.
    const points = [point({ latitude: 0.5, longitude: 0 }), point({ latitude: -0.5, longitude: 2 })]
    const { points: projected, viewWidth, viewHeight } = projectRoute(points)
    const contentWidth = viewWidth - 2 * 16
    const contentHeight = viewHeight - 2 * 16
    // The source span was 2 degrees of longitude against 1 degree of latitude - a 2:1 box - and
    // the drawn content (padding stripped off both sides) has to keep that same 2:1 ratio, which a
    // single shared scale factor guarantees and two independent ones would not.
    expect(contentWidth / contentHeight).toBeCloseTo(2, 5)
    expect(projected.length).toBe(2)
  })

  // The test above is exact BECAUSE it sits on the equator, where the cos() correction is 1 - so it
  // cannot tell a correction from its absence. This one is the other half: away from the equator a
  // degree of longitude covers less ground than a degree of latitude, and the drawing has to say
  // so, or every route drawn at this household's latitude comes out stretched sideways.
  it('squeezes longitude by cos(latitude), so a route away from the equator is not stretched', () => {
    // One degree each way, centred on 60 north, where cos is exactly 0.5: a degree of longitude is
    // half the ground distance of a degree of latitude there, so the drawn box has to be half as
    // wide as it is tall. Without the correction the same points draw square.
    const points = [point({ latitude: 59.5, longitude: 4 }), point({ latitude: 60.5, longitude: 5 })]
    const { viewWidth, viewHeight } = projectRoute(points)
    const contentWidth = viewWidth - 2 * 16
    const contentHeight = viewHeight - 2 * 16
    expect(
      contentWidth / contentHeight,
      'a one-degree-square route at 60 north drew square, which means longitude was not scaled by '
      + 'cos(latitude) and every route is stretched east-west by the cosine of wherever it was run.',
    ).toBeCloseTo(0.5, 5)
  })

  // Nothing else in this suite looks at which way up the drawing comes out. A route rendered
  // upside-down is a correct-looking line of the right shape, in the wrong orientation, and it
  // passed every test in this repository.
  it('draws north as up, since latitude increases north and an svg y axis increases downward', () => {
    const south = point({ latitude: 52.00, longitude: 4.3 })
    const north = point({ latitude: 52.05, longitude: 4.3 })
    const { points: projected } = projectRoute([south, north])
    expect(
      projected[1]!.y,
      'the northern point drew BELOW the southern one, so the route is mirrored top to bottom: an '
      + "svg's y axis increases downward while latitude increases north, and the negation in "
      + 'projectRoute is what reconciles them.',
    ).toBeLessThan(projected[0]!.y)
  })

  it('draws a route with no span at all into a small fixed box, rather than dividing by zero', () => {
    const { points: projected, viewWidth, viewHeight } = projectRoute([NEAR, { ...NEAR }])
    expect(Number.isFinite(viewWidth)).toBe(true)
    expect(Number.isFinite(viewHeight)).toBe(true)
    expect(projected.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
})

/**
 * The two states the route-basemap setting (About.tsx) puts this card in. Off is the one the
 * whole design rests on, so it is asserted by what is absent from the rendered markup rather than
 * by what the on case adds: no element MapLibre would attach to, and no tile URL in the output.
 * This is a claim about what this render produced, not about the module's own source text - the
 * static grep proof that MapLibre is never imported unconditionally belongs to the build check
 * this task's report records, not to a unit test that imports this module regardless of state.
 */
describe('the basemap setting', () => {
  it('off: draws the bare trace and nothing a map library could attach to', () => {
    const card = renderCard([NEAR, FAR], false)
    expect(card!.querySelector('svg')).not.toBeNull()
    expect(card!.querySelector('.workout-route-map')).toBeNull()
    expect(card!.innerHTML).not.toContain('tile.openstreetmap.org')
    expect(card!.innerHTML).not.toContain('maplibre')
  })

  it('on: draws a map container instead of the trace, carrying the same accessible description', () => {
    const card = renderCard([NEAR, FAR], true)
    expect(card!.querySelector('svg')).toBeNull()
    const mapEl = card!.querySelector('.workout-route-map')
    expect(mapEl).not.toBeNull()
    expect(mapEl?.getAttribute('role')).toBe('img')
    expect(mapEl?.getAttribute('aria-label')).toBe('The route drawn as a line')
  })

  it('off stays off while the setting is still loading, not only once it answers false', () => {
    // No client.setQueryData at all: the query is pending, basemap.data is undefined, and
    // `=== true` reads that the same way it reads an explicit false - a card that guessed "on"
    // while waiting for the answer could start the very request this setting exists to gate.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><WorkoutRoute route={[NEAR, FAR]} /></I18nProvider>
      </QueryClientProvider>,
    )
    expect(host.firstElementChild!.querySelector('.workout-route-map')).toBeNull()
  })
})

/**
 * The pure maths the on-state effect hands to MapLibre, tested directly rather than through a
 * mounted map: this suite has no WebGL canvas to mount one onto, and the whole reason these are
 * exported functions rather than object literals built inline in the effect is so what a household
 * that switches this on is actually pointed at can be asserted without one.
 */
describe('basemapStyle, routeBounds and routeGeoJSON', () => {
  it('points MapLibre at OpenStreetMap\'s own raster tiles', () => {
    const style = basemapStyle()
    const osm = style.sources.osm as { type: string, tiles: string[] }
    expect(osm.type).toBe('raster')
    expect(osm.tiles).toEqual(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'])
    expect(style.layers.map((layer) => layer.id)).toContain('osm')
  })

  it('bounds a route by its own extremes, west/south before east/north', () => {
    const bounds = routeBounds([point({ latitude: 52, longitude: 5 }), point({ latitude: 52.01, longitude: 5.02 })])
    expect(bounds).toEqual([[5, 52], [5.02, 52.01]])
  })

  it('carries every point into one LineString, longitude before latitude', () => {
    const feature = routeGeoJSON([NEAR, FAR])
    expect(feature.type).toBe('Feature')
    expect(feature.geometry.coordinates).toEqual([[5, 52], [5, 52.01]])
  })
})


/**
 * MapLibre cannot resolve `var(--accent)`, so the route line's colour is read off the document and
 * handed over resolved. What is worth asserting is the reading, not a value: a test that pinned the
 * blue would be a second copy of the token and would go green on exactly the drift it exists to
 * catch, since the literal that shipped here first matched neither theme's accent.
 */
describe('routeLineColor', () => {
  it('reads the accent token off the element it is given', () => {
    const root = document.createElement('div')
    root.style.setProperty('--accent', 'rgb(35, 118, 233)')
    document.body.append(root)
    expect(routeLineColor(root)).toBe('rgb(35, 118, 233)')
    root.remove()
  })

  it('answers empty when no stylesheet has set the token, so the caller can omit the colour', () => {
    const root = document.createElement('div')
    document.body.append(root)
    expect(routeLineColor(root)).toBe('')
    root.remove()
  })
})
