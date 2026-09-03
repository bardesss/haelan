import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { stageTotals, Hypnogram } from '../src/charts/Hypnogram.js'
import type { Stage } from '../src/fixtures/july.js'

const seg = (stage: string, fromMin: number, toMin: number) =>
  ({ stage, startMs: fromMin * 60_000, endMs: toMin * 60_000 })

// The totals row's own text, not the whole render: the accessible table right above it legitimately
// prints strings like "0h 05m" as segment boundary times (a "to" cell is a clock offset, not a
// summed duration), so scanning the full HTML for a duration substring can match an unrelated,
// correct table cell instead of the row this file actually means to pin.
function totalsRowText(html: string): string {
  const match = html.match(/<p class="hypnogram-totals">([^<]*)<\/p>/)
  if (!match) throw new Error(`no totals row in:\n${html}`)
  return match[1]!
}

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
    // Exactly the absence key, not a blank total or an invented zero for any of the four stages.
    expect(totalsRowText(html)).toBe('charts.absence.notStaged')
  })

  it('renders the per-stage totals row for a staged night, named through the shared stage labels', () => {
    const html = renderToStaticMarkup(
      <Hypnogram
        segments={[
          { stage: 'light', startMs: 0, endMs: 30 * 60_000 }, { stage: 'deep', startMs: 30 * 60_000, endMs: 50 * 60_000 },
          { stage: 'light', startMs: 50 * 60_000, endMs: 60 * 60_000 },
        ]}
        startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15"
      />,
    )
    expect(totalsRowText(html)).toBe('sleep.stage.deep 0h 20m, sleep.stage.light 0h 40m')
  })

  // The Awake tile and this row describe one night and can legitimately disagree:
  // sleep_awake_minutes is AWAKE plus RESTLESS plus gapMsWithin (packages/core/src/derive/
  // sleep.ts), while this row sums the AWAKE segments the chart above actually drew, so the tile
  // is the larger figure on any multi-piece night. Two numbers for one night with nothing saying
  // which is which is the defect; naming what this one counts is the fix, and it is stated only on
  // a night that has an awake total to be read the wrong way.
  it('says what its own awake total counts, on a night that has one', () => {
    const html = renderToStaticMarkup(
      <Hypnogram
        segments={[
          { stage: 'light', startMs: 0, endMs: 30 * 60_000 },
          { stage: 'awake', startMs: 30 * 60_000, endMs: 45 * 60_000 },
        ]}
        startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15"
      />,
    )
    expect(totalsRowText(html)).toBe(
      'sleep.stage.light 0h 30m, sleep.stage.awake 0h 15m charts.hypnogram.awakeNote',
    )
  })

  // The other half, and the reason the clause is conditional rather than always printed: a night
  // with no awake segment has nothing here for a tile to disagree with, and a standing caveat
  // about a figure that is not on the row would be noise on every such night.
  it('leaves the clause off a night with no awake total at all', () => {
    const html = renderToStaticMarkup(
      <Hypnogram
        segments={[{ stage: 'light', startMs: 0, endMs: 30 * 60_000 }]}
        startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15"
      />,
    )
    expect(totalsRowText(html)).toBe('sleep.stage.light 0h 30m')
  })

  // Review round 1's own Critical: Sleep.tsx and Dashboard.tsx used to round each segment
  // boundary to a whole minute before Hypnogram ever saw it, so a stage's total was built from
  // rounded boundaries rather than from the real spans they measured. That is no longer possible
  // to reproduce by driving Hypnogram directly, because its own `segments` prop now carries raw
  // milliseconds and neither page rounds before handing them over (see Sleep.tsx's and
  // Dashboard.tsx's own comments on hypnogramSegments) -- this pins that Hypnogram, fed the exact
  // half-minute-boundary shape the provider sends, reports the true total rather than a rounded
  // one, which is the property that made the old call-site rounding invisible from here. The
  // end-to-end regression, which drives the actual pre-rounding call site and fails against it,
  // lives in sleep-page.test.tsx's "totals a night built from half minute segment boundaries..."
  it('totals a night built from half minute boundaries to its true duration, not a rounded one', () => {
    // Ten segments of 90 seconds each, alternating LIGHT/DEEP, boundaries at 0, 1.5, 3, 4.5 ...
    // minutes: every boundary sits on the provider's own 30 second grid, the shape a real night's
    // segments actually carry. True total per stage is 5 * 1.5 = 7.5 minutes, which a single
    // rounding takes to 8. Rounding each boundary to a whole minute first (the pre-fix call site)
    // read LIGHT as 10 and DEEP as 5 instead, computed by hand from the rounded boundaries
    // 0,2,3,5,6,8,9,11,12,14,15: LIGHT's five segments (0-2, 3-5, 6-8, 9-11, 12-14) sum to 10,
    // DEEP's five (2-3, 5-6, 8-9, 11-12, 14-15) sum to 5.
    const boundaries = Array.from({ length: 11 }, (_, i) => i * 90_000)
    const segments = boundaries.slice(0, -1).map((startMs, i) => ({
      stage: (i % 2 === 0 ? 'light' : 'deep') as Stage,
      startMs,
      endMs: boundaries[i + 1]!,
    }))
    const html = renderToStaticMarkup(
      <Hypnogram segments={segments} startLabel="Bed 23:20" label="Sleep stages through the night of 2026-08-15" />,
    )
    expect(totalsRowText(html)).toBe('sleep.stage.deep 0h 08m, sleep.stage.light 0h 08m')
  })
})
