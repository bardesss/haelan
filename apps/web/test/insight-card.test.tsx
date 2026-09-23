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

  // The figures a reader sees, as opposed to the sentence a screen reader hears. Asserted cell by
  // cell rather than as substrings of the whole card, which would pass on the sentence alone.
  describe('the drawn comparison', () => {
    const drawn = (insight: Insight, extra: Partial<Parameters<typeof InsightCard>[0]> = {}) => {
      const html = renderToStaticMarkup(
        <I18nProvider lng="en"><InsightCard {...props} {...extra} insight={insight} /></I18nProvider>,
      )
      const cells = (cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, 'g'))].map((m) => m[1])
      const badge = html.match(/<span class="delta insight-delta" data-dir="(\w+)" data-tone="(\w+)">([^<]*)<\/span>/)
      return { html, values: cells('insight-value'), labels: cells('insight-period-label'), ranges: cells('insight-range'), badge }
    }

    it('draws this period and the previous one as two figures with their windows', () => {
      const { values, labels, ranges } = drawn({ ...base, current: 8668, previous: 8522, delta: 146 })
      expect(labels).toEqual(['This period', 'Previous period'])
      expect(values).toEqual(['8,668', '8,522'])
      // One range each, with the month and year said once: the locale's own range shortening
      // (Intl formatRange), whose exact spacing ICU decides, so the parts are asserted rather than
      // the separator's code point.
      expect(ranges).toHaveLength(2)
      expect(ranges[0]).toMatch(/^Aug 10\s*[–-]\s*16, 2026$/)
      expect(ranges[1]).toMatch(/^Aug 3\s*[–-]\s*9, 2026$/)
    })

    it('signs a rise with a plus and a fall with a real minus sign', () => {
      expect(drawn({ ...base, current: 110, previous: 100, delta: 10 }).badge![3]).toBe('+10')
      expect(drawn({ ...base, current: 90, previous: 100, delta: -10 }).badge![3]).toBe('−10')
    })

    it('colours the badge by the polarity the caller passes, and not at all without one', () => {
      const fall = { ...base, current: 54, previous: 57, delta: -3 }
      expect(drawn(fall, { metric: 'resting_heart_rate', polarity: 'lower-is-better' }).badge!.slice(1, 3)).toEqual(['down', 'good'])
      expect(drawn(fall, { metric: 'resting_heart_rate' }).badge!.slice(1, 3)).toEqual(['down', 'neutral'])
    })

    it('draws both bars on one scale, the larger filling its track', () => {
      const { html } = drawn({ ...base, current: 50, previous: 100, delta: -50 })
      const widths = [...html.matchAll(/<span class="insight-bar[^"]*"><span style="width:([\d.]+)%"><\/span><\/span>/g)].map((m) => Number(m[1]))
      expect(widths).toEqual([50, 100])
    })

    it('hides the drawn figures from a screen reader, which hears the sentence instead', () => {
      const { html } = drawn({ ...base, current: 110, previous: 100, delta: 10 })
      expect(html).toContain('<div class="insight-compare" aria-hidden="true">')
      expect(html).toContain('<p class="insight-summary sr-only">110 on average')
    })
  })

  // thin-days says wait, which is not news, and on a Day tab all three of these land in it at
  // once. render() returns markup, so an absent card is the empty string.
  it('renders nothing when the server suppressed on thin-days', () => {
    expect(render({ ...base, suppressed: true, reason: 'thin-days' })).toBe('')
  })

  it('names the device when the server suppressed on thin-coverage', () => {
    const html = render({ ...base, suppressed: true, reason: 'thin-coverage' })
    expect(html).toContain('Not enough device coverage to summarise')
    expect(html).not.toContain('too few days')
  })

  // The pair this file used to pin as two different messages is now a message and an absence.
  // Kept as its own test for the same reason the old one was: the two reasons must not collapse
  // into one behaviour, and the proof has to be an assertion about both, not about either alone.
  it('keeps the thin-coverage card while thin-days disappears', () => {
    const days = render({ ...base, suppressed: true, reason: 'thin-days' })
    const coverage = render({ ...base, suppressed: true, reason: 'thin-coverage' })
    expect(days).toBe('')
    expect(coverage).toContain('device')
    expect(coverage).toContain('class="card"')
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
  // A malformed or version-skewed payload: apiGet casts any JSON straight to Insight with no
  // runtime check, and `{}` reads every field as undefined. The guard exists to stop that
  // reaching formatMetricValue and taking the whole page down; a card that quietly does not
  // appear serves that as well as a fallback message did, and says nothing untrue.
  it('renders nothing rather than a sentence with holes in it', () => {
    expect(render({ ...base, suppressed: false, reason: null, current: null })).toBe('')
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

  // The whole-branch review's own blocker: `insight.delta` is derived by the route at the
  // metric's STORED precision (grams, series.ts's own comment), and dividing that into a
  // different display unit afterwards can disagree with the two already-converted, already-
  // rounded figures beside it. 70345.6 g and 71169.0 g convert to 70.3 kg and 71.2 kg, a
  // difference of -0.9, while the stored delta (-823.4 g) divides naively into -0.8 kg.
  // `formatDelta` recomputes the delta from the converted, rounded ends instead of trusting
  // `insight.delta`, the same technique the route itself uses, run again at the display
  // precision.
  it('recomputes delta through formatDelta rather than dividing the stored delta into the display unit', () => {
    const toKg = (value: number | null, absent: string) =>
      formatNumber(value === null ? null : value / 1000, 1, 'en', absent)
    const roundToKg = (grams: number): number => Number((grams / 1000).toFixed(1))
    const formatDeltaInKg = (current: number, previous: number): string =>
      `${formatNumber(Number((roundToKg(current) - roundToKg(previous)).toFixed(1)), 1, 'en', '')} kg`
    const html = renderToStaticMarkup(
      <I18nProvider lng="en"><InsightCard query={OK} metric="weight" span={6}
        formatValue={toKg} formatDelta={formatDeltaInKg} insight={{
          ...base, current: 70345.6, previous: 71169.0, delta: -823.4,
        }} /></I18nProvider>,
    )
    expect(html).toContain('-0.9 kg')
    expect(html).not.toContain('-0.8 kg')
  })
})
