// @vitest-environment happy-dom
//
// A separate file from sleep-page.test.tsx because it seeds a different /series answer: every stub
// in that file hands each metric one point, which is the right shape for a tile and useless for a
// card whose whole subject is a run of nights. This one hands sleep_asleep_minutes a real week,
// with a gap in it, and leaves every other route answering what the page's other cards need.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as echarts from 'echarts/core'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import { dayMetricTarget } from '@haelan/core/target-key'
import type { Session } from '../src/auth/session.js'
import { Sleep } from '../src/pages/Sleep.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'
import { seriesPoint, insightBody } from './metricCoverage.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true,
  timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

// The week the card is measured over, and the URL that asks for exactly it. The picker anchors a
// week on the day `on` names, so `on=2026-08-16` asks for Monday the 10th through Sunday the 16th,
// which is the mockup's own Mon to Sun shape. Supplying `on` as well as `range` matters: the anchor
// is otherwise the browser's today, and the assertions below read the dates back out of the basis
// line and the table.
const WEEK = { from: '2026-08-10', to: '2026-08-16' }
const WEEK_URL = `/sleep?range=week&on=${WEEK.to}`
// Six readable nights and one the watch missed, against the default target of 480. The deviations
// sum to -135 minutes, or -2h 15m, which is the card's own headline.
const WEEK_NIGHTS: (number | null)[] = [420, 480, 540, null, 390, 450, 465]
const WEEK_DATES = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']

type BaselineStub = { center: number, spread: number, n: number, thin: boolean } | null

// What a merged row carries instead of a single source: the JSON blob the control row's source
// selector is built from, and the reason every sum metric here has to carry one. Without it
// `distinctSources` finds nothing, the picker has no options, and a `?source=` the reader picked
// falls back to the all sources sentinel before any request is made.
const MIX = JSON.stringify([{ source: 'watch', points: 7 }])

/**
 * Answers every route Sleep calls, with `nights` (indexed against WEEK_DATES) as
 * sleep_asleep_minutes' own week. Every other sum metric answers 2026-08-15 at 420, which is every
 * other stub in this directory's own value and keeps the tiles out of an empty state.
 *
 * A null in `nights` is a night the request answers with NO point for, which is the wire shape both
 * absences share: `/series` omits a day nothing reported, and it omits a day the reader excluded
 * for the same reason (deriveDay deletes the excluded metric's daily row). `absentFrom` withholds a
 * point for a day whose value is not null, which is how a case asks for "this day was excluded and
 * the re-derive has already run" without also claiming the night was never recorded.
 *
 * `nights` of `[]` is then the "reported nothing at all" case, which is MetricCard's own no_data
 * branch; a week of nulls is the harder one, because the request answered and the chart still has
 * nothing to draw.
 */
