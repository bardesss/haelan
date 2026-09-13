// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Activity, BAR_METRICS } from '../src/pages/Activity.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { Insight } from '../src/data/useInsight.js'
import { flush } from './flush.js'
import { seriesPoint, PROVIDER_METRICS, insightBody } from './metricCoverage.js'

// Sparkline and ActivityHeatmap draw for real here, and echarts.init's effect throws "missing
// chart token" without this, the same reason every other page test file needs it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/activity')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

/**
 * Answers every route Activity calls. /series behaves the way the real store does for the two
 * provider-only metrics rather than handing back the same canned point regardless of source:
 * packages/core/test/person-query.test.ts's own "returns only merged rows when merged is named"
 * pins that an explicit `source` filters to rows carrying that exact value, and floors and
 * total_calories are written only as `provider` rows (0 of 211 and 0 of 731 merged in the live
 * database Task 1's brief measured), so a call that names any explicit source gets nothing back
 * for either. A stub that answered them the same regardless of source could not tell "this page
 * omits the parameter" apart from "the parameter happens not to matter here", which is the whole
 * point of the first test below.
 */
function stubActivity(urls: string[], insightOverrides: Partial<Insight> = {}): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const metrics = params.getAll('metric')
      const explicitSource = params.get('source')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        const isProvider = PROVIDER_METRICS.has(metric)
        body[metric] = {
          points: isProvider && explicitSource !== null ? []
            : [seriesPoint(metric, '2026-08-15', 60, isProvider ? { source: 'provider' } : {})],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/insights')) return json(insightBody(url, insightOverrides))
    // One real exercise session, not the catch-all's {}: SessionList reads /sessions too now
    // (Task 5), and an unanswered {} reads as items: undefined, an empty period, and the section
    // draws its own EmptyState -- exactly the class of failure this file's "draws provider rows
    // rather than calling them unworn" test exists to catch, just from a different card.
    if (url.includes('/sessions')) {
      return json({
        items: [{
          id: 's1', sourceId: 'watch', startMs: Date.UTC(2026, 7, 15, 8, 0), endMs: Date.UTC(2026, 7, 15, 8, 30),
          startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-15',
          attrs: { exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 250 } },
        }],
        cursor: null,
      })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * The same routes, but with the steps series dictated point by point and every other metric empty.
 * The heatmap card's basis is the one claim on this page whose numerator, denominator and wear
 * clause are three different counts, and stubActivity's uniform "one worn point per metric" cannot
 * tell them apart: reported and worn are both 1 under it, so a card that swapped one for the other
 * reads identically. Rows go through metricCoverage.ts's seriesPoint, so they carry every field
 * a real /series row does.
 */
function stubSteps(points: readonly { localDate: string, value: number, coverage: number | null }[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      return json(Object.fromEntries(metrics.map((metric) => [metric, {
        points: metric === 'steps'
          ? points.map((p) => seriesPoint(metric, p.localDate, p.value, { coverage: p.coverage }))
          : [],
        reduction: null,
      }])))
    }
    if (url.includes('/insights')) return json(insightBody(url))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same routes as stubActivity, but every metric named in `overrides` answers that value instead
 * of the uniform 60, and every other metric still gets 60 (steps' own coverage/source shape,
 * since none of the tests below read the heatmap). Used by the precision/grouping tests below,
 * which need distance and floors to carry values a shared "60 everywhere" stub cannot tell apart:
 * a millimeter total that does not divide evenly into kilometers, and a four figure floors total
 * (thousands grouping).
 */
function stubActivityValues(overrides: Record<string, number>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', overrides[metric] ?? 60)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/insights')) return json(insightBody(url))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * The finding this stub exists for: the workout count tile and the session list beneath it read
 * two different things, a derived daily total with an exclusion already applied and a raw session
 * list this reader marks rather than drops, and only a fixture where the two actually disagree
 * proves they still agree on purpose (R1's own rule: two workouts counted above three listed, one
 * of them struck through). Three sessions, one excluded; workout_count answers 2, the same total
 * deriveExerciseDay would have written with the excluded session already subtracted.
 */
function stubActivityExcludedWorkout(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        const value = metric === 'workout_count' ? 2 : 60
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', value)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/insights')) return json(insightBody(url))
    if (url.includes('/sessions')) {
      return json({
        items: [
          {
            id: 's1', sourceId: 'watch', startMs: Date.UTC(2026, 7, 3, 8, 0), endMs: Date.UTC(2026, 7, 3, 8, 30),
            startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-03',
            attrs: { exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 250 } },
            excluded: false, excludeReason: null,
          },
          {
            id: 's2', sourceId: 'watch', startMs: Date.UTC(2026, 7, 5, 8, 0), endMs: Date.UTC(2026, 7, 5, 8, 30),
            startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-05',
            attrs: { exerciseType: 'CYCLING', metricsSummary: { caloriesKcal: 400 } },
            excluded: true, excludeReason: 'strap fell off',
          },
          {
            id: 's3', sourceId: 'watch', startMs: Date.UTC(2026, 7, 7, 8, 0), endMs: Date.UTC(2026, 7, 7, 8, 30),
            startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-07',
            attrs: { exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 300 } },
            excluded: false, excludeReason: null,
          },
        ],
        cursor: null,
      })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Activity page', () => {
  // The two provider only metrics are the reason Task 1 of this milestone exists. If the request
  // carried a source parameter at all, both would come back empty here (see stubActivity's own
  // comment on why), which is the defect that milestone closed: usePageControls and resolveSource
  // default to the all sources sentinel, and sourceParam omits the parameter for it.
  it('asks for floors and total_calories with no source parameter', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    expect(series.join()).toContain('metric=floors')
    expect(series.join()).toContain('metric=total_calories')
    for (const url of series) expect(url).not.toContain('source=')
    restore()
  })

  // Drawn, not merely absent from the not-worn branch: the failure this page exists to avoid is
  // an empty state (of any kind) standing in for real data, and "not_worn does not appear" alone
  // would not catch a regression that swapped it for no_data instead. floors' coverage is neither
  // once-a-day (1/24) nor null: it is a daily-tier provider rollup, and coverageIsMeaningful only
  // ever says true for a continuously sampled (intraday) metric, so its wear branch can never fire
  // regardless of the coverage number a stub hands it; drawing the real value is the assertion
  // that actually exercises the card.
  it('draws provider rows rather than calling them unworn', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).not.toContain('Device not worn')
    expect(container!.textContent).toContain('Floors climbed')
    expect(container!.textContent).toContain('Total calories')
    expect(container!.querySelector('.empty')).toBeNull()
    restore()
  })

  // Not "one request per card": /series takes one agg and one range for a whole call, so cards
  // sharing both ride together. Two aggs on this page (sum and count, workout_count being the one
  // metric whose only aggregate is count) over the page's range, plus the training load card,
  // whose 28 day window is fixed by ACWR's own definition and so cannot ride with a range the
  // reader picks. Batching is still what this asserts: no two requests may share an agg AND a
  // range, which is the property that breaks the moment a card starts fetching for itself.
  it('batches by agg and range, so no two requests ask the same question', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) => u.includes('/series'))
    const questions = new Set(series.map((u) => {
      const params = new URLSearchParams(u.split('?')[1] ?? '')
      return `${params.get('agg')}|${params.get('from')}|${params.get('to')}`
    }))
    expect(series).toHaveLength(questions.size)
    restore()
  })

  // The heatmap's own dense denominator, carried over from dashboard-cards.test.tsx's equivalent
  // check when the card moved here: /series omits a day with no row entirely, so points.length is
  // "days that reported", and a month missing most of its days must not read "1 of 1 days".
  it('states the heatmap total against every calendar day in range, not just the days that reported', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const match = container!.textContent!.match(/calendar heatmap, (\d+) of (\d+) days/)
    expect(match).not.toBeNull()
    expect(Number(match![2])).toBeGreaterThan(1)
    restore()
  })

  // The numerator, which the denominator test above never looks at. It read "days worn" against a
  // dense calendar denominator, so a month with one reporting day claimed thirty days not worn
  // while ActivityHeatmap's own accessible table called those same days "no reading" on the stated
  // grounds that an absent row names no cause. One card, two contradictory claims about the same
  // thirty days. The numerator is now what the chart itself can defend, the days that reported,
  // with the wear count in its own clause over those days alone.
  it('counts the days that reported, and keeps not worn to a clause about them', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    // Two steps days out of a thirty one day August, and deliberately only one of them worn: with
    // a stub where every reporting day is also a worn day, the reported and worn numerators are
    // the same number and the old wording would pass this unchanged. NOT_WORN_MAX_COVERAGE is an
    // hour and the comparison is strict, so 1/24 is the not worn day.
    const restore = stubSteps([
      { localDate: '2026-08-15', value: 4000, coverage: 0.9 },
      { localDate: '2026-08-16', value: 30, coverage: 1 / 24 },
    ])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('calendar heatmap, 2 of 31 days, 1 day not worn')
    // The worn numerator specifically, which for this stub is 1 against the same denominator.
    // "1 of 31 days worn" was the earlier form of this assertion and could not fail, since the
    // trailing "worn" left neither catalogue; this names a string the defect really would produce.
    expect(text).not.toContain('calendar heatmap, 1 of 31 days')
    restore()
  })

  // A period with no steps at all is neither pending nor errored, so the basis rendered anyway:
  // "0 of 31 days worn, 0 to 0 steps", a specific false claim about the person's month plus a
  // colour domain read off no readings whatever. The chart still draws its thirty one absence
  // dots, so the card is not empty; only the counting clause has nothing to stand on.
  it('states no readings rather than a count and a colour domain for an empty period', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    const restore = stubSteps([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('calendar heatmap, no readings in these 31 days')
    expect(text).not.toContain('0 to 0 steps')
    expect(text).not.toMatch(/calendar heatmap, 0 of/)
    restore()
  })

  // Carried over from pages.test.tsx's own "states the heatmap colour domain" assertion, which
  // the previous round deleted without replacing: that assertion pinned two claims the denominator
  // test above does not touch at all, the maxSteps interpolation and the static "stronger colour"
  // copy, and a broken interpolation or a dropped clause would have passed every other test in
  // this file. stubActivity answers every metric with a single point at value 60, so 60 is both
  // the sum and the maximum steps reads for the one day it reports.
  it('states the heatmap colour domain from the steps it actually drew', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('0 to 60 steps')
    expect(container!.textContent).toContain('stronger colour is more steps')
    restore()
  })

  // Finding #9 of the precision audit: distance is stored in millimeters (METRICS.distance,
  // precision 0) and this card displays kilometers with one decimal, a precision the catalogue's
  // own field cannot answer because it names a different unit than the one on screen. The card
  // used to hardcode `(total / 1_000_000).toFixed(1)`; it now goes through formatNumber directly
  // with an explicit precision of 1, never through formatMetricValue (which would read millimeters'
  // own precision 0 and drop the decimal). 5,234,567 mm is chosen so millimeters-to-kilometers does
  // not divide evenly, which a broken conversion or a wrong precision would show up in immediately.
  //
  // toBe, not toContain: a prefix match here would stay green if precision drifted the other way
  // too (a forced precision+2 renders "5.235 km", and "5.2" is still a substring of "5.235").
  // Confirmed by reverting the distance card back to `formatMetricValue(total, 'distance', ...)`
  // (the accidental path this design exists to close, which never divides by a million at all):
  // that failed with "Received: 5,234,567 km" where it expects "5.2 km".
  it('converts distance from stored millimeters to displayed kilometers at its own precision', async () => {
    const restore = stubActivityValues({ distance: 5_234_567 })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Distance')
    expect(card?.querySelector('.value')?.textContent).toBe('5.2 km')
    restore()
  })

  // M3e review's own finding: the headline above converts millimeters to kilometers, but the
  // Sparkline beside it used to be hand formatMetricValue('distance', ...) by default, which reads
  // METRICS.distance's own stored-unit precision (0, millimeters) and printed the raw per-day
  // reading ("5,234,567") in its accessible table, under a column header (activity.units.distance)
  // that reads "Distance in kilometers". A sighted reader saw the correct "5.2 km" headline while a
  // screen reader landing on the sparkline's own table got a number six figures longer, under a
  // header naming a unit that number was never in. The card now draws a DailyBars rather than a
  // Sparkline (this milestone's own promotion), whose table is built the same way off the same
  // dense series, so the defect and the fix both still apply. range/on pinned to the stub's own
  // date so that dense series actually carries a row for it, rather than depending on whatever
  // "this month" resolves to on the machine running the test.
  it('shows the distance bar chart\'s table in kilometers too, not the raw stored millimeters', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    const restore = stubActivityValues({ distance: 5_234_567 })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Distance')
    const rowMatch = card?.innerHTML.match(/<tr><th scope="row">2026-08-15<\/th>[\s\S]*?<\/tr>/)
    expect(rowMatch, card?.innerHTML ?? 'no Distance card found').toBeTruthy()
    expect(rowMatch![0]).toContain('<td>5.2</td>')
    expect(rowMatch![0]).not.toContain('5234567')
    expect(rowMatch![0]).not.toContain('5,234,567')
    restore()
  })

  // The refactor this task is for on the other nine cards: Activity's own local groupNumber (a
  // byte-identical copy of Dashboard.tsx's) is gone, replaced by formatMetricValue reading
  // METRICS[metric].precision through card()'s own default formatter. A four figure floors total
  // is what tells the old ungrouped code and the new grouped code apart.
  //
  // toBe, not toContain: "12,345" is a substring of "12,345.00" too, which a dropped
  // minimumFractionDigits/maximumFractionDigits pin would still render. Confirmed by reverting
  // card()'s default formatter to `String(total)`: that failed with "Received: 12345" where it
  // expects "12,345 floors".
  it('groups a four figure floors total per language, through the shared formatter', async () => {
    const restore = stubActivityValues({ floors: 12345 })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Floors climbed')
    expect(card?.querySelector('.value')?.textContent).toBe('12,345 floors')
    restore()
  })

  // 290 rows spanning 2026-05-08 to 2026-09-02 in the live database, and no page drew a single one
  // of them before this task. active_energy rides the same sum request steps and total_calories
  // already make, so the only new thing to prove is that a card exists and reads its own metric.
  it('shows active energy, which no page claimed before', async () => {
    const restore = stubActivityValues({ active_energy: 512 })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Active energy')
    expect(card?.querySelector('.value')?.textContent).toBe('512 kcal')
    restore()
  })

  // The other half of pages.test.tsx's own language parity check that the heatmap's move left
  // uncovered: ActivityHeatmap is the only chart anywhere in this app that renders a weekday
  // column, so with it gone from Dashboard, translating that column into Dutch was exercised
  // nowhere at all once the heatmap-specific pages.test.tsx assertion was removed.
  it('translates the heatmap weekday column into Dutch', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.innerHTML).toContain('Weekdag')
    expect(container!.innerHTML).not.toContain('>Weekday<')
    restore()
  })

  // Task 4's own insight card. No formatValue on this one, unlike its siblings on Sleep, Recovery,
  // Health and Weight: this page prints no steps total anywhere on a tile carrying a unit (the
  // daily steps card is a heatmap in a hand rolled Card, not a StatTile), so there is no unit or
  // duration gap for a formatter to close the way there is on the other four pages. The assertion
  // below still expects "8,342", grouped by locale: that is InsightCard's own default
  // (formatMetricValue with no formatValue override) behaving the same as every other numeric
  // card on this page, and grouping is not what this test pins. What it pins is the one thing that
  // differs from the other four insight cards: no unit suffix appended.
  it('states the steps insight as a plain number, with no unit suffix', async () => {
    window.history.replaceState(null, '', '/activity?range=month&on=2026-08-15')
    const restore = stubActivity([], { current: 8342, previous: 7910, delta: 432 })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Steps, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '8,342 on average (Aug 1, 2026 to Aug 31, 2026) against 7,910 on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 432.',
    )
    restore()
  })

  // Vary the fixture rather than reusing the same complete body every test in this file: a
  // suppressed response (current/previous/delta all null) is a null field this card has to fall
  // back on rather than reach formatMetricValue with, which a fixture carrying only complete
  // bodies could never catch.
  it('falls back to the insufficient message when the server suppresses the steps insight', async () => {
    const restore = stubActivity([], { suppressed: true, reason: 'thin-days', current: null, previous: null, delta: null })
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Steps, this period against the last')
    expect(card?.textContent).toContain('too few days')
    expect(card?.querySelector('.insight-summary')).toBeNull()
    restore()
  })

  // The one wiring claim this file's own tests do not otherwise pin: /insights takes one metric
  // and one agg per call, distinct from the two /series requests (sum, count) this page already
  // issues, so the steps insight is a third request rather than a card riding along on the sum
  // group's own response.
  // Finding 2 of the second pass review: session-list-excluded.test.tsx mounts SessionList alone,
  // so nothing rendered the whole Activity page with an excluded session and read the workout
  // count tile beside it. The disagreement is the feature, not a bug the two queries happen to
  // share: this is the one test where they sit on the page together and are asserted together.
  it('shows the excluded session struck through in the list, beside a count that already excludes it', async () => {
    const restore = stubActivityExcludedWorkout()
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Workouts')
    expect(card?.querySelector('.value')?.textContent).toBe('2 workouts')
    // Newest first (SessionList's own order): s3 (Aug 7), s2 (Aug 5, excluded), s1 (Aug 3).
    const rows = [...container!.querySelectorAll('.session-row')].map((r) => r.className)
    expect(rows).toEqual(['session-row', 'session-row session-row-excluded', 'session-row'])
    const reasons = [...container!.querySelectorAll('.session-row-excluded-reason')].map((r) => r.textContent)
    expect(reasons).toEqual(['Excluded: strap fell off'])
    restore()
  })

  it('asks for the steps insight at agg sum, separately from the sum series request', async () => {
    const urls: string[] = []
    const restore = stubActivity(urls)
    const { client, tree } = withQuery(<Activity />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const insightCalls = urls.filter((u) => u.includes('/insights'))
    expect(insightCalls).toHaveLength(1)
    const params = new URL(insightCalls[0]!, 'http://x').searchParams
    expect(params.get('metric')).toBe('steps')
    expect(params.get('agg')).toBe('sum')
    restore()
  })

  // The named list the design calls for, asserted against the page's own export rather than a copy
  // of it: a test carrying its own list would keep passing after someone edited the page's.
  it('draws a bar chart for exactly the promoted metrics', () => {
    expect([...BAR_METRICS]).toEqual(['distance', 'floors'])
  })

  // The whole-branch review's own finding: the test above checks the CONTENTS of an exported
  // constant, not that Activity.tsx:276's ternary actually reads it to choose what to draw.
  // Deleting that ternary (or reverting both cards' span back to 4) left the rest of this suite
  // green. This test mounts the real page and reads something only DailyBars produces, so it
  // cannot pass the same way: `useChart`'s own inline host height (130 for DailyBars, 34 for
  // Sparkline -- useChart.ts's returned `style`) and the `span 6` on the two promoted cards'
  // `.card` element (Card.tsx), against a card that stayed a Sparkline at span 4.
  //
  // Confirmed by removing the ternary at Activity.tsx:276 (`BAR_METRICS.has(metric) ? <DailyBars
  // .../> : <Sparkline .../>` collapsed to always `<Sparkline .../>`) and watching this test fail:
  // "expected '34px' to be '130px'" on the Distance assertion, restored afterwards.
  it('draws a DailyBars host, not a Sparkline one, on the promoted distance and floors cards', async () => {
    const restore = stubActivity([])
    const { client, tree } = withQuery(<Activity />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const cardFor = (label: string): HTMLElement => {
      const card = [...container!.querySelectorAll('.card')]
        .find((c) => c.querySelector('.label')?.textContent === label)
      if (!card) throw new Error(`no card for ${label}`)
      return card as HTMLElement
    }
    const hostHeightOf = (card: HTMLElement): string =>
      (card.querySelector('[role="img"]') as HTMLElement | null)?.style.height ?? ''

    const distanceCard = cardFor('Distance')
    const floorsCard = cardFor('Floors climbed')
    const activeEnergyCard = cardFor('Active energy')

    expect(hostHeightOf(distanceCard)).toBe('130px')
    expect(hostHeightOf(floorsCard)).toBe('130px')
    // The control: a card BAR_METRICS does not name, still drawing the 34px Sparkline it always
    // has, so this test would fail the same way if DailyBars' host were simply always 130px tall.
    expect(hostHeightOf(activeEnergyCard)).toBe('34px')

    expect(distanceCard.style.gridColumn).toBe('span 6')
    expect(floorsCard.style.gridColumn).toBe('span 6')
    expect(activeEnergyCard.style.gridColumn).toBe('span 4')
    restore()
  })
})
