import { describe, it, expect } from 'vitest'
import { dayTooltip } from '../src/charts/dayTooltip.js'
import type { DayTooltipInput } from '../src/charts/dayTooltip.js'
import { dayMarks } from '../src/charts/base.js'
import { formatMetricValue } from '../src/format.js'
import type { Translate } from '../src/format.js'

// A hand rolled stand-in for i18next's own t(), the same device hr-tooltip.test.ts uses: MESSAGES
// mirrors the real keys this module reads, interpolated the same {{token}} way i18next does, so
// this file asserts what dayTooltip actually asked t() for rather than pinning translated
// copy a locale file is free to reword.
const MESSAGES: Record<string, string> = {
  'charts.absence.noReading': 'no reading',
  'charts.absence.excluded': 'excluded',
  'charts.columns.trend': 'Trend',
  'charts.tooltip.line': '{{label}}: {{value}}',
}
const t: Translate = (key, options) => {
  let text = MESSAGES[key] ?? key
  if (options) for (const [k, v] of Object.entries(options)) text = text.replaceAll(`{{${k}}}`, String(v))
  return text
}

const labels = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']
const values = [9000, null, 8600, null, null]
const excluded = ['2026-08-13']
const annotations = [{ date: '2026-08-11', text: 'travelling' }, { date: '2026-08-11', text: 'ill' }]

// The same marks the chart itself draws from, built by the same function, so a dataIndex in this
// test counts into exactly what it counts into in the app.
const marks = dayMarks({ dates: labels, values, excluded, annotations, excludedText: 'excluded' })

function input(overrides: Partial<DayTooltipInput> = {}): DayTooltipInput {
  return {
    values, labels, excluded, annotations, marks,
    trend: undefined,
    hasTrend: false,
    episodic: false,
    unit: 'Steps',
    format: (value, absent) => formatMetricValue(value, 'steps', 'en', absent),
    t,
    ...overrides,
  }
}

describe('the sparkline tooltip', () => {
  it('names the day and the value, labelled by the same header the table column carries', () => {
    expect(dayTooltip(input(), { componentType: 'series', dataIndex: 0 }))
      .toBe('2026-08-10<br/>Steps: 9,000')
  })

  it('says no reading for a silent day rather than printing the literal null', () => {
    const text = dayTooltip(input(), { componentType: 'series', dataIndex: 1 })
    expect(text).toBe('2026-08-11<br/>Steps: no reading')
    expect(text).not.toContain('null')
  })

  // The day the reader threw out gets the word for what they did, not the word for a device that
  // never reported. The same distinction the accessible table draws one element away.
  it('says excluded, not no reading, for a day the reader excluded', () => {
    expect(dayTooltip(input(), { componentType: 'series', dataIndex: 3 }))
      .toBe('2026-08-13<br/>Steps: excluded')
  })

  // The mark trap: a markPoint/markLine dataIndex counts into marks.atValue/marks.atDate and never
  // into `values`. Indexing `values` on this number names whichever day sits at that small index -
  // here, index 0, a completely different day from the one being hovered.
  it('resolves a markLine through marks.atDate, not through the values array', () => {
    expect(dayTooltip(input(), { componentType: 'markLine', dataIndex: 0 }))
      .toBe('2026-08-11<br/>travelling, ill')
  })

  it('resolves a markPoint through marks.atValue and names the exclusion', () => {
    const stillPlotted = dayMarks({
      dates: labels, values: [9000, null, 8600, 7200], excluded: ['2026-08-13'],
      annotations: [], excludedText: 'excluded',
    })
    expect(dayTooltip(input({ marks: stillPlotted }), { componentType: 'markPoint', dataIndex: 0 }))
      .toBe('2026-08-13<br/>excluded')
  })

  // Weight is taken by hand, so a day nobody weighed in is not a gap in the data, and the table
  // drops that row rather than rowing it "no reading". A tooltip that announced an absence there
  // would contradict, on the canvas, the rule the table follows beside it.
  it('says nothing at all for a silent day under episodic', () => {
    expect(dayTooltip(input({ episodic: true }), { componentType: 'series', dataIndex: 4 }))
      .toBe('')
  })

  // ...but a day the reader acted on keeps its readout even under episodic, for the same reason it
  // keeps its table row: a canvas mark that keeps asserting something beside a tooltip gone quiet
  // denies the one day the reader actually touched.
  it('keeps the readout under episodic for a day that was excluded', () => {
    expect(dayTooltip(input({ episodic: true }), { componentType: 'series', dataIndex: 3 }))
      .toBe('2026-08-13<br/>Steps: excluded')
  })

  it('keeps the readout under episodic for a day that was annotated', () => {
    expect(dayTooltip(input({ episodic: true }), { componentType: 'series', dataIndex: 1 }))
      .toBe('2026-08-11<br/>Steps: no reading')
  })

  // The defect this project has already shipped once, in the table: Activity's distance plots raw
  // millimetres and hand-converts for display, so a tooltip reading the array through the default
  // formatter prints a seven digit millimetre count under a card headed in kilometres.
  it('uses the caller\'s own formatter, so a converted unit is not printed raw', () => {
    const km: DayTooltipInput = input({
      values: [5234567],
      labels: ['2026-08-10'],
      unit: 'Distance in kilometers',
      format: (value, absent) => value === null ? absent : `${(value / 1_000_000).toFixed(1)}`,
    })
    expect(dayTooltip(km, { componentType: 'series', dataIndex: 0 }))
      .toBe('2026-08-10<br/>Distance in kilometers: 5.2')
  })

  it('reports the trend on its own line, under the same name the table column carries', () => {
    const withTrend = input({ trend: [8800, null, 8700, null, null], hasTrend: true })
    expect(dayTooltip(withTrend, { componentType: 'series', dataIndex: 0 }))
      .toBe('2026-08-10<br/>Steps: 9,000<br/>Trend: 8,800')
  })

  it('renders nothing for an index that is not a day', () => {
    expect(dayTooltip(input(), { componentType: 'series', dataIndex: 99 })).toBe('')
    expect(dayTooltip(input(), { componentType: 'series', dataIndex: undefined })).toBe('')
  })

  // Every word came from t() and none survived as a literal: a t() answering in a different
  // vocabulary must change every word in the output. The same proof hr-tooltip.test.ts uses.
  it('routes every word through t(), not a hardcoded literal', () => {
    const shoutingT: Translate = (key, options) => t(key, options).toUpperCase()
    expect(dayTooltip(input({ t: shoutingT }), { componentType: 'series', dataIndex: 1 }))
      .toBe('2026-08-11<br/>STEPS: NO READING')
  })
})
