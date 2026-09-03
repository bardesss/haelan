// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Dashboard } from '../src/pages/Dashboard.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { dayMetricTarget } from '@haelan/core/target-key'
import { flush, pumpUntil } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

// Same reason dashboard-round-trip.test.tsx needs this: HeartRateRange and the other restored
// charts draw for real here, and echarts.init's effect throws "missing chart token" without it.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam',
}

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

type Baseline = { center: number, spread: number, n: number, thin: boolean } | null

/**
 * Answers every route the Dashboard now calls: the session (seeded above, but a real render still
 * asks it once), /series for every requested metric, /sleep/nights, and /baselines with whichever
 * baseline the test wants. One canned point per metric, the same way
 * dashboard-round-trip.test.tsx's stubFetchOnePointPerMetric does, so heart_rate has something to
 * plot and the band, when the baseline says to draw one, has an axis to sit on.
 */
function stubFetch(opts: { baseline: Baseline, hangBaselines?: boolean }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = {
          points: [seriesPoint(metric, '2026-08-15', 60)],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      // Never resolving rather than delayed, so the in flight state is somewhere this page rests
      // and not a moment a test has to catch it passing through.
      if (opts.hangBaselines === true) return new Promise<Response>(() => {})
      return new Response(JSON.stringify({ baseline: opts.baseline }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Fails every read the cards draw from, the way a 500, a bad source or a dropped connection
 * reaches this app: an ApiError out of apiSend, which leaves the query with isPending false and
 * data undefined. That is the same shape as a settled empty response, which is why every card
 * used to render "No data yet. Nothing has been recorded for this period." over a failure.
 */
function stubFailingReads(seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same routes as stubFetch, but every metric named in `overrides` answers that value instead of
 * the uniform 60, and every other metric still gets 60. Used by the precision/grouping test
 * below, which needs steps and heart_rate to carry values a shared "60 everywhere" stub cannot
 * tell apart: a four figure steps total (thousands grouping) and a heart rate mean with a
 * fraction (rounding).
 */
function stubFetchValues(overrides: Record<string, number>): () => void {
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
    if (url.includes('/sleep/nights')) return json({ items: [], cursor: null })
    if (url.includes('/baselines')) return json({ baseline: null })
    if (url.includes('/insights')) return json(insightBody(url))
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('a card whose request failed', () => {
  // The rule the whole branch is about, applied to the one case nothing on the page handled: a
  // 500 is not a statement about somebody's health record, and "Nothing has been recorded for
  // this period" is.
  it('says the request failed rather than that there is nothing recorded', async () => {
    const seen: string[] = []
    const restore = stubFailingReads(seen)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('This did not load.')
    expect(container!.textContent).not.toContain('Nothing has been recorded for this period.')
    restore()
  })

  it('offers a retry that asks again', async () => {
    const seen: string[] = []
    const restore = stubFailingReads(seen)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)

    const before = seen.filter((u) => u.includes('/series')).length
    const retry = container!.querySelector('.empty button') as HTMLButtonElement
    expect(retry.textContent).toBe('Try again')
    act(() => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    expect(seen.filter((u) => u.includes('/series')).length).toBeGreaterThan(before)
    restore()
  })
})

/**
 * One real night: distinct bed and wake minutes, unlike stubFetch's one-point-per-metric answer,
 * which hands sleep_bedtime_minutes and sleep_waketime_minutes the same value and so gets nulled
 * out by withinSchedule (wake <= bed) rather than counted as a drawn night.
 */
function stubOneNight(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        const value = metric === 'sleep_bedtime_minutes' ? -30 : metric === 'sleep_waketime_minutes' ? 420 : 60
        body[metric] = {
          points: [seriesPoint(metric, '2026-08-15', value)],
          reduction: null,
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * What the wire actually looks like once an exclusion has applied: deriveDay deletes the excluded
 * metric's daily row, so /series answers with that day simply absent, and GET /overrides is the
 * only thing that still knows it existed. Every point lands on a different day from the excluded
 * one for exactly that reason.
 */
function stubAppliedExclusion(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-14', 60)], reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/overrides')) {
      return new Response(JSON.stringify({
        items: [{
          id: 'o1', scope: 'day_metric',
          targetKey: dayMetricTarget({ localDate: EXCLUDED_DATE, metric: 'steps' }),
          action: 'exclude', correctedValue: null, reason: EXCLUDED_REASON,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * Same routes and responses as stubFetch({ baseline: null }), plus a record of every request URL:
 * the insight card tests below are about what the page put on the wire, which stubFetch's own
 * signature has no way to report back.
 */
function stubFetchTracking(sent: { url: string }[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    sent.push({ url })
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      return new Response(JSON.stringify(insightBody(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * stubFetch with one difference: the sleep insight carries a negative delta (a week where mean
 * sleep fell), current 401 against previous 408. Every fixture elsewhere in this file uses
 * insightBody's own default delta of 10, which is positive and so could never have caught the
 * sign bug this stub exists to reproduce: formatDuration was written for a duration, which cannot
 * be negative, and sleepFormat handed it insight.delta unguarded, so a negative delta printed
 * with two minus signs ("-1h -7m") rather than one.
 */
function stubFetchWithNegativeSleepDelta(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) {
      return new Response(JSON.stringify(PERSON), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        body[metric] = { points: [seriesPoint(metric, '2026-08-15', 60)], reduction: null }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sleep/nights')) {
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/baselines')) {
      return new Response(JSON.stringify({ baseline: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/insights')) {
      const isSleep = new URLSearchParams(url.split('?')[1] ?? '').get('metric') === 'sleep_asleep_minutes'
      const overrides = isSleep ? { current: 401, previous: 408, delta: -7 } : {}
      return new Response(JSON.stringify(insightBody(url, overrides)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const EXCLUDED_DATE = '2026-08-15'
const EXCLUDED_REASON = 'phone left at home'

describe('a day whose exclusion has applied', () => {
  // The branch review's second blocker, measured end to end from what the server sends. /series
  // omits the excluded day, so a card handed the points array directly had no position for it: the
  // mark, the reason and the accessible table row all went with it, and the day the reader
  // excluded left the chart looking exactly like a day nothing was ever recorded for. The chart
  // level tests in chart-marks.test.tsx pin what a chart does with a gap; this pins that a page
  // still hands its charts one entry per day in the range, which is what makes the gap exist.
  it('still carries the day, marked and explained, on the card for the metric it names', async () => {
    window.history.replaceState(null, '', `/?range=month&on=${EXCLUDED_DATE}`)
    const restore = stubAppliedExclusion()
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)

    // Every row for that date across the page's charts, not the first one found: the heart rate
    // range chart has always been dense and so has always had a row for this day, and it is not
    // the card the steps override names. The property is that the card the override names states
    // what happened to the day, and reading only the first match would let this pass on a row
    // belonging to a chart the override never touched.
    const rows = [...container!.innerHTML.matchAll(
      new RegExp(`<tr><th scope="row">${EXCLUDED_DATE}</th>[\\s\\S]*?</tr>`, 'g'),
    )].map((match) => match[0])
    expect(rows.length, 'no table row for the excluded day at all').toBeGreaterThan(0)
    const marked = rows.filter((row) => row.includes('excluded'))
    expect(marked, 'the excluded day is on the page but no card says it was excluded').toHaveLength(1)
    // "excluded" in the value cell as well as the note cell, never "no reading": there was a
    // reading and the reader threw it out.
    expect(marked[0]!).not.toContain('no reading')
    expect(marked[0]!).toContain(EXCLUDED_REASON)
    restore()
  })
})

describe('the remaining Dashboard cards', () => {
  // The rule the band exists for. A band computed from three days looks exactly as authoritative
  // as one computed from thirty, and thin is the reader's only signal that it is not.
  it('draws no baseline band when the baseline is thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 3, thin: true } })
    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).toBeNull()
    restore()
  })

  it('draws the band when the baseline is not thin', async () => {
    const restore = stubFetch({ baseline: { center: 60, spread: 4, n: 28, thin: false } })
    const { client, tree } = withQuery(<Dashboard />)
    mount(tree)
    await flush(client, () => container!.innerHTML)
    expect(container!.querySelector('[data-baseline-band]')).not.toBeNull()
    restore()
  })

  // Not a placeholder and not a lie. No route serves typed events yet.
  it('shows flagged days as empty rather than wiring it to something event shaped', async () => {
    const restore = stubFetch({ baseline: null })
    // Through a real I18nProvider rather than asserting on the raw key: initReactI18next installs
    // whichever instance was created last as react-i18next's default, so a provider-less render
    // resolves the catalogue anyway once any other test in the file has mounted one, and the
    // assertion silently depended on this test running first.
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    expect(container!.textContent).toContain('No flagged days yet.')
    restore()
  })

  // The defect the stub above was hiding. Every sleep row the server can send carries
  // coverage: null, and reading that as a zero made the card render "Device not worn" over a
  // month of real nights while the mean was never drawn at all.
  it('draws the sleep mean over rows whose coverage is null rather than calling the device unworn', async () => {
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // 60 minutes is what the stub answers for every metric, so this string belongs to the one
    // card that formats its value as a duration.
    expect(container!.textContent).toContain('1h 00m')
    expect(container!.textContent).not.toContain('Device not worn')
    restore()
  })

  // dashboard.sleepSchedule.basis had no plural form and 1 is reachable, the surviving instance
  // of the hazard M3d-1 fixed on the wear clause ("1 days not worn").
  it('renders the sleep schedule basis in the singular for one night', async () => {
    const restore = stubOneNight()
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    // Scoped to the sleep schedule's own basis text: dashboard.sleep's unrelated basis line also
    // reports against "nights" and, with this stub's single point, happens to read "1 of 31
    // nights" too.
    expect(container!.textContent).toContain('bed and wake time, 1 night')
    expect(container!.textContent).not.toContain('bed and wake time, 1 nights')
    restore()
  })

  // The principle heartRateBasisKey's own comment states three lines above the branch that broke
  // it: "no baseline yet" is a claim about the person's history, and an unanswered request makes
  // no such claim. MetricCard gates the card on the three heart rate series, /baselines settles
  // separately, so the card draws while this one is still in flight and the null branch spoke for
  // it.
  it('does not claim there is no baseline while the baseline request is in flight', async () => {
    const restore = stubFetch({ baseline: null, hangBaselines: true })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    // Gated on the basis line, not on the card's label: Dashboard passes `label` to MetricCard and
    // MetricCard renders it in the pending branch too, so waiting for "Heart rate range" can go
    // true a tick before any basis exists and the assertions below would be reading an empty card.
    // "daily minimum, mean and maximum" is the shared prefix of all four heartRateRange templates,
    // so it says a basis has rendered without being the clause under test, which is what keeps a
    // regression an assertion failure rather than a timeout.
    await pumpUntil(
      () => container!.textContent!.includes('daily minimum, mean and maximum'),
      'the heart rate range basis line',
    )
    const text = container!.textContent!
    expect(text).toContain('the baseline is still loading')
    expect(text).not.toContain('no baseline yet to compare against')
    restore()
  })

  // The refactor this task is for: Dashboard's own local groupNumber (a byte-identical copy of
  // Activity.tsx's) and the two String(Math.round(...)) heart rate headlines are gone, replaced by
  // formatMetricValue reading METRICS[metric].precision. A single reading cannot tell the old code
  // and the new code apart when it is already a whole thousand-free integer, so this asks for a
  // steps total large enough to group (four figures) and a heart rate mean with a fraction: both
  // render the same today as they did before this task in the case that was already correct, but
  // a wrong precision or a dropped grouping call would now show up here.
  //
  // toBe, not toContain: "12,345" is a substring of "12,345.00" too, and "62" is a substring of
  // "61.7" is false but "62.0" is true, so a prefix match here would stay green for a precision
  // that drifted the wrong way. Confirmed two ways: the resting_heart_rate tile reverted to
  // `String(mean(values(p)))` (no rounding at all) failed with "Received: 61.7 bpm" where it
  // expects "62 bpm"; the steps tile reverted to `String(values(p).reduce((a, b) => a + b, 0))`
  // (no grouping at all) failed with "Received: 12345" where it expects "12,345", and the same
  // revert failed the Dutch test below with "Received: 11999" where it expects "11.999".
  it('groups a four figure steps total per language and rounds heart rate to its own precision', async () => {
    const restore = stubFetchValues({ steps: 12345, resting_heart_rate: 61.7, heart_rate: 88.4 })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const cardFor = (label: string) => [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === label)
    expect(cardFor('Steps')?.querySelector('.value')?.textContent).toBe('12,345')
    expect(cardFor('Resting heart rate')?.querySelector('.value')?.textContent).toBe('62 bpm')
    expect(cardFor('Mean heart rate')?.querySelector('.value')?.textContent).toBe('88 bpm')
    restore()
  })

  // The Dutch half of the same grouping call: 11.999 groups with a period in Dutch, 11,999 in
  // English, the exact distinction i18n-parity style tests exist to hold onto for a shared
  // formatter rather than a copied-in `.toLocaleString(i18n.language)`.
  it('groups the same steps total with a Dutch thousands separator under a Dutch locale', async () => {
    const restore = stubFetchValues({ steps: 11999 })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="nl">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const stepsCard = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Stappen')
    expect(stepsCard?.querySelector('.value')?.textContent).toBe('11.999')
    restore()
  })

  it('does not import the fixtures', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('apps/web/src/pages/Dashboard.tsx', 'utf8')
    expect(source).not.toContain('fixtures/july')
  })
})

describe('the three insight cards', () => {
  // The brief's own test, verbatim: /insights takes one metric and one agg per call and does not
  // batch the way /series does, so three curated cards are three separate requests, not one shared
  // one.
  it('draws three insight cards and asks for each separately', async () => {
    const sent: { url: string }[] = []
    const restore = stubFetchTracking(sent)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const insightCalls = sent.filter((r) => r.url.includes('/insights'))
    expect(insightCalls).toHaveLength(3)
    expect(insightCalls.map((r) => new URL(r.url, 'http://x').searchParams.get('metric')).sort())
      .toEqual(['resting_heart_rate', 'sleep_asleep_minutes', 'steps'])
    restore()
  })

  // The curated three carry a curated agg each, not whichever one a shared default would pick:
  // steps and sleep_asleep_minutes ride 'sum', the same agg REQUESTS.sum already asks /series for
  // them; resting_heart_rate rides 'last', the once a day reading REQUESTS.last already carries for
  // it, not the 'mean' its own tile derives client side from those points.
  it('asks each metric for the agg its own tile already uses', async () => {
    const sent: { url: string }[] = []
    const restore = stubFetchTracking(sent)
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const byMetric = new Map(sent.filter((r) => r.url.includes('/insights')).map((r) => {
      const params = new URL(r.url, 'http://x').searchParams
      return [params.get('metric'), params.get('agg')]
    }))
    expect(byMetric.get('steps')).toBe('sum')
    expect(byMetric.get('sleep_asleep_minutes')).toBe('sum')
    expect(byMetric.get('resting_heart_rate')).toBe('last')
    restore()
  })

  // The collision this page's own comment beside the cards warns about: a second card sharing a
  // metric tile's exact label text would make this file's own cardFor() (and a reader glancing at
  // the page) unable to tell the tile and the insight card apart by name.
  it('labels each insight card distinctly from its metric tile', async () => {
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const labels = [...container!.querySelectorAll('.card .label')].map((el) => el.textContent)
    expect(labels.filter((l) => l === 'Steps')).toHaveLength(1)
    expect(labels.filter((l) => l === 'Resting heart rate')).toHaveLength(1)
    expect(labels).toContain('Steps, this period against the last')
    restore()
  })

  // A fixed month, not the file's default (unrouted) mount: insightBody echoes the request's own
  // from/to back as currentRange (see metricCoverage.ts's own comment on why), so a test that left
  // the route unset would be asserting against today's real date and would need re-deriving every
  // time it ran. range=month&on=2026-08-15 gives clean, hand-computable full-calendar-month
  // windows: current August 1 to 31, previous July 1 to 31.
  //
  // The wiring end to end, not just the request: this is the exact sentence InsightCard.tsx
  // renders once the query settles, read off the one card whose label names it rather than off
  // page-wide text (all three cards share the same stub body and so would render the identical
  // sentence but for their own formatValue, which is exactly why a page-wide toContain would not
  // tell a caller apart from a typo in a different card's props).
  it('renders the summary sentence for the steps card once the request resolves', async () => {
    window.history.replaceState(null, '', '/?range=month&on=2026-08-15')
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Steps, this period against the last')
    // No unit suffix: the steps tile above prints a plain, unitless number, and steps carries no
    // formatValue override in Dashboard.tsx for exactly that reason.
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '70 on average (Aug 1, 2026 to Aug 31, 2026) against 60 on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 10.',
    )
    restore()
  })

  // Important 1 from the review round: insight.current/previous/delta are a mean in whatever unit
  // the metric is stored in, and the resting heart rate tile beside this card carries a "bpm"
  // suffix (StatTile's own `unit` prop) that InsightCard's default formatMetricValue call does
  // not add on its own. restingHrFormat in Dashboard.tsx is what closes that gap; this pins the
  // suffix actually reaching the rendered sentence rather than only existing in the wiring.
  it('carries the resting heart rate tile\'s own bpm suffix into its insight sentence', async () => {
    window.history.replaceState(null, '', '/?range=month&on=2026-08-15')
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Resting heart rate, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '70 bpm on average (Aug 1, 2026 to Aug 31, 2026) against 60 bpm on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 10 bpm.',
    )
    restore()
  })

  // The other half of Important 1: the sleep tile beside this card formats its own mean through
  // formatDuration ("7h 01m"), never the raw minutes formatMetricValue alone would print, and
  // without a duration formatValue this card printed "70" where its own tile a few cards over
  // prints "1h 10m" for the identical quantity. formatSignedDuration (format.ts) is what this
  // card's own formatValue is now, passed directly rather than through a local wrapper.
  it('formats the sleep insight as a duration rather than raw minutes', async () => {
    window.history.replaceState(null, '', '/?range=month&on=2026-08-15')
    const restore = stubFetch({ baseline: null })
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Sleep, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '1h 10m on average (Aug 1, 2026 to Aug 31, 2026) against 1h 00m on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of 0h 10m.',
    )
    restore()
  })

  // The sign bug the review round found: sleepFormat handed insight.delta straight to
  // formatDuration, which was only ever fed a non-negative duration before this task.
  // formatDuration's own Math.floor(total / 60) paired with a sign-carrying `total % 60` prints a
  // negative input as two minus signs, one on each half, rather than one on the whole duration.
  // -7 alone (a seven minute drop, not a large or hour-crossing one) is enough to show it: -1
  // (floor(-7/60)) and -7 (-7 % 60 in JS keeps the dividend's sign) render as "-1h -7m".
  it('formats a negative sleep delta with one leading minus rather than two', async () => {
    window.history.replaceState(null, '', '/?range=month&on=2026-08-15')
    const restore = stubFetchWithNegativeSleepDelta()
    const { client, tree } = withQuery(<Dashboard />)
    mount(<I18nProvider lng="en">{tree}</I18nProvider>)
    await flush(client, () => container!.innerHTML)
    const card = [...container!.querySelectorAll('.card')]
      .find((c) => c.querySelector('.label')?.textContent === 'Sleep, this period against the last')
    expect(card?.querySelector('.insight-summary')?.textContent).toBe(
      '6h 41m on average (Aug 1, 2026 to Aug 31, 2026) against 6h 48m on average in the previous period '
      + '(Jul 1, 2026 to Jul 31, 2026), a change of -0h 07m.',
    )
    restore()
  })
})
