import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { InsightCard } from '../src/components/InsightCard.js'
import { I18nProvider } from '../src/i18n/index.js'
import { formatNumber } from '../src/format.js'
import type { Insight } from '../src/data/useInsight.js'

// I18nProvider lng="en" wraps every test that renders a formatted number, and none renders one
// without it: with no language pinned, toLocaleString(undefined) reads this machine's own OS
// locale, which on a Dutch machine prints 81.2 as 81,2 and silently passes an assertion looking
// for the English form.
const OK = { isError: false, isPending: false, refetch: () => {} }

const base: Insight = {
  current: 100, previous: 100, delta: 0,
  currentDays: 7, previousDays: 7, periodDays: 7,
  currentCoverage: 0.9, previousCoverage: 0.9,
  currentRange: { from: '2026-08-10', to: '2026-08-16' },
  previousRange: { from: '2026-08-03', to: '2026-08-09' },
  suppressed: false, reason: null,
}

const props = { query: OK, metric: 'steps', span: 6, label: 'Steps' }

const render = (insight: Insight) => renderToStaticMarkup(
  <I18nProvider lng="en"><InsightCard {...props} insight={insight} /></I18nProvider>,
)

describe('InsightCard', () => {
  it('names both values and both windows', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><InsightCard {...props} insight={{
        ...base, current: 455, previous: 473, delta: -18, suppressed: false, reason: null,
        currentRange: { from: '2026-08-10', to: '2026-08-16' },
        previousRange: { from: '2026-08-03', to: '2026-08-09' },
      }} /></I18nProvider>,
    )
    expect(html).toContain('455')
    expect(html).toContain('473')
    expect(html).toContain('2026-08-03')
  })

  it('says too few days when the server suppressed on thin-days', () => {
    const html = render({ ...base, suppressed: true, reason: 'thin-days' })
    expect(html).toContain('too few days')
    expect(html).not.toContain('against')
  })

  it('names the device when the server suppressed on thin-coverage', () => {
    const html = render({ ...base, suppressed: true, reason: 'thin-coverage' })
    expect(html).not.toContain('too few days')
  })

  // The two suppressed branches read the same emptyState-shaped component, so a text difference
  // is the only proof left that they are not the same message wearing two reason strings. Pinned
  // as its own assertion, not folded into the two tests above, so a future edit that makes them
  // collapse fails here even if it happens to keep dodging "too few days" some other way.
  it('gives thin-days and thin-coverage genuinely different copy', () => {
    const days = render({ ...base, suppressed: true, reason: 'thin-days' })
    const coverage = render({ ...base, suppressed: true, reason: 'thin-coverage' })
    expect(coverage).not.toBe(days)
    expect(coverage).toContain('device')
  })

  // Wrapped in I18nProvider like every other test here, not left bare the way MetricCard's own
  // suite reads raw keys: that trick relies on no I18nProvider ever having run in the process, and
  // this file's other tests each construct one of their own (initI18n registers the instance
  // react-i18next falls back to when no context is present), so a bare useTranslation() call later
  // in the same file resolves against whichever of those ran last rather than returning the key.
  it('renders the error state for a failed request, not the summary sentence', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><InsightCard {...props}
        query={{ isError: true, isPending: false, refetch: () => {} }} insight={undefined} /></I18nProvider>,
    )
    expect(html).toContain('This did not load.')
    expect(html).not.toContain('against')
  })

  it('claims nothing at all while the query is pending', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><InsightCard {...props}
        query={{ isError: false, isPending: true, refetch: () => {} }} insight={undefined} /></I18nProvider>,
    )
    expect(html).toContain('Loading')
    expect(html).not.toContain('against')
  })

  it('carries delta from the insight rather than recomputing it from current and previous', () => {
    // 455 minus 473 is -18, not the -20 given here: a real response never disagrees with its own
    // subtraction this much, but the fixture deliberately does, so that a component computing its
    // own delta from current and previous (instead of reading insight.delta) would print -18 and
    // fail this assertion instead of matching it.
    const html = render({ ...base, current: 455, previous: 473, delta: -20 })
    expect(html).toContain('-20')
  })

  it('converts weight through its own formatValue rather than the catalogue precision', () => {
    // METRICS.weight declares precision 1 in grams. formatMetricValue would print the raw gram
    // figures ("70,000.0"); the page's own converter divides to kilograms and rounds to its own
    // precision before this card ever sees the result, so only that string should appear.
    const toKg = (value: number | null, absent: string) =>
      formatNumber(value === null ? null : value / 1000, 1, 'en', absent)
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><InsightCard query={OK} metric="weight" span={6} formatValue={toKg} insight={{
        ...base, current: 70000, previous: 71200, delta: -1200,
      }} /></I18nProvider>,
    )
    // Anchored on the character right after the number, not a bare toContain('70.0'): a precision
    // slip to 70.00 still contains "70.0" as a substring but not "70.0 over".
    expect(html).toContain('70.0 over')
    expect(html).not.toContain('70,000')
  })
})
