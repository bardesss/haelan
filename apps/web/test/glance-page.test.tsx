// @vitest-environment happy-dom
// happy-dom for the page-level cases at the foot of this file, which mount the Dashboard for real
// and let its query settle; the card-level cases above them still render to static markup, which
// needs no DOM and is unaffected by one being present.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GlanceCard } from '../src/pages/dashboard/GlanceCard.js'
import { Dashboard } from '../src/pages/Dashboard.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { Session } from '../src/auth/session.js'
import type { Glance, GlanceFigure, GlanceStaleSource } from '../src/data/useGlance.js'
import { glanceBody, glanceFigure } from './glanceFixture.js'
import { flush } from './flush.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same setup every other file mounting a chart for real carries.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const TODAY = '2026-09-23'

function figure(over: Partial<GlanceFigure> = {}): GlanceFigure {
  return {
    metric: 'steps', value: 4820, unit: 'count', baseline: { center: 8700, low: 8000, high: 9500, thin: false },
    asOfDate: TODAY, asOfMs: Date.UTC(2026, 8, 23, 9, 32), partial: false, staleSources: [],
    strip: [
      { localDate: '2026-09-17', value: 8900 }, { localDate: '2026-09-18', value: 7400 },
      { localDate: '2026-09-19', value: 10100 }, { localDate: '2026-09-20', value: 8300 },
      { localDate: '2026-09-21', value: 9700 }, { localDate: '2026-09-22', value: 8800 },
      { localDate: '2026-09-23', value: 4820 },
    ],
    ...over,
  }
}

const WATCH: GlanceStaleSource = { sourceId: 's1', name: 'My watch', lastReportedDate: '2026-09-10', medianGapDays: 1 }

type Props = ComponentProps<typeof GlanceCard>

function props(over: Partial<Props> = {}): Props {
  return {
    title: 'Today', subtitle: 'so far',
    headline: { label: 'Steps', figure: figure() },
    emptyLine: 'Nothing recorded yet today.',
    secondary: [],
    stripLabel: 'Steps, last 7 days', stripCaption: 'last 7 days',
    link: { to: '/activity', text: 'View activity' },
    today: TODAY, timezone: 'Europe/Amsterdam',
    ...over,
  }
}

function render(over: Partial<Props> = {}): string {
  return renderToStaticMarkup(<I18nProvider lng="en"><GlanceCard {...props(over)} /></I18nProvider>)
}

