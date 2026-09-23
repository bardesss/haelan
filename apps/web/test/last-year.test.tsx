import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { yearEarlier, yearEarlierRange, alignYearEarlier } from '../src/data/lastYear.js'
import { dayTableRows } from '../src/charts/base.js'
import { dayTooltip } from '../src/charts/dayTooltip.js'
import { deepLink } from '../src/controls/deepLink.js'
import { StatTile } from '../src/components/StatTile.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { SeriesPoint } from '../src/data/useSeries.js'
import type { Translate } from '../src/format.js'

const point = (localDate: string, value: number): SeriesPoint =>
  ({ localDate, value, coverage: 1, source: 'merged', sourceMix: null, updatedAtMs: 0, filled: false })

describe('yearEarlier', () => {
  it('names the same calendar date a year before', () => {
    expect(yearEarlier('2026-08-15')).toBe('2025-08-15')
    expect(yearEarlier('2026-01-01')).toBe('2025-01-01')
  })

  // A leap day has no partner. Borrowing the 28th would put a real reading on a day it was not taken.
  it('has no partner for a leap day', () => {
    expect(yearEarlier('2028-02-29')).toBeNull()
  })
})

describe('yearEarlierRange', () => {
  it('shifts both ends and keeps the source', () => {
    expect(yearEarlierRange({ from: '2026-08-01', to: '2026-08-31', source: 'watch' }))
      .toEqual({ from: '2025-08-01', to: '2025-08-31', source: 'watch' })
  })

  it('ends a range on the 28th when this year\'s end is a leap day', () => {
    expect(yearEarlierRange({ from: '2028-02-01', to: '2028-02-29', source: 'all' }).to).toBe('2027-02-28')
  })
})

describe('alignYearEarlier', () => {
  it('reads each label\'s own date a year earlier, by date and never by position', () => {
    const labels = ['2026-08-01', '2026-08-02', '2026-08-03']
    // Last year's points arrive sparse and out of step with this year's: the 2nd is missing.
    const earlier = [point('2025-08-03', 30), point('2025-08-01', 10)]
    expect(alignYearEarlier(labels, earlier)).toEqual([10, null, 30])
  })

  it('leaves a leap day as a gap even when the 28th has a reading', () => {
    const labels = ['2028-02-28', '2028-02-29', '2028-03-01']
    const earlier = [point('2027-02-28', 5), point('2027-03-01', 7)]
    expect(alignYearEarlier(labels, earlier)).toEqual([5, null, 7])
  })
})

describe('the chart\'s channels for last year', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    key === 'charts.tooltip.line' ? `${String(options?.label)}: ${String(options?.value)}` : key) as unknown as Translate
  const format = (value: number | null, absent: string) => (value === null ? absent : String(value))

  it('adds a last-year cell to each table row, before the note', () => {
    const rows = dayTableRows({
      values: [100, null], labels: ['2026-08-01', '2026-08-02'], excluded: [], annotations: [],
      format, t, lastYear: [90, 80],
    })
    expect(rows).toEqual([['2026-08-01', '100', '90', ''], ['2026-08-02', 'charts.absence.noReading', '80', '']])
  })

  it('leaves the table as it was without a comparison', () => {
    const rows = dayTableRows({ values: [100], labels: ['2026-08-01'], excluded: [], annotations: [], format, t })
    expect(rows).toEqual([['2026-08-01', '100', '']])
  })

  // An exclusion is something the reader did to this year's day; it says nothing about last year's.
  it('says a year earlier in the tooltip, as no reading rather than excluded', () => {
    const base = {
      values: [null], labels: ['2026-08-01'], excluded: ['2026-08-01'], annotations: [],
      marks: { atValue: [], atDate: [] }, trend: undefined, hasTrend: false, episodic: false, unit: 'Steps', format, t,
    }
    expect(dayTooltip({ ...base, lastYear: [null] }, { componentType: 'series', dataIndex: 0 }))
      .toBe('2026-08-01<br/>Steps: charts.absence.excluded<br/>charts.columns.lastYear: charts.absence.noReading')
    expect(dayTooltip(base, { componentType: 'series', dataIndex: 0 })).not.toContain('lastYear')
  })
})

describe('deepLink', () => {
  it('carries the comparison into the page a card opens', () => {
    expect(deepLink('/sleep', { tab: 'month', anchor: '2026-08-15', source: 'all', compareYear: true }))
      .toBe('/sleep?range=month&on=2026-08-15&compare=year')
    expect(deepLink('/sleep', { tab: 'month', anchor: '2026-08-15', source: 'all' }))
      .toBe('/sleep?range=month&on=2026-08-15')
  })
})

describe('the tile\'s "Last year" line', () => {
  const tile = (lastYear?: string | null) => renderToStaticMarkup(
    <I18nProvider lng="en"><StatTile label="Steps" value="56,814" lastYear={lastYear} /></I18nProvider>,
  )

  it('states last year\'s figure under the headline', () => {
    expect(tile('52,110')).toContain('<p class="last-year">Last year: 52,110</p>')
  })

  it('says so when a year earlier holds nothing', () => {
    expect(tile(null)).toContain('<p class="last-year">Nothing recorded a year earlier</p>')
  })

  it('draws nothing while the comparison is off or still loading', () => {
    expect(tile(undefined)).not.toContain('last-year')
  })

  it('carries the unit the headline carries', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><StatTile label="Resting heart rate" value="58" unit="bpm" lastYear="61" /></I18nProvider>,
    )
    expect(html).toContain('Last year: 61 bpm')
  })
})
