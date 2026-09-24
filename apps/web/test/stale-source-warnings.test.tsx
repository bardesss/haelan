// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Activity } from '../src/pages/Activity.js'
import { Recovery } from '../src/pages/Recovery.js'
import { Sleep } from '../src/pages/Sleep.js'
import { Health } from '../src/pages/Health.js'
import { Weight } from '../src/pages/Weight.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { I18nProvider } from '../src/i18n/index.js'
import { seriesPoint, insightBody } from './metricCoverage.js'
import { flush } from './flush.js'

/**
 * A source that has gone quiet is announced in one place: the status panel beside the person's
 * name, with what it stopped sending (status-panel.test.tsx). The range pages used to announce it
 * twice more - a triangle beside the title of every card the source fed, and a "Stopped reporting
 * during this range" line under the control row - and this file holds them to saying nothing.
 *
 * The household below is built so that both old warnings would fire. The watch is stale on the
 * server's own verdict (`/sources?activity=1`, which the cards' triangles read), it last reported
 * on 25 July, inside every page's range, and it feeds every point through `sourceMix`. It also
 * reported on 25 dates in the range and then fell silent for 37, which is what the control row's
 * line judged from the points alone. Synthetic throughout.
 */

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const DAYS = Array.from({ length: 25 }, (_, i) =>
  new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10))

const WATCH = {
  id: 'watch', name: 'My watch', kind: 'device', createdAtMs: 0, displayName: 'My watch', alias: null,
  lastReportedDate: '2026-07-25', reportingDates: 25, medianGapDays: 1,
  status: 'stale', reportingNow: false, continuedElsewhere: false, panelChoice: null,
}

let restore: () => void = () => {}
beforeAll(() => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/api/sync/status')) {
      return json({
        running: false, lastFinishedAtMs: Date.now() - 600_000,
        rebuild: { quarantined: false, droppedPages: 0, lastError: null, drops: [] },
      })
    }
    if (url.includes('/overrides') || url.includes('/notes') || url.includes('/events')) return json({ items: [] })
    if (url.includes('/sources')) return json({ items: [WATCH] })
    if (url.includes('/series')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '')
      const from = params.get('from') ?? ''
      const to = params.get('to') ?? ''
      const body: Record<string, unknown> = {}
      for (const metric of params.getAll('metric')) {
        body[metric] = {
          points: DAYS.filter((date) => date >= from && date <= to).map((date, i) => seriesPoint(
            metric, date, metric.startsWith('sleep_') ? 420 + i : 60 + i,
            { sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]), updatedAtMs: null },
          )),
          reduction: null,
        }
      }
      return json(body)
    }
    if (url.includes('/intraday')) return json({ points: [], reduction: null })
    if (url.includes('/sleep/nights')) return json({ items: [], cursor: null })
    if (url.includes('/insights')) return json(insightBody(url))
    if (url.includes('/trend')) return json({ points: [] })
    return json({ baseline: { center: 62, spread: 4, n: 40, thin: false } })
  }) as typeof fetch
  restore = () => { globalThis.fetch = original }
})
afterAll(() => restore())

async function settled(Page: () => ReactNode, path: string): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  window.history.replaceState(null, '', `${path}?range=3months&on=2026-08-31`)
  act(() => { root.render(<I18nProvider lng="en"><QueryClientProvider client={client}><Page /></QueryClientProvider></I18nProvider>) })
  await flush(client, () => container.innerHTML)
  // Detached from the document but still holding the settled tree: the assertions read markup,
  // and an unmounted root would have emptied it.
  const snapshot = container.cloneNode(true) as HTMLDivElement
  act(() => { root.unmount() })
  container.remove()
  return snapshot
}

describe.each([
  ['Activity', Activity, '/activity'],
  ['Recovery', Recovery, '/recovery'],
  ['Sleep', Sleep, '/sleep'],
  ['Health', Health, '/health'],
  ['Weight', Weight, '/weight'],
] as const)('%s, with a source that went quiet inside the range', (_name, Page, path) => {
  let page: HTMLDivElement
  beforeAll(async () => { page = await settled(Page, path) })

  it('rendered cards fed by the quiet source, so the checks below have something to look at', () => {
    expect(page.querySelectorAll('.card').length).toBeGreaterThan(0)
    expect(page.querySelectorAll('.card .label').length).toBeGreaterThan(0)
  })

  it('puts nothing beside any card title', () => {
    // A title is its words and nothing else: the triangle was an element inside the label.
    const decorated = [...page.querySelectorAll('.card .label')].filter((label) => label.children.length > 0)
    expect(decorated.map((label) => label.outerHTML)).toEqual([])
  })

  it('says nothing about it under the control row', () => {
    // The row's only paragraph is the trend note every one of these pages asks for.
    const controls = page.querySelector('.controls')!
    expect([...controls.querySelectorAll('p')].map((p) => p.className)).toEqual(['control-row-note'])
    expect(page.textContent).not.toMatch(/stopped reporting|has not reported/i)
  })
})
