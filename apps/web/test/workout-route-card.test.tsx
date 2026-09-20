// @vitest-environment happy-dom
//
// happy-dom only for document.createElement/querySelector on the rendered string; WorkoutRoute has
// no effect and no chart, so renderToStaticMarkup (workout-dynamics.test.tsx's own approach, for
// the same reason) is enough and there is no echarts stub to wire up here.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import { WorkoutRoute, projectRoute } from '../src/pages/activity/WorkoutRoute.js'
import type { RoutePoint } from '../src/data/useSessions.js'

// This file is the boundary this task's brief names directly: the layout check that is this app's
// only browser-level coverage never opens the workout page's tabs, and could not judge a drawn
// polyline even if it did - the same gap that shipped an unassertable filled-day marker and an icon
// nobody caught rendering at the height of its card. What is asserted below is what a test actually
// can reach: the accessible description text (the one thing a screen reader gets for the drawing),
// the card's presence and absence, and the pure projection maths in isolation. The drawn shape's
// real look on a real screen, and the SVG's rendered size against a real card's width, are not
// covered anywhere in this suite.

function point(overrides: Partial<RoutePoint> = {}): RoutePoint {
  return {
    atMs: 0, latitude: 52, longitude: 5,
    altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    ...overrides,
  }
}

const NEAR: RoutePoint = point({ latitude: 52.00 })
const FAR: RoutePoint = point({ latitude: 52.01 })

function renderCard(route: readonly RoutePoint[] | undefined): Element | null {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<I18nProvider lng="en"><WorkoutRoute route={route} /></I18nProvider>)
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

  it('draws a route with no span at all into a small fixed box, rather than dividing by zero', () => {
    const { points: projected, viewWidth, viewHeight } = projectRoute([NEAR, { ...NEAR }])
    expect(Number.isFinite(viewWidth)).toBe(true)
    expect(Number.isFinite(viewHeight)).toBe(true)
    expect(projected.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
})
