// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Recovery } from '../src/pages/Recovery.js'
import { contributionRows } from '../src/pages/recovery/RecoveryIndexCard.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { Insight } from '../src/data/useInsight.js'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Sparkline draws for real here, and echarts.init's effect throws "missing chart token" without
// this, the same reason dashboard-cards.test.tsx and chart-lifecycle.test.tsx need it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/recovery')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  // A safety net rather than the primary reset: the clock test below restores real timers itself,
  // but an assertion failure there would otherwise leak a mocked clock into whatever test runs next.
  vi.useRealTimers()
})

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// The control row's own rebuild field, carrying no news: ControlRow now trusts SyncStatus.rebuild
// to exist whenever status.data does (see its own comment), so a fixture whose /api/sync/status
// answer omits it is not a smaller, harmless stub -- it is a shape the real route never sends.
const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

type BaselineStub = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route Recovery calls: the session (seeded above, but a real render still asks it
 * once), /series for whichever metrics land in the one 'last' request, /api/sync/status (the
 * control row's own query, answered generically by the fallback below), /baselines with whichever
 * baseline `baseline` names, and /insights with metricCoverage.ts's own insightBody plus
 * `insightOverrides` folded in. One baseline for all three cards, since none of these tests need
 * them to differ.
 *
 * `emptyMetrics` names the metrics whose series answer with no rows, which every other test here
 * leaves unset so all four report a value: that is the state the respiratory card's own fallback
 * (Recovery.tsx's RESPIRATORY_FALLBACK) turns on, and the one a daily-only stub could never
 * produce. A metric left out of the set answers a point exactly as before, so naming one does not
 * disturb the other three.
 */
function stubRecovery(
  urls: string[], baseline: BaselineStub = null, insightOverrides: Partial<Insight> = {},
  emptyMetrics: readonly string[] = [],
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: emptyMetrics.includes(metric) ? [] : [seriesPoint(metric, '2026-08-15', 60)],
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline })
    if (url.includes('/insights')) return json(insightBody(url, insightOverrides))
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same routes as stubRecovery, but each of the 'last' metrics answers its own value rather than the
 * shared 60 every other test in this file uses: the precision test above needs the cards to
 * disagree, since a formatter that quietly used the same precision for all of them could not be
 * told apart from one that reads each metric's own.
 */
function stubRecoveryPerMetric(values: Record<string, number>): () => void {
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
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', values[metric] ?? 60)], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/baselines')) return json({ baseline: null })
    if (url.includes('/insights')) return json(insightBody(url))
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('the Recovery page', () => {
  // All four metrics share an agg, so the page's own cards cost one round trip. Asserting the
  // property rather than a literal count: a pinned number once forced a chart to draw less than it
  // claimed. Four, not three, since the respiratory card carries both of its names (Recovery.tsx's
  // own RESPIRATORY_FALLBACK): the card draws one, and which one is not knowable until the answer
  // is.
  //
  // Filtered to exclude sleep_bedtime_minutes and sleep_asleep_minutes: RecoveryIndexCard mounts
  // its own useRecoveryIndex, which fires two /series requests of its own (a 'last' group for
  // hrv/restingHeartRate/respiratoryRate/bedtime and a 'sum' group for asleep minutes), over a
  // range shifted back by the baseline window - a real, separate cost this test is not about.
  // Those two carry sleep_bedtime_minutes or sleep_asleep_minutes and nothing else here does, so
  // filtering them out leaves exactly the page's own group to assert against.
  //
  // Also excludes heart_rate: HeartRateCard (pages/recovery/HeartRateCard.tsx), mounted at the
  // foot of this page since M9b, issues its own three /series requests (mean, min and max, each
  // its own agg and so each its own round trip - see Dashboard.tsx's own REQUESTS comment for why
  // /series cannot batch more than one agg per call). That is a real, separate cost of its own,
  // not the one request this test is about.
  it('asks for its four metrics in one request', async () => {
    const urls: string[] = []
    const restore = stubRecovery(urls)
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const series = urls.filter((u) =>
      u.includes('/series') && !u.includes('sleep_bedtime_minutes') && !u.includes('sleep_asleep_minutes')
      && !u.includes('metric=heart_rate'))
    expect(series).toHaveLength(1)
    expect(series[0]!.match(/metric=/g)).toHaveLength(4)
    restore()
  })

  // M3 phase review B2: the default Month view's `to` is the calendar month's last day, in the
  // future for all but that one day. Anchoring the baseline and the insight window on it read the
  // month's own unfinished days as though they had already happened, and on the 5th read the
  // baseline as sixty days ending twenty five days from now. historicalTo, not controls.to, is what
  // this test pins.
  it('anchors the baseline and the insight window on today, not the month\'s own future end', async () => {
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
    window.history.replaceState(null, '', '/recovery?range=month')
    const urls: string[] = []
    const restore = stubRecovery(urls)
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    // heart_rate excluded: HeartRateCard's own baseline (mean agg) is a fifth request this test
    // is not about, the same reason the metrics test above excludes its three /series calls.
    const baselineUrls = urls.filter((u) => u.includes('/baselines') && !u.includes('metric=heart_rate'))
    const insightUrls = urls.filter((u) => u.includes('/insights'))
    // Four baselines (resting_heart_rate, daily_hrv and both of the respiratory card's two names)
    // and one insight (resting_heart_rate): if either list came back empty the loop below would
    // pass on nothing. Four rather than three because both of the respiratory card's baselines are
    // requested on every render, not only the one it draws: a hook behind the card's own
    // data-driven branch would change the hook count between renders.
    expect(baselineUrls).toHaveLength(4)
    expect(insightUrls).toHaveLength(1)
    for (const url of baselineUrls) {
      expect(new URL(url, 'http://example').searchParams.get('on')).toBe('2026-09-05')
    }
    for (const url of insightUrls) {
      expect(new URL(url, 'http://example').searchParams.get('to')).toBe('2026-09-05')
    }

    restore()
    vi.useRealTimers()
  })

  // M3 phase review B2, round 2: the fix above capped historicalTo at today but did not floor it
  // at `from`, so a period lying entirely in the future (one click of ControlRow's stepper, or one
  // hand typed date, reaches this in a single step) sent an insight window with `from` after `to`
  // -- `from` stayed at the future period's own start while `to` fell back to today, behind it.
  // requireRange in packages/core/src/query/personQuery.ts refuses exactly that with a 400. The
  // mock below reproduces that refusal itself rather than only inspecting the sent URL afterwards:
  // a URL only assertion cannot tell "the client never sent this" apart from "the client sent it
  // and a lenient mock let it through".
  it('never sends an inverted insight window for a period that has not started yet', async () => {
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
    // range=month&on=2026-10-15 is next month relative to the mocked clock: the whole period is
    // still in the future.
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-10-15')
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        const body: Record<string, unknown> = {}
        for (const metric of metrics) body[metric] = { points: [], reduction: null }
        return json(body)
      }
      if (url.includes('/baselines')) return json({ baseline: null })
      if (url.includes('/insights')) {
        const params = new URL(url, 'http://example').searchParams
        const from = params.get('from')!
        const to = params.get('to')!
        // requireRange's own refusal (personQuery.ts), reproduced here rather than trusted to the
        // client: this is what turns a client regression back into a visible test failure instead
        // of a mock that quietly answers whatever it is asked.
        if (from > to) return json({ error: { kind: 'config', message: `from (${from}) is after to (${to})` } }, 400)
        return json(insightBody(url))
      }
      if (url.includes('/api/sync/status')) {
        return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
      }
      return json({})
    }) as typeof fetch

    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)

    globalThis.fetch = original
    vi.useRealTimers()

    const insightUrls = urls.filter((u) => u.includes('/insights'))
    expect(insightUrls).toHaveLength(1)
    const params = new URL(insightUrls[0]!, 'http://example').searchParams
    expect(params.get('from')! <= params.get('to')!).toBe(true)
  })

  // M3 phase review B2: the three baselines above moved to historicalTo, but baselineNote's own
  // `on` argument, which only reaches the rendered text through the thin branch
  // (recovery.baselineNote.thin interpolates {{on}}; the other branches do not), kept reading
  // controls.to. Dashboard.tsx's own hrBaseline comment states the invariant this reopened for
  // Recovery: the note has to name the date the band was really computed against.
  it('names the baseline\'s own anchor date in a thin note, not the month\'s own future end', async () => {
    vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))
    window.history.replaceState(null, '', '/recovery?range=month')
    const restore = stubRecovery([], { center: 60, spread: 5, n: 10, thin: true })
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const text = container!.textContent!
    expect(text).toContain('60 days before 2026-09-05')
    expect(text).not.toContain('60 days before 2026-09-30')
    restore()
    vi.useRealTimers()
  })

  // The refactor this task is for: card()'s headline used to thread a literal precision
  // (0, 0, 1) per call site rather than reading METRICS[metric].precision through
  // formatMetricValue. All three literals already matched the catalogue, so this cannot catch a
  // literal drifting from it by itself; what it does pin is that the rendered headline is the
  // catalogue's own rounding of an unrounded mean, which is what a broken formatMetricValue call
  // (or a reintroduced literal precision) would get wrong.
  //
  // toBe, not toContain: a prefix match here stays green even if precision drifts (a forced
  // precision+1 renders "61.7 bpm", and "62" would no longer even be a substring of that, but a
  // forced precision+1 on respiratory_rate renders "14.70 breaths/min", where "14.7" IS still a
  // substring -- toContain would have missed exactly that case). Confirmed by reverting `card()`'s
  // formatMetricValue call back to `headline.toFixed(precision)` with precision hardcoded to 2:
  // this failed with "Received: 61.70 bpm" where it expects "62 bpm".
  it('rounds each headline to its own metric catalogue precision, not a copied-in literal', async () => {
    const restore = stubRecoveryPerMetric({
      resting_heart_rate: 61.7,
      daily_hrv: 45.3,
      respiratory_rate: 14.666666666666666,
    })
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const cardFor = (label: string) => [...container!.querySelectorAll('.card')]
      .find((card) => card.querySelector('.label')?.textContent === label)
    // resting_heart_rate and daily_hrv: catalogue precision 0, so a mean of 61.7/45.3 rounds away
    // its own decimal rather than keeping it.
    expect(cardFor('Resting heart rate')?.querySelector('.value')?.textContent).toBe('62 bpm')
    expect(cardFor('Heart rate variability')?.querySelector('.value')?.textContent).toBe('45 ms')
    // respiratory_rate: catalogue precision 1, a many-decimal mean rounds to exactly one place,
    // the same value the reported bug's own fixture (format.test.ts) rounds to.
    expect(cardFor('Respiratory rate')?.querySelector('.value')?.textContent).toBe('14.7 breaths/min')
    restore()
  })

  it('reads daily_hrv, the once a day summary, not the intraday hrv series', async () => {
    const urls: string[] = []
    const restore = stubRecovery(urls)
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(urls.join()).toContain('metric=daily_hrv')
    expect(urls.join()).not.toMatch(/metric=hrv(&|$)/)
    restore()
  })

  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no band when the baseline is thin', async () => {
    const restore = stubRecovery([], { center: 60, spread: 4, n: 3, thin: true })
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  // The other half of the rule above: a real, non-thin baseline does draw one. The brief's own
  // sketch only asserted the thin case; asserting both is what tells the two branches apart,
  // rather than a test that would pass identically if the band were never drawn at all.
  it('draws a band when the baseline is not thin', async () => {
    const restore = stubRecovery([], { center: 60, spread: 4, n: 28, thin: false })
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // A rendered state, not a theoretical one: MetricCard gates on the series query, /baselines is a
  // separate request, and the card draws as soon as the first settles. baselineNote read
  // `data?.baseline ?? null` straight after the error test, so an in flight request came out
  // undefined and took the null branch, printing "no baseline yet to compare against" before
  // anything had been asked. The stub hangs /baselines forever rather than delaying it, so the
  // state under test is where this page rests rather than a moment it passes through.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json(PERSON)
      if (url.includes('/baselines')) return new Promise<Response>(() => {})
      if (url.includes('/series')) {
        const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
        return json(Object.fromEntries(metrics.map((metric) => [metric, {
          points: [seriesPoint(metric, '2026-08-15', 60)],
          reduction: null,
        }])))
      }
      if (url.includes('/api/sync/status')) {
        return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
      }
      return json({})
    }) as typeof fetch
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // The card's own basis paragraph, not just its label: a label can render in the pending
    // branch (Dashboard's copy of this test proves it), and only a basis says the card is past
    // it. Scoped to the card under test so a sibling settling first cannot answer for it.
    await pumpUntil(
      () => [...container!.querySelectorAll('.card')].some((card) =>
        card.querySelector('.label')?.textContent === 'Resting heart rate' && card.querySelector('.basis') !== null),
      'the resting heart rate basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    globalThis.fetch = original
  })

  // Task 4's own insight card. The resting heart rate card above carries a "bpm" suffix through
  // StatTile's own unit prop; restingHrInsightFormat is what closes the gap InsightCard's default
  // formatMetricValue call leaves (no unit at all), the same gap Dashboard.tsx's own restingHrFormat
  // closes for its copy of this card.
  it('carries the resting heart rate tile\'s own bpm suffix into its insight sentence', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery([], null, { current: 61.7, previous: 58.2, delta: 3 })
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Resting heart rate, this period against the last')
    // 62, not 61.7: resting_heart_rate's own catalogue precision is 0, and formatMetricValue
    // inside restingHrInsightFormat is what rounds to it, the same rounding the card's own
    // headline above already applies.
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '62 bpm on average (Aug 1, 2026 to Aug 31, 2026) against 58 bpm on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 3 bpm.',
    )
    restore()
  })

  // Vary the fixture rather than reusing the same positive delta every test in this file: a
  // suppressed response (current/previous/delta all null, the shape comparePeriods's own refuse
  // branch sends) is a null field this card has to fall back on rather than reach
  // formatMetricValue with, which a fixture carrying only complete bodies could never catch.
  it('falls back to the insufficient message when the server suppresses the resting heart rate insight', async () => {
    const restore = stubRecovery([], null, { suppressed: true, reason: 'thin-coverage', current: null, previous: null, delta: null })
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Resting heart rate, this period against the last')
    expect(card?.textContent).toContain('device')
    expect(card?.querySelector('.insight-summary')).toBeNull()
    restore()
  })

  // The fallback Recovery.tsx's RESPIRATORY_FALLBACK exists for, and the state this household's
  // own instance is actually in: the companion app posts Health Connect's night summary, which the
  // catalogue files under sleep_respiratory_rate, while respiratory_rate comes only from Google's
  // own daily type and is never written by a phone. Before this the card drew its empty state over
  // thirty days of real readings.
  it('draws the sleeping series, and says so in the title, when the daily one has no rows', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery([], null, {}, ['respiratory_rate'])
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)

    const labels = [...container!.querySelectorAll('.card .label')].map((el) => el.textContent)
    expect(labels).toContain('Respiratory rate, during sleep')
    // Not both: the day's title must not survive beside the night's, or the page would claim two
    // cards where it draws one.
    expect(labels).not.toContain('Respiratory rate')
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Respiratory rate, during sleep')
    // A number, not the empty state: 60 is what this stub answers every metric with, and
    // sleep_respiratory_rate's own catalogue precision is 1, so a card that had fallen through to
    // "no data" would render no .value at all and one formatted under the wrong metric's precision
    // would drop the decimal.
    expect(card?.querySelector('.value')?.textContent).toBe('60.0 breaths/min')
    restore()
  })

  // The other half of the rule above. respiratory_rate is the preferred name and keeps the card
  // whenever it has a row, even though sleep_respiratory_rate also answered: a fallback that took
  // over a populated card would report the night's number under the day's title, which is the
  // substitution personQuery.ts's own DEVICE_ROLLED_EQUIVALENT comment refuses.
  it('keeps the daily series and its own title when the daily one has rows', async () => {
    window.history.replaceState(null, '', '/recovery?range=month&on=2026-08-15')
    const restore = stubRecovery([], null, {}, ['sleep_respiratory_rate'])
    const { client, tree } = withQuery(<Recovery />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)

    const labels = [...container!.querySelectorAll('.card .label')].map((el) => el.textContent)
    expect(labels).toContain('Respiratory rate')
    expect(labels).not.toContain('Respiratory rate, during sleep')
    restore()
  })

  // The band is a fact about one metric's own history, so the card has to read the baseline of the
  // series it actually drew. Both baselines are answered with the same stub here, which is why this
  // asserts the request side too: /baselines is asked for both names whatever the choice is, and
  // the day's own request is the one that must not be the only one on the wire.
  it('asks for both respiratory baselines, whichever series it ends up drawing', async () => {
    const urls: string[] = []
    const restore = stubRecovery(urls, null, {}, ['respiratory_rate'])
    const { client, tree } = withQuery(<Recovery />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    const baselineMetrics = urls
      .filter((u) => u.includes('/baselines'))
      .map((u) => new URL(u, 'http://example').searchParams.get('metric'))
    expect(baselineMetrics).toContain('sleep_respiratory_rate')
    restore()
  })
})

describe('contributionRows', () => {
  it('orders inputs by how much they moved the score, largest first', () => {
    const rows = contributionRows([
      { key: 'hrv', weight: 0.35, points: 2 },
      { key: 'restingHeartRate', weight: 0.30, points: -11 },
      { key: 'sleep', weight: 0.25, points: 1 },
    ])
    expect(rows.map((row) => row.key)).toEqual(['restingHeartRate', 'hrv', 'sleep'])
  })

  it('rounds points to whole numbers, because a tenth of a point means nothing', () => {
    const rows = contributionRows([{ key: 'hrv', weight: 1, points: -11.4 }])
    expect(rows[0]?.points).toBe(-11)
  })
})