describe('GlanceCard', () => {
  it('prints the headline label, its formatted value, the usual line and the as-of line', () => {
    const html = render()
    expect(html).toContain('<h2 class="glance-card-title"><strong>Today</strong> <span>so far</span></h2>')
    expect(html).toContain('<span class="label">Steps</span>')
    expect(html).toContain('<div class="value">4,820</div>')
    expect(html).toContain('<p class="basis">below your usual 8,000 – 9,500</p>')
    // 09:32 UTC is 11:32 in Amsterdam: the as-of line reads the person's zone, not the machine's.
    expect(html).toContain('<p class="glance-asof">as of 11:32</p>')
  })

  it('prints the unit the page hands it beside the value', () => {
    const html = render({ headline: { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62 }) } })
    expect(html).toContain('<div class="value">62<span class="glance-unit"> bpm</span></div>')
  })

  it('prints the strip with its label and caption under a headline', () => {
    const html = render()
    expect(html).toContain('aria-label="Steps, last 7 days"')
    // The caption is also the strip's accessible description, so the chart host points at it.
    const captionId = html.match(/<p class="glance-asof" id="([^"]+)">last 7 days<\/p>/)?.[1]
    expect(captionId).toBeDefined()
    expect(html).toContain(`aria-describedby="${captionId}"`)
  })

  it('prints the empty line and no strip for a null headline', () => {
    const html = render({ headline: null })
    expect(html).toContain('<p class="glance-empty">Nothing recorded yet today.</p>')
    expect(html).not.toContain('Steps, last 7 days')
    expect(html).not.toContain('last 7 days')
    expect(html).not.toContain('class="value"')
  })

  it('says there is no reading yet for a headline whose value is still null', () => {
    const html = render({ headline: { label: 'Steps', figure: figure({ value: null, asOfDate: null, asOfMs: null }) } })
    expect(html).toContain('<p class="glance-empty">No reading yet</p>')
    expect(html).not.toContain('class="value"')
  })

  it('prints the secondary pairs in the order given, each with its usual line', () => {
    const html = render({
      secondary: [
        { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62,
          baseline: { center: 56, low: 52, high: 60, thin: false } }) },
        { label: 'HRV', unit: 'ms', figure: figure({ metric: 'daily_hrv', value: 51, baseline: null }) },
        { label: 'Efficiency', figure: figure({ metric: 'sleep_efficiency', value: null }) },
      ],
    })
    expect(html).toContain(
      '<div class="glance-mini">'
      + '<div><span class="label">Resting HR</span><b>62 bpm</b><em>above your usual 52 – 60</em></div>'
      + '<div><span class="label">HRV</span><b>51 ms</b></div>'
      + '<div><span class="label">Efficiency</span><b>No reading yet</b></div>'
      + '</div>',
    )
  })

  // Core falls back to yesterday separately for the index, resting heart rate and HRV, so one card
  // can hold figures from two days, and the card's one subtitle cannot speak for both.
  it('gives a secondary figure its own day when it is not the headline\'s day', () => {
    const html = render({
      headline: { label: 'Recovery index', figure: figure({ metric: 'recovery_index', value: 42, baseline: null, asOfDate: '2026-09-22', asOfMs: null }) },
      secondary: [
        { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62, baseline: null, asOfDate: TODAY, asOfMs: null }) },
        { label: 'HRV', unit: 'ms', figure: figure({ metric: 'daily_hrv', value: 51, baseline: null, asOfDate: '2026-09-22', asOfMs: null }) },
      ],
    })
    expect(html).toContain('<div><span class="label">Resting HR</span><b>62 bpm</b><span class="glance-asof">today</span></div>')
    // Same day as the headline: the headline's own as-of line already says it.
    expect(html).toContain('<div><span class="label">HRV</span><b>51 ms</b></div>')
  })

  it('names each secondary figure\'s day when the headline has no value to name one', () => {
    const html = render({
      headline: { label: 'Recovery index', figure: figure({ metric: 'recovery_index', value: null, asOfDate: null, asOfMs: null }) },
      secondary: [{ label: 'HRV', unit: 'ms', figure: figure({ metric: 'daily_hrv', value: 51, baseline: null, asOfDate: '2026-09-22', asOfMs: null }) }],
    })
    expect(html).toContain('<div><span class="label">HRV</span><b>51 ms</b><span class="glance-asof">yesterday</span></div>')
  })

  it('prints the figure\'s own usual wording when it has no baseline to compare', () => {
    const html = render({
      headline: { label: 'Recovery index', usual: 'Around your usual', figure: figure({ metric: 'recovery_index', value: 42, baseline: null }) },
    })
    expect(html).toContain('<div class="value">42</div><p class="basis">Around your usual</p>')
  })

  it('puts one source warning beside the title for a stale source on any shown figure, deduplicated', () => {
    const html = render({
      headline: { label: 'Steps', figure: figure({ staleSources: [WATCH] }) },
      secondary: [{ label: 'Active minutes', figure: figure({ metric: 'active_minutes', value: 18, staleSources: [WATCH] }) }],
    })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
    const sentence = 'My watch has not reported since Sep 10, 2026; it usually reports daily.'
    expect(html).toContain(`<span class="source-warning" title="${sentence}">`)
    // Right after the heading, on its row, so the mark sits beside the column's name rather than
    // floating in the card, and outside the h2 so its sentence is not part of the heading's name.
    expect(html).toMatch(/<div class="glance-card-head"><h2 class="glance-card-title"><strong>Today<\/strong> <span>so far<\/span><\/h2><span class="source-warning"/)
  })

  it('keeps the warning\'s sentence out of the heading\'s accessible name', () => {
    const host = document.createElement('div')
    host.innerHTML = render({ headline: { label: 'Steps', figure: figure({ staleSources: [WATCH] }) } })
    expect(host.querySelector('.source-warning')).not.toBeNull()
    expect(host.querySelector('h2')?.textContent).toBe('Today so far')
  })

  it('prints no headline as-of line when the subtitle already names the day', () => {
    const html = render({
      subtitle: 'today', dayInSubtitle: true,
      headline: { label: 'Recovery index', figure: figure({ metric: 'recovery_index', value: 42, baseline: null, asOfMs: null }) },
      secondary: [
        { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62, baseline: null, asOfMs: null }) },
        { label: 'HRV', unit: 'ms', figure: figure({ metric: 'daily_hrv', value: 51, baseline: null, asOfDate: '2026-09-22', asOfMs: null }) },
      ],
    })
    expect(html).toContain('<div class="value">42</div></div>')
    // A pair on the headline's day is covered by the subtitle; one on another day still names it.
    expect(html).toContain('<div><span class="label">Resting HR</span><b>62 bpm</b></div>')
    expect(html).toContain('<div><span class="label">HRV</span><b>51 ms</b><span class="glance-asof">yesterday</span></div>')
  })

  it('counts the chart\'s own stale sources toward the warning', () => {
    const html = render({ chartStaleSources: [WATCH] })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
  })

  it('draws no warning when nothing shown is stale', () => {
    expect(render()).not.toContain('source-warning')
  })

  it('links to the given page with the given text', () => {
    expect(render()).toContain('<a href="/activity" class="card-link">View activity</a>')
  })

  it('prints the note and the chart slot when given', () => {
    const html = render({ note: 'Breathing rate 17.2, above your usual', chart: <div id="the-chart" /> })
    expect(html).toContain('<p class="glance-note">Breathing rate 17.2, above your usual</p>')
    expect(html).toContain('<div id="the-chart"></div>')
  })

  it('never says a partial figure is below its usual', () => {
    const html = render({ headline: { label: 'Steps', figure: figure({ value: 2100, partial: true }) } })
    expect(html).toContain('so far; your usual day 8,700')
    expect(html).not.toContain('below')
  })
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

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

