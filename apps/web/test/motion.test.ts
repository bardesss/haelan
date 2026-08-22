import { describe, it, expect } from 'vitest'
import { withMotionPreference } from '../src/charts/base.js'

// Every chart animates on build and re-animates on every theme flip, because useChart re-runs
// setOption with notMerge. Eight pages of charts is eight pages of movement for a reader who
// asked their system for none. The preference is read once in the hook; this is the decision it
// feeds, kept a plain function so it is testable without a DOM.
describe('motion preference', () => {
  it('leaves a chart animated when nothing asks otherwise', () => {
    expect(withMotionPreference({ series: [] }, false).animation).toBe(true)
  })

  it('turns animation off when the reader asked for reduced motion', () => {
    expect(withMotionPreference({ series: [] }, true).animation).toBe(false)
  })

  // A stated preference is not a default to be overridden by whichever chart felt strongly.
  it('overrules a chart that asked for animation itself', () => {
    expect(withMotionPreference({ animation: true }, true).animation).toBe(false)
  })

  it('leaves the rest of the option object exactly as the chart built it', () => {
    const option = { series: [{ type: 'line' as const }], grid: { left: 4 } }
    expect(withMotionPreference(option, true)).toMatchObject(option)
  })
})
