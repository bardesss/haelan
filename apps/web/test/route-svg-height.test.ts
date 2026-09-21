import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { projectRoute } from '../src/pages/activity/WorkoutRoute.js'
import type { RoutePoint } from '../src/data/useSessions.js'

/**
 * The route trace is drawn into a viewBox whose aspect ratio is the route's own shape, and the
 * element sizes itself from that ratio. Nothing in this suite renders it: the layout check is the
 * only browser-level coverage this app has and it never opens the workout page's tabs, so a card
 * several thousand pixels tall is invisible to every other test here.
 *
 * This file is two halves, and it needs both. One measures the real projection to show the hazard
 * is reachable rather than theoretical; the other reads the stylesheet for the clamp that answers
 * it. Neither alone means much - a bound with no demonstrated need is arbitrary, and a
 * demonstrated need with no bound is just a failing description of a bug.
 */
const CSS_PATH = '../src/app.css'
const css = readFileSync(new URL(CSS_PATH, import.meta.url), 'utf8')

function point(latitude: number, longitude: number): RoutePoint {
  return {
    atMs: 0, latitude, longitude,
    altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
  }
}

/** The declaration block of one class selector, as written. */
function rule(selector: string): string {
  const found = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
  expect(
    found,
    `app.css: no '${selector}' rule found - has it been renamed? This guard cannot check a rule it `
    + 'cannot find, and a guard that searches an empty string passes while watching nothing.',
  ).not.toBeNull()
  return found![1]!
}

describe('a tall route cannot take over the page', () => {
  it('projects a north-south route into an extremely tall viewBox', () => {
    // A run straight up a coastline: a real shape, and the one this clamp exists for. The route
    // barely moves in longitude and covers real ground in latitude.
    const { viewWidth, viewHeight } = projectRoute([
      point(52.00, 4.30), point(52.02, 4.3001), point(52.04, 4.30),
    ])
    const ratio = viewHeight / viewWidth
    expect(
      ratio,
      'the projection no longer produces a tall narrow viewBox for a north-south route, so the '
      + 'clamp below may no longer be needed - check why the shape changed before deleting it.',
    ).toBeGreaterThan(5)
    // What that ratio costs unclamped, on a card the width of a laptop's content column: the
    // element's height is its width times this ratio, and nothing else would stop it.
    expect(760 * ratio).toBeGreaterThan(3_000)
  })

  it('clamps the drawn height in the stylesheet', () => {
    const declarations = rule('.workout-route-svg')
    const maxHeight = /max-height:\s*(\d+)px/.exec(declarations)
    expect(
      maxHeight,
      "app.css: '.workout-route-svg' has no max-height. Without one the element takes its height "
      + "from the viewBox's aspect ratio, which is the route's own shape, and the test above shows "
      + 'that reaching several thousand pixels for one thin line takes an ordinary north-south '
      + 'run. The layout check never opens this page, so nothing else in this repository would '
      + 'notice.',
    ).not.toBeNull()
    // Matched to the map's own fixed height, so switching the basemap setting does not resize the
    // card around it.
    const mapHeight = /height:\s*(\d+)px/.exec(rule('.workout-route-map'))
    expect(mapHeight).not.toBeNull()
    expect(
      maxHeight![1],
      'the svg trace and the MapLibre basemap no longer agree on a height, so turning the basemap '
      + 'setting on or off would resize the card under the reader.',
    ).toBe(mapHeight![1])
  })
})