/**
 * Answers /glance with `body` (or a 500 when `status` says so), /sources with one named watch for
 * the heart rate trace's legend, and records every URL asked for, so a test can hold the page to
 * the one read it claims to make.
 */
function stubFetch(body: Glance, seen: string[], status = 200): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const json = (value: unknown, code = 200) =>
      new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
    if (url.includes('/glance')) return status === 200 ? json(body) : json({ error: 'internal' }, status)
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function mountPage(body: Glance = glanceBody(), o: { lng?: string, status?: number } = {}): Promise<{ seen: string[], client: QueryClient, restore: () => void }> {
  const seen: string[] = []
  const restore = stubFetch(body, seen, o.status)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  const tree: ReactNode = (
    <I18nProvider lng={o.lng ?? 'en'}><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>
  )
  act(() => { root!.render(tree) })
  await flush(client, () => container!.innerHTML)
  return { seen, client, restore }
}

const cards = (): Element[] => [...container!.querySelectorAll('.glance-card')]
const titles = (): string[] => [...container!.querySelectorAll('.glance-card-title strong')].map((el) => el.textContent ?? '')

describe('the glance Dashboard', () => {
  it('draws three cards in order, one per question', async () => {
    const { restore } = await mountPage()
    try {
      expect(titles()).toEqual(['Last night', 'Recovery', 'Today'])
      expect(container!.querySelector('h1')?.textContent).toBe('Dashboard')
    } finally { restore() }
  })

  it('has no control row', async () => {
    const { restore } = await mountPage()
    try {
      expect(container!.querySelector('.controls')).toBeNull()
    } finally { restore() }
  })

  it('links the sleep card to the night it draws, and draws that night\'s hypnogram', async () => {
    const { restore } = await mountPage()
    try {
      const sleep = cards()[0]!
      expect(sleep.querySelector('a.card-link')?.getAttribute('href')).toBe('/sleep/night/2026-09-23')
      const host = sleep.querySelector('[role="img"][aria-label^="Sleep stages through the night of"]')
      expect(host).not.toBeNull()
      // The bed label under the hypnogram is the night's own start in its own offset, 21:10 UTC + 2h.
      expect(sleep.textContent).toContain('Bed 23:10')
      // The Bed pair reads the stored bedtime, -50 minutes from the wake date's midnight.
      const bedPair = [...sleep.querySelectorAll('.glance-mini > div')].find((d) => d.querySelector('.label')?.textContent === 'Bed')
      expect(bedPair?.querySelector('b')?.textContent).toBe('23:10')
      // The night spans two dates, and the subtitle names both.
      expect(sleep.querySelector('.glance-card-title span')?.textContent).toMatch(/22.*23/)
    } finally { restore() }
  })

  it('collapses the sleep card to one line when there is no night, and links to Sleep instead', async () => {
    const { restore } = await mountPage({ ...glanceBody(), sleep: null })
    try {
      const sleep = cards()[0]!
      expect(sleep.querySelector('.glance-empty')?.textContent).toBe('No night recorded in the last day and a half.')
      expect(sleep.querySelector('a.card-link')?.getAttribute('href')).toBe('/sleep')
      expect(sleep.querySelector('[role="img"]')).toBeNull()
    } finally { restore() }
  })

  it('shows the breathing rate note only on a day the payload carries one', async () => {
    const plain = await mountPage()
    try {
      expect(cards()[1]!.querySelector('.glance-note')).toBeNull()
    } finally { plain.restore() }
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const body = glanceBody()
    body.recovery.respiratoryRate = glanceFigure({ metric: 'respiratory_rate', value: 17.2, unit: 'breaths_per_minute' })
    const elevated = await mountPage(body)
    try {
      expect(cards()[1]!.querySelector('.glance-note')?.textContent).toMatch(/^Breathing rate 17\.2 .*, above your usual$/)
    } finally { elevated.restore() }
  })

  // The fixture's index carries baseline: null, as core always sends it, so the only line that can
  // appear under the number is the band.
  it('states the recovery band under the index', async () => {
    const { restore } = await mountPage()
    try {
      const recovery = cards()[1]!
      expect(recovery.querySelector('.value')?.textContent).toBe('42')
      expect(recovery.querySelector('.value + .basis')?.textContent).toBe('Around your usual')
    } finally { restore() }
  })

  it('says it has nothing yet, once, when the glance holds no value at all', async () => {
    const body = glanceBody()
    const empty = (f: GlanceFigure): GlanceFigure => ({ ...f, value: null, asOfDate: null, asOfMs: null, strip: [] })
    const nothing: Glance = {
      ...body,
      sleep: null,
      recovery: {
        ...body.recovery, band: null, missing: ['resting_heart_rate'],
        index: empty(body.recovery.index), restingHeartRate: empty(body.recovery.restingHeartRate), hrv: empty(body.recovery.hrv),
        respiratoryRate: null,
      },
      day: {
        steps: empty(body.day.steps), activeMinutes: empty(body.day.activeMinutes),
        heartRate: { points: [], asOfMs: null, staleSources: [] },
      },
    }
    const { restore } = await mountPage(nothing)
    try {
      expect(cards()).toHaveLength(0)
      expect(container!.querySelector('h1')?.textContent).toBe('Dashboard')
      expect(container!.querySelector('.empty')?.textContent)
        .toBe('Nothing here yetOnce a sync brings in a night or a day, it shows up here.')
      // Not the not_synced words, which mean the person turned a data type off.
      expect(container!.textContent).not.toContain('Not being synced')
    } finally { restore() }
  })

  // One figure with a value is enough for the cards: the empty state is for a page with nothing.
  it('keeps the cards when a single figure has a value', async () => {
    const body = glanceBody()
    const empty = (f: GlanceFigure): GlanceFigure => ({ ...f, value: null })
    const oneFigure: Glance = {
      ...body,
      sleep: null,
      recovery: { ...body.recovery, index: empty(body.recovery.index), restingHeartRate: empty(body.recovery.restingHeartRate), hrv: empty(body.recovery.hrv) },
      day: { ...body.day, steps: empty(body.day.steps), heartRate: { points: [], asOfMs: null, staleSources: [] } },
    }
    const { restore } = await mountPage(oneFigure)
    try {
      expect(cards()).toHaveLength(3)
    } finally { restore() }
  })

  // Once: the card's empty line, not a "No reading yet" headline with the same fact again as a note.
  it('says why recovery is unscored once, and still shows the resting heart rate and HRV', async () => {
    const body = glanceBody()
    body.recovery.index = glanceFigure({ metric: 'recovery_index', value: null, unit: 'score', asOfDate: null })
    const { restore } = await mountPage(body)
    try {
      const recovery = cards()[1]!
      expect(recovery.textContent!.split('Not enough readings to score yet.')).toHaveLength(2)
      expect(recovery.querySelector('.glance-empty')?.textContent).toBe('Not enough readings to score yet.')
      expect(recovery.querySelector('.glance-note')).toBeNull()
      expect(recovery.textContent).not.toContain('No reading yet')
      const pairs = [...recovery.querySelectorAll('.glance-mini > div')].map((d) => [d.querySelector('.label')?.textContent, d.querySelector('b')?.textContent])
      expect(pairs).toEqual([['Resting HR', '62 bpm'], ['HRV', '51 ms']])
    } finally { restore() }
  })

  // The subtitle names the day (Recovery's "today") or the night (Sleep's dates), so the headline
  // under it does not name it again.
  it('names each card\'s day once, in the subtitle', async () => {
    const { restore } = await mountPage()
    try {
      const [sleep, recovery, today] = cards()
      expect(recovery!.querySelector('.glance-card-title span')?.textContent).toBe('today')
      expect(recovery!.querySelector('.value ~ .glance-asof')).toBeNull()
      expect(recovery!.textContent!.split('today')).toHaveLength(2)
      // Not the card's whole text: the chart's own screen-reader description names the night too.
      expect(sleep!.querySelector('.value ~ .glance-asof')).toBeNull()
      expect([...sleep!.querySelectorAll('.glance-asof')].map((p) => p.textContent)).toEqual(['last 7 nights'])
      // Today's subtitle is "so far", which names no moment, so its as-of time stays.
      expect(today!.querySelector('.value ~ .glance-asof')?.textContent).toBe('as of 11:32')
    } finally { restore() }
  })

  it('keeps a recovery pair\'s own day when it is not the index\'s', async () => {
    const body = glanceBody()
    body.recovery.hrv = { ...body.recovery.hrv, asOfDate: '2026-09-22' }
    const { restore } = await mountPage(body)
    try {
      const hrv = [...cards()[1]!.querySelectorAll('.glance-mini > div')].find((d) => d.querySelector('.label')?.textContent === 'HRV')
      expect(hrv?.querySelector('.glance-asof')?.textContent).toBe('yesterday')
    } finally { restore() }
  })

  // The glance's Sleep column prints the asleep total already; the per-stage row under the chart
  // made it much taller than its neighbours, and the awake note explains a card the glance lacks.
  it('draws the hypnogram without its stage totals row', async () => {
    const { restore } = await mountPage()
    try {
      const sleep = cards()[0]!
      expect(sleep.querySelector('[role="img"][aria-label^="Sleep stages"]')).not.toBeNull()
      expect(sleep.querySelector('.hypnogram-totals')).toBeNull()
      expect(sleep.querySelector('.hypnogram-absence')).toBeNull()
    } finally { restore() }
  })

  // A classic night (ASLEEP and RESTLESS only) draws an empty chart, which must still say why.
  it('still says an unstaged night was not staged', async () => {
    const body = glanceBody()
    body.sleep = { ...body.sleep!, segments: body.sleep!.segments.map((s) => ({ ...s, stage: 'ASLEEP' })) }
    const { restore } = await mountPage(body)
    try {
      const sleep = cards()[0]!
      expect(sleep.querySelector('.hypnogram-totals')).toBeNull()
      expect(sleep.querySelector('.hypnogram-absence')?.textContent).toBe('This night was not staged, so there is nothing to total.')
    } finally { restore() }
  })

  it('puts a stale source on steps beside the Today card\'s title, and nowhere else', async () => {
    const body = glanceBody()
    body.day.steps = { ...body.day.steps, staleSources: [{ sourceId: 's1', name: 'My watch', lastReportedDate: '2026-09-10', medianGapDays: 1 }] }
    const { restore } = await mountPage(body)
    try {
      const [sleep, recovery, today] = cards()
      expect(sleep!.querySelector('.source-warning')).toBeNull()
      expect(recovery!.querySelector('.source-warning')).toBeNull()
      expect(today!.querySelector('.glance-card-head > .source-warning')?.getAttribute('title'))
        .toBe('My watch has not reported since Sep 10, 2026; it usually reports daily.')
    } finally { restore() }
  })

  it('states its span from the heart rate\'s last reading, in the person\'s zone', async () => {
    const { restore } = await mountPage()
    try {
      // 09:38 UTC is 11:38 in Amsterdam; the steps' own 09:32 must not be the one it reads.
      expect(container!.querySelector('.all-time-span')?.textContent).toBe('Last night, and today until 11:38')
    } finally { restore() }
  })

  it('falls back to the steps\' last reading, and to no time at all', async () => {
    const body = glanceBody()
    body.day.heartRate = { ...body.day.heartRate, asOfMs: null }
    const stepsOnly = await mountPage(body)
    try {
      expect(container!.querySelector('.all-time-span')?.textContent).toBe('Last night, and today until 11:32')
    } finally { stepsOnly.restore() }
    act(() => { root!.unmount() })
    root = createRoot(container!)

    const none = glanceBody()
    none.day.heartRate = { ...none.day.heartRate, asOfMs: null }
    none.day.steps = { ...none.day.steps, asOfMs: null }
    const neither = await mountPage(none)
    try {
      expect(container!.querySelector('.all-time-span')?.textContent).toBe('Last night, and today so far')
    } finally { neither.restore() }
  })

  // The locale parity guard compares key sets and never renders, so the Dutch page is rendered
  // once here to see that it reads as Dutch.
  it('renders in Dutch', async () => {
    const { restore } = await mountPage(glanceBody(), { lng: 'nl' })
    try {
      expect(titles()).toEqual(['Afgelopen nacht', 'Herstel', 'Vandaag'])
      expect(container!.querySelector('.all-time-span')?.textContent).toBe('Afgelopen nacht, en vandaag tot 11:38')
      expect(container!.textContent).toContain('Stappen')
      expect(container!.textContent).not.toMatch(/\bglance\.[a-zA-Z]/)
      // One usual line and one as-of line, read whole: the parity guard never renders, and these
      // once ended on a bare adjective ("boven je gebruikelijke 52 – 60") with every test green.
      const [, recovery, today] = cards()
      const rhr = [...recovery!.querySelectorAll('.glance-mini > div')].find((d) => d.querySelector('.label')?.textContent === 'Rusthartslag')
      expect(rhr?.querySelector('em')?.textContent).toBe('boven je gebruikelijke bereik 52 – 60')
      expect(today!.querySelector('.value ~ .glance-asof')?.textContent).toBe('bijgewerkt om 11:32')
    } finally { restore() }
  })

  it('shows the error state with a retry that asks again', async () => {
    const { seen, client, restore } = await mountPage(glanceBody(), { status: 500 })
    try {
      expect(cards()).toHaveLength(0)
      const retry = container!.querySelector('button')
      expect(retry?.textContent).toBe('Try again')
      act(() => { retry!.click() })
      await flush(client, () => container!.innerHTML)
      expect(seen.filter((u) => u.includes('/glance'))).toHaveLength(2)
    } finally { restore() }
  })

  // Carried over from the old dashboard-cards.test.tsx with the same intent: the page draws from
  // the payload, never from the July fixtures module, which Dashboard.tsx's own Stage comment cites.
  it('does not import the fixtures', () => {
    expect(readFileSync('apps/web/src/pages/Dashboard.tsx', 'utf8')).not.toContain('fixtures/july')
  })

  // One read: the old Dashboard issued a dozen (series per agg, insights, nights, annotations).
  // /sources is the heart rate trace's own legend lookup (IntradayHeartRate's useSourceNames), a
  // name table rather than a read of anyone's data, so it is the one other request allowed.
  it('makes exactly one data request, to /glance', async () => {
    const { seen, restore } = await mountPage()
    try {
      const data = seen.filter((u) => !u.includes('/sources') && !u.includes('/api/auth/me'))
      expect(data).toEqual(['/api/v1/p/p1/glance'])
    } finally { restore() }
  })
})
