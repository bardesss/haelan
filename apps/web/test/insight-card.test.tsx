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
    // Dates render through formatLocalDate (format.ts), the reader's own locale's medium form,
    // not the raw '2026-08-03' the brief's own draft of this test checked for: a review of this
    // task (task-2-report.md) found the raw ISO string reaching the page, with no precedent for it
    // anywhere else in the app, and pointed at OverrideList.tsx's own date column as the one that
    // already formats. 'Aug 3, 2026' is what 'en' prints for previousRange.from below.
    expect(html).toContain('Aug 3, 2026')
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

  // Insight types current, previous, delta and both ranges independently nullable, and nothing
  // in this component's own contract rules out a caller handing it suppressed: false beside a
  // null value. Without a guard the sentence renders with a gap where the missing piece should
  // be; this pins the safer fallback instead.
  it('falls back to the insufficient message rather than a sentence with holes in it', () => {
    const html = render({ ...base, suppressed: false, reason: null, current: null })
    expect(html).toContain('Not enough data to summarise')
    expect(html).not.toContain('insight-summary')
  })

  // 'tot' alone is the exclusive Dutch preposition; these windows are inclusive
  // ("An inclusive range of local dates.", DateRange's own doc comment, packages/core/src/query/
  // insights.ts:24), so the Dutch sentence has to read 'tot en met'.
  it('states the Dutch window as inclusive rather than with a bare, exclusive tot', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="nl"><InsightCard {...props} insight={base} /></I18nProvider>,
    )
    expect(html).toContain('tot en met')
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
    // Anchored on the text right after the number, not a bare toContain('70.0'): a precision
    // slip to 70.00 still contains "70.0" as a substring but not "70.0 on average (".
    expect(html).toContain('70.0 on average (')
    expect(html).not.toContain('70,000')
  })
})