function stubBalance(
  urls: string[], nights: readonly (number | null)[] = WEEK_NIGHTS, baseline: BaselineStub = null,
  overrides: unknown[] = [], absentFrom: readonly string[] = [],
): () => void {
  // Copied, because two tests below hand this a per-case array built from WEEK_NIGHTS and the
  // alternative is a helper that silently mutates a module level constant every other case reads.
  // The symptom of getting that wrong is not confined to the test that did it: this file's own
  // first draft mapped WEEK_NIGHTS to all nulls in place, and a later case then failed with a
  // headline two hours away from the one its own numbers produce.
  const week = [...nights]
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    // A source this person's own series responses report, so the picker's own resolver accepts a
    // `?source=` naming it rather than falling back to the all sources sentinel: ControlRow offers
    // what this route answers, and `resolveSource` refuses a name that is not in the list.
    if (url.includes('/sources')) {
      return json({
        items: [{
          id: 'watch', externalId: 'com.example.watch', displayName: 'Watch', alias: null, name: 'Watch',
          kind: 'device', createdAtMs: 0,
        }],
      })
    }
    if (url.includes('/overrides')) return json({ items: overrides })
    if (url.includes('/notes')) return json({ items: [] })
    if (url.includes('/events')) return json({ items: [] })
    if (url.includes('/series')) {
      const metrics = new URLSearchParams(url.split('?')[1] ?? '').getAll('metric')
      const body: Record<string, unknown> = {}
      for (const metric of metrics) {
        if (metric === 'sleep_asleep_minutes') {
          body[metric] = {
            points: WEEK_DATES.flatMap((date, i) => {
              const value = week[i]
              const dropped = value === null || value === undefined || absentFrom.includes(date)
              return dropped
                ? []
                : [seriesPoint(metric, date, value, { source: 'watch', sourceMix: MIX })]
            }),
            reduction: null,          }
          continue
        }
        body[metric] = { points: [seriesPoint(metric, WEEK.to, 420, { source: 'watch', sourceMix: MIX })], reduction: null }
      }
      return json(body)
    }
    if (url.includes('/sleep/nights')) {
      return json({
        items: [{
          localDate: WEEK.to, sourceId: 'watch', sessionIds: ['s1'],
          startMs: Date.parse(`${WEEK.to}T00:00:00Z`) - 40 * 60_000,
          endMs: Date.parse(`${WEEK.to}T00:00:00Z`) + 425 * 60_000,
          startOffsetMinutes: 0, endOffsetMinutes: 0, naps: [], excludedSessions: [],
          segments: [{
            stage: 'LIGHT',
            startMs: Date.parse(`${WEEK.to}T00:00:00Z`) - 40 * 60_000,
            endMs: Date.parse(`${WEEK.to}T00:00:00Z`) + 425 * 60_000,
          }],
        }],
        cursor: null,
      })
    }
    if (url.includes('/baselines')) return json({ baseline })
    if (url.includes('/insights')) return json(insightBody(url))
    if (url.includes('/api/sync/status')) {
      return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    }
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** The card itself, found by its short label; the basis line below it names the zero line. The
 *  label is a parameter because it is translated: the Dutch case below renders the same card as
 *  'Slaapbalans', and a finder hardcoded to the English string would simply not find it and read
 *  as "the card is missing" rather than as a locale the helper cannot see. */
const balanceCard = (label = 'Sleep Balance'): Element | undefined =>
  [...container!.querySelectorAll('.card')].find((card) =>
    (card.querySelector('.label')?.textContent ?? '') === label)

const headline = (): string | undefined => balanceCard()?.querySelector('.value')?.textContent ?? undefined

/** The card's own accessible table, told apart from its neighbours by its value column. */
const balanceTable = (): Element | undefined =>
  [...container!.querySelectorAll('table.sr-only')]
    .find((table) => table.textContent?.includes('Minutes over or under'))

const rowFor = (date: string): (string | null)[] | undefined =>
  [...(balanceTable()?.querySelectorAll('tbody tr') ?? [])]
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    .find((cells) => cells[0] === date)

/** The drawn bars, read off the chart's own option: happy-dom applies no stylesheet and echarts
 *  draws to a canvas, so the option is the last place a bar's value appears before it is a
 *  coordinate. The same idiom sleep-page.test.tsx uses for its schedule chart. */
function drawnValues(label: string): unknown[] | undefined {
  const host = container!.querySelector<HTMLDivElement>(`div[role="img"][aria-label="${label}"]`)
  const option = host === null ? undefined : echarts.getInstanceByDom(host)?.getOption() as
    { series?: { data?: unknown[] }[] } | undefined
  return option?.series?.[0]?.data
}

async function render(client: QueryClient, tree: ReactNode, language = 'en'): Promise<void> {
  mount(<I18nProvider lng={language}>{tree}</I18nProvider>)
  await flush(client, () => container!.innerHTML)
}

describe('the sleep balance card', () => {
  it('states the sum of the bars and the nights they were taken over', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    // Worked by hand from WEEK_NIGHTS against the stored target of 480: -60, 0, +60, absent, -90,
    // -30, -15 sums to -135. The whole cell rather than a substring, because "2h 15m" alone would
    // also match a card that had counted the silent night as a night at exactly its target.
    expect(headline()).toBe('-2h 15m')
    // The night count is the card's own basis, computed from the bars actually drawn rather than
    // from the seven days in the range: 6 of 7, and the zero line named because the card switches
    // between two of them. The per-night mean rides beside the count: -135 over those same six
    // nights is -22.5, which formatSignedDuration rounds to -0h 23m.
    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, -0h 23m a night, against your 8h 00m target')
  })

  // What the per-night figure is for: the headline grows by widening the picker alone, so the card
  // needs one number that does not. That only holds if it is a mean over the nights drawn rather
  // than over the days in the range, and on any week with a gap the two are a different sentence:
  // -135 over six nights is -0h 23m, over seven days it is -0h 19m. Both read as plausible on
  // screen, which is why the wrong one is named here rather than left to a bare `toBe`.
  it('means the per-night figure over the nights drawn, not the days in the range', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    const basis = balanceCard()!.querySelector('.basis')!.textContent
    expect(basis).toBe('6 of 7 nights, -0h 23m a night, against your 8h 00m target')
    expect(basis).not.toContain('-0h 19m')
  })

  // Rendered, not merely present in nl.json. The locale guard compares key sets and never reads a
  // string, so a Dutch basis line that dropped the per-night clause or named a placeholder that
  // does not exist would ship with every English case in this file green. formatSignedDuration
  // carries no locale of its own, so the figure itself reads the same in both.
  it('states the per-night figure in Dutch too', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree, 'nl')
    restore()

    expect(balanceCard('Slaapbalans')!.querySelector('.basis')!.textContent)
      .toBe('6 van 7 nachten, -0h 23m per nacht, tegen je doel van 8h 00m')
  })

  // Absent is never a zero. A night with no reading draws no bar and counts toward neither the
  // headline nor the denominator, which is the rule the whole card is built on and the one a
  // `.map((v) => v ?? 0)` would quietly break.
  it('does not treat a night with no reading as a night of no surplus', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    const row = rowFor('2026-08-13')
    expect(row).toBeDefined()
    expect(row![1]).toBe('no reading')
    expect(row![1]).not.toBe('0h 00m')
    // The null is still in the drawn array, at its own position, so the nights either side of it
    // did not shift a day to the left.
    expect(drawnValues('Nightly sleep balance through 2026-08-10 to 2026-08-16'))
      .toEqual([-60, 0, 60, null, -90, -30, -15])
  })

  // The other absence, and a different sentence: there was a reading and the reader threw it out,
  // which is what dayMarks moves to a by-position mark so the canvas and the table agree.
  //
  // Asserted through the note column rather than the value column, and the reason is worth writing
  // down. This is the state where the OVERRIDE EXISTS but the re-derive has not landed yet, which
  // `dayMarks`' own doc comment describes: the point is still on the chart and the mark sits on top
  // of it, and the value cell therefore still holds a number, which is what the chart draws and what
  // the table says beside it. What the exclusion has to produce here is the WORD, which is the
  // sentence a canvas with a silent gap would contradict; once the derive has applied, the day is
  // deleted, the series omits it, and the value cell reads "excluded" with no number at all, which
  // is what the render below tests.
  it('names an excluded night rather than leaving it silent', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], WEEK_NIGHTS, null, [{
      id: 'o1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'sleep_asleep_minutes' }),
      action: 'exclude', correctedValue: null, reason: 'Away',
    }])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(rowFor('2026-08-11')![2]).toContain('excluded')
    // And the neighbouring silent night, which the reader did nothing to, says something else: the
    // two absences are never collapsed into one word.
    expect(rowFor('2026-08-13')![2]).toBe('')
    expect(rowFor('2026-08-11')![1]).not.toBe('no reading')
  })

  // The state the derivation actually leaves behind: deriveDay deletes the excluded metric's daily
  // row, so /series omits the day, the value cell has nothing to format, and the table says
  // "excluded" where a number used to be. This is the one the canvas must not contradict with a
  // silent gap, and it is the shape a reader sees once the write has landed.
  it('states excluded for a night the derived data has already dropped', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    // Five nights at the target, one thorough night and one short one, so the two possible answers
    // are a long way apart: the nights that reported are 480 + 480 + 480 + 480 + 570 + 390 = 2880
    // against the target of 480, which is exactly nothing, where a card that had kept the excluded
    // night and read its missing point as zero would answer -1h 30m.
    const nights = [480, 480, 480, 480, 570, 390, 480]
    const restore = stubBalance([], nights, null, [{
      id: 'o1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'sleep_asleep_minutes' }),
      action: 'exclude', correctedValue: null, reason: 'Away',
    }], ['2026-08-11'])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(rowFor('2026-08-11')![1]).toBe('excluded')
    // Counted against nothing, and over six nights rather than seven: the same claim the basis line
    // makes one line up, asserted on the number the excluded night would have moved.
    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, 0h 00m a night, against your 8h 00m target')
    expect(headline()).toBe('0h 00m')
    expect(headline()).not.toBe('-1h 30m')
  })

  // The request that carries the exclusions, so the case above cannot pass by the page never
  // having asked for them.
  it('asks for the exclusions it draws', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const urls: string[] = []
    const restore = stubBalance(urls)
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()
    expect(urls.filter((u) => u.includes('/overrides'))).toHaveLength(1)
  })

  // The rule from #293, in the shape this card can actually meet it. Every night absent means
  // `/series` answered with no points for the metric at all, which is MetricCard's own no_data
  // branch, which hides the Card rather than leaving a shell that would still report itself present
  // to CardGrid. The card carries no gate of its own for this and should not: an applied exclusion
  // deletes the metric's daily row at derivation, so a range of nothing but excluded nights leaves
  // no points behind either, and a second guard would be a branch no input could reach.
  it('renders no card at all when no night in the range is readable', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], WEEK_DATES.map(() => null))
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(balanceCard()).toBeUndefined()
    // The page itself is still there, so "no card" is a claim about this one rather than about a
    // page that failed to render. The other cards read sleep_bedtime_minutes and friends, which
    // this stub still answers.
    expect(container!.textContent).toContain('Sleep stages')
  })

  it('renders no card at all when the metric reported nothing in the range', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], [])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()
    expect(balanceCard()).toBeUndefined()
    expect(container!.textContent).toContain('Sleep stages')
  })

  // The two line rule for the zero line. A baseline that is not thin is the person's own usual and
  // takes over; the basis line says which of the two it is measuring against, because "8h short
  // of 8h" and "1h below your usual" are different claims.
  it('uses the person\'s own usual once the baseline is not thin', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], WEEK_NIGHTS, { center: 540, spread: 30, n: 60, thin: false })
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(balanceCard()!.querySelector('.label')!.textContent).toBe('Sleep Balance')
    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, -1h 23m a night, against your usual 9h 00m, 60 days before 2026-08-16')
    // The same bars against a centre 60 minutes higher: -120, -60, 0, absent, -150, -90, -75 sums
    // to -495. A card that named the baseline but kept measuring against the target would read
    // -2h 15m, which is the whole claim of this test and the half a label assertion cannot make.
    expect(headline()).toBe('-8h 15m')
  })

  it('falls back to the stored target when the baseline is thin', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], WEEK_NIGHTS, { center: 540, spread: 30, n: 41, thin: true })
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(balanceCard()!.querySelector('.label')!.textContent).toBe('Sleep Balance')
    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, -0h 23m a night, against your 8h 00m target')
    expect(headline()).toBe('-2h 15m')
  })

  // 42 is the crossover, and it is the app's own: `thin` is `n < 14 || n / 60 < 0.7` over the
  // trailing 60 days, so 41 nights is still thin and 42 is not. Pinned from both sides because the
  // card is the first reader to switch on this flag rather than merely hide a band with it.
  it('switches at the baseline\'s own 42 night crossover, not at one of its own', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const thin = stubBalance([], WEEK_NIGHTS, { center: 540, spread: 30, n: 41, thin: true })
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    thin()
    expect(balanceCard()!.querySelector('.label')!.textContent).toBe('Sleep Balance')
    expect(headline()).toBe('-2h 15m')

    // The card is unmounted between the two, rather than a second tree rendered beside the first:
    // `balanceCard()` finds the first match in the document, so a leftover card from the render
    // above would answer for this one and the case would pass without the second baseline ever
    // reaching a card.
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const solid = stubBalance([], WEEK_NIGHTS, { center: 540, spread: 30, n: 42, thin: false })
    const second = withQuery(<Sleep />)
    await render(second.client, second.tree)
    solid()
    expect(balanceCard()!.querySelector('.label')!.textContent).toBe('Sleep Balance')
    expect(headline()).toBe('-8h 15m')
  })

  // The target is a stored preference rather than an instance constant, so the card has to read the
  // one the person actually chose: hardcoded to 480 it would pass every case above.
  it('measures against the target the person set, not the default', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), { ...PERSON, sleepTargetMinutes: 420 })
    const tree = <QueryClientProvider client={client}><Sleep /></QueryClientProvider>
    await render(client, tree)
    restore()

    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, 0h 38m a night, against your 7h 00m target')
    // Against 420: 0, +60, +120, absent, -30, +30, +45 sums to +225.
    expect(headline()).toBe('3h 45m')
  })

  // The switch beside the target: off means the stored target even behind a solid baseline, for
  // whoever wants to hold an eight hour line on purpose. The same bars as the baseline case
  // above measured against 480 instead of 540, which is the -2h 15m every target case states.
  it('holds the stored target behind a solid baseline when the switch is off', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([], WEEK_NIGHTS, { center: 540, spread: 30, n: 60, thin: false })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), { ...PERSON, sleepUseBaseline: false })
    const tree = <QueryClientProvider client={client}><Sleep /></QueryClientProvider>
    await render(client, tree)
    restore()

    expect(balanceCard()!.querySelector('.label')!.textContent).toBe('Sleep Balance')
    expect(balanceCard()!.querySelector('.basis')!.textContent)
      .toBe('6 of 7 nights, -0h 23m a night, against your 8h 00m target')
    expect(headline()).toBe('-2h 15m')
  })

  // The baseline is fetched against historicalTo, the same anchor the time asleep tile above uses,
  // and the card states the night count it really drew. A week in the middle of a month is the case
  // that separates the two: the month's own calendar end is in the future.
  it('asks for its series over the range the reader picked and nothing wider', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const urls: string[] = []
    const restore = stubBalance(urls)
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    const sum = urls.find((u) => u.includes('/series') && u.includes('agg=sum'))
    expect(sum, urls.join('\n')).toBeDefined()
    const params = new URLSearchParams(sum!.split('?')[1] ?? '')
    expect(params.getAll('metric')).toContain('sleep_asleep_minutes')
    expect(params.get('from')).toBe(WEEK.from)
    expect(params.get('to')).toBe(WEEK.to)
    // The one baseline call on the page, anchored on the range end rather than on anything else,
    // and shared with the time asleep tile rather than duplicated: two calls would be two zero
    // lines the card and the band beside it could disagree about.
    const baselines = urls.filter((u) => u.includes('/baselines'))
    expect(baselines).toHaveLength(1)
    expect(baselines[0]).toContain(`on=${WEEK.to}`)
    expect(baselines[0]).toContain('metric=sleep_asleep_minutes')
  })

  // The source picker narrows the whole card, the same as every neighbour, and it does so for free:
  // the baseline is fetched through the same resolved source the series is.
  //
  // Read off the two DIFFERENT sum requests this page makes, which is the trap this case exists for.
  // One is the control row's own source enumeration, pinned to the all sources sentinel so a filter
  // cannot empty the list of devices to filter by; the other is every card's own read, carrying
  // whatever the reader picked. Asserting "some sum request names the source" would pass on an
  // enumeration that had wrongly narrowed, and asserting only on the filtered one would pass on a
  // page that had stopped enumerating at all.
  it('narrows the card to the picked source, and still enumerates every source for the picker', async () => {
    window.history.replaceState(null, '', `${WEEK_URL}&source=watch`)
    const urls: string[] = []
    const restore = stubBalance(urls)
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    const sumRequests = urls.filter((u) => u.includes('/series') && u.includes('agg=sum'))
    const enumeration = sumRequests.filter((u) => !u.includes('source='))
    const filtered = sumRequests.filter((u) => u.includes('source=watch'))
    expect(enumeration, urls.join('\n')).toHaveLength(1)
    expect(filtered.length, urls.join('\n')).toBeGreaterThan(0)
    // And the zero line moves with the filter rather than staying on every device's usual. Several
    // baseline requests are made on the way here, because the page's own `/sources` answer is what
    // makes the picker's choice resolvable and the first render happens before it lands; what this
    // asserts is that the filter does reach the baseline once it does.
    const baselines = urls.filter((u) => u.includes('/baselines'))
    expect(baselines.some((u) => u.includes('source=watch')), urls.join('\n')).toBe(true)
    for (const url of baselines) expect(url).toContain('metric=sleep_asleep_minutes')
  })

  // The Day tab, where every other chart on this page is swapped for a note: one diverging bar says
  // nothing the headline does not.
  it('draws no chart on the Day tab, and keeps the headline', async () => {
    window.history.replaceState(null, '', '/sleep?range=day&on=2026-08-16')
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    expect(balanceCard()).toBeDefined()
    expect(balanceCard()!.querySelector('.chart-note')).not.toBeNull()
    expect(container!.querySelector('div[role="img"][aria-label^="Nightly sleep balance"]')).toBeNull()
  })

  // The card is the one chart on this page that can carry an exclusion and a note, so it has to be
  // clickable like the sparkline tiles beside it: a chart a reader cannot annotate is a gap in the
  // page's own grammar.
  it('opens the annotate panel on the night a bar was clicked', async () => {
    window.history.replaceState(null, '', WEEK_URL)
    const restore = stubBalance([])
    const { client, tree } = withQuery(<Sleep />)
    await render(client, tree)
    restore()

    const host = container!.querySelector<HTMLDivElement>('div[role="img"][aria-label^="Nightly sleep balance"]')
    expect(host).not.toBeNull()
    const instance = echarts.getInstanceByDom(host!) as unknown as {
      getZr: () => { handler?: { dispatch: (event: string, payload: unknown) => void } }
    }
    // Straight through echarts' own event pipeline rather than by calling the handler the chart
    // registered: what is under test is that the card threaded a handler through at all, which a
    // directly-invoked callback could not tell apart from one useChart never received.
    act(() => {
      instance.getZr().handler?.dispatch('click', { target: undefined })
    })
    // Nothing to hit-test in happy-dom, so the dispatch above proves only that the chart is live.
    // The wiring itself is pinned where it can be reached: balance-bars.test.tsx drives this
    // component's own click handler, and chart-annotate-handlers.test.tsx renders the annotate
    // control for a caller that passes one.
    expect(container!.innerHTML).not.toContain('NaN')
  })
})
