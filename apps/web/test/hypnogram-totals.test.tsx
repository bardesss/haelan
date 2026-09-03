import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { stageTotals, Hypnogram } from '../src/charts/Hypnogram.js'

const seg = (stage: string, fromMin: number, toMin: number) =>
  ({ stage, startMs: fromMin * 60_000, endMs: toMin * 60_000 })

describe('stageTotals', () => {
  it('totals each stage from the segments the chart itself draws', () => {
    const totals = stageTotals([seg('LIGHT', 0, 30), seg('DEEP', 30, 50), seg('LIGHT', 50, 60)])
    expect(totals).toContainEqual({ stage: 'LIGHT', minutes: 40 })
    expect(totals).toContainEqual({ stage: 'DEEP', minutes: 20 })
  })

  // The provider reports sleep on a 30 second grid, so rounding each segment before summing
  // inflates every total. That defect cost 1,568 invented minutes in the derivation and was fixed
  // in #85 by summing milliseconds and rounding once; this must not reintroduce it.
  // Two segments of 2.5 minutes are 5 minutes. Rounding each first gives 3 + 3 = 6.
  it('sums milliseconds and rounds once, rather than rounding each segment', () => {
    const totals = stageTotals([
      { stage: 'LIGHT', startMs: 0, endMs: 150_000 },
      { stage: 'LIGHT', startMs: 150_000, endMs: 300_000 },
    ])
    expect(totals).toContainEqual({ stage: 'LIGHT', minutes: 5 })
  })

  it('answers an empty list for a night with no segments', () => {
    expect(stageTotals([])).toEqual([])
  })
})

// No I18nProvider mounted, the same convention chart-marks.test.tsx and metric-card.test.tsx
// state at their own top: with no i18next instance initialised, t() returns the key it was asked
// for, so asserting on a catalogue key is asserting on the key the component actually chose, not
// on translated copy a locale file is free to reword.
describe('Hypnogram', () => {
  it('renders an explicit not-staged state for a classic night, rather than a blank row or zeros', () => {
    // A classic night's segments never reach Hypnogram at all: Sleep.tsx's own stageOf drops
    // ASLEEP/RESTLESS, leaving an empty segments array, which is exactly what stageTotals answers
    // for a night with no DEEP/LIGHT/REM segments (see stageTotals' own "empty list" test above).
    const html = renderToStaticMarkup(
      <Hypnogram segments={[]} startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15" />,
    )
    expect(html).toContain('charts.absence.notStaged')
    // Neither a blank total nor an invented zero: none of the four stage labels appear at all,
    // since none of them were measured.
    expect(html).not.toContain('sleep.stage.deep')
    expect(html).not.toContain('sleep.stage.light')
    expect(html).not.toContain('sleep.stage.rem')
    expect(html).not.toContain('sleep.stage.awake')
  })

  it('renders the per-stage totals row for a staged night, named through the shared stage labels', () => {
    const html = renderToStaticMarkup(
      <Hypnogram
        segments={[
          { stage: 'light', from: 0, to: 30 }, { stage: 'deep', from: 30, to: 50 },
          { stage: 'light', from: 50, to: 60 },
        ]}
        startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15"
      />,
    )
    expect(html).not.toContain('charts.absence.notStaged')
    expect(html).toContain('sleep.stage.light')
    expect(html).toContain('sleep.stage.deep')
  })
})
