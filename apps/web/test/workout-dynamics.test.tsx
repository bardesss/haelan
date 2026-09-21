// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkoutDynamics } from '../src/pages/activity/WorkoutDynamics.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'

/**
 * StatTile is a fragment: it emits a header, a value and a basis as three sibling elements and
 * leaves the box to its caller. Every other call site wraps it in a Card. This one dropped bare
 * tiles into a CSS grid, so five tiles became fifteen grid items and the browser laid label,
 * value and basis out in a single run - the basis of the last tile wrapping onto its own row,
 * detached from the figure it describes.
 *
 * So these tests count the grid's own children rather than looking for text. A test asserting the
 * five labels are present passed throughout the bug: every label rendered, in the wrong box.
 */

const EMPTY: WorkoutDetail = {
  displayName: null, notes: null, activeDurationSeconds: null, hasGps: false, routeConsentRequired: false,
  poolLengthMeters: null, runVo2Max: null, averageSpeedMetersPerSecond: null,
  totalSwimLengths: null, zones: null, mobility: null, autoSplits: [], laps: [], events: [],
}

const withMobility = (mobility: WorkoutDetail['mobility']): WorkoutDetail => ({ ...EMPTY, mobility })

const ALL_FIVE = {
  cadenceStepsPerMinute: 167,
  strideLengthMeters: 0.85,
  groundContactTimeSeconds: 0.319,
  verticalOscillationMeters: 0.102,
  verticalRatio: 12,
}

function grid(detail: WorkoutDetail): Element | null {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<WorkoutDynamics detail={detail} />)
  return host.querySelector('.workout-dynamics')
}

describe('the running dynamics card', () => {
  it('gives the grid one child per tile, not one per element inside a tile', () => {
    const rendered = grid(withMobility(ALL_FIVE))
    expect(rendered).not.toBeNull()
    expect(rendered!.children.length).toBe(5)
  })

  it('keeps each tile\'s label, value and basis inside that tile', () => {
    const rendered = grid(withMobility(ALL_FIVE))
    for (const tile of Array.from(rendered!.children)) {
      expect(tile.querySelector('.label')).not.toBeNull()
      expect(tile.querySelector('.value')).not.toBeNull()
    }
  })

  it('counts only the fields the device recorded', () => {
    const rendered = grid(withMobility({ ...ALL_FIVE, verticalRatio: null, strideLengthMeters: null }))
    expect(rendered!.children.length).toBe(3)
  })

  it('states the provenance once for the card rather than once per tile', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<WorkoutDynamics detail={withMobility(ALL_FIVE)} />)
    expect(host.querySelectorAll('.basis').length).toBe(1)
  })

  it('renders nothing at all when the session is not an advanced run', () => {
    expect(renderToStaticMarkup(<WorkoutDynamics detail={EMPTY} />)).toBe('')
  })
})
