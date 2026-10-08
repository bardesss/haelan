// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Dashboard } from '../src/pages/Dashboard.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import type { Session } from '../src/auth/session.js'
import type { Glance } from '../src/data/useGlance.js'
import { glanceBody } from './glanceFixture.js'
import { flush } from './flush.js'

// The one chart in the app that names a single reading: the dashboard day's heart rate trace. It
// opens the annotate panel on that reading (a sample target), as Recovery's Day tab trace did
// before the Recovery overview sent its Day tab here. The trace draws for real; echarts.init is
// tapped (pages.test.tsx's own device) only to reach the click handler the chart registered, since
// zrender cannot resolve a coordinate against happy-dom's SVG.
type Captured = { onClick?: (event: unknown) => void, dom?: Element }
const { captured } = vi.hoisted(() => ({ captured: [] as Captured[] }))
vi.mock('echarts/core', async (importOriginal) => {
  const actual = (await importOriginal()) as { init: (...args: unknown[]) => { on: (...a: unknown[]) => unknown } } & Record<string, unknown>
  return {
    ...actual,
    init: (...args: unknown[]) => {
      const chart = actual.init(...args)
      const entry: Captured = { dom: args[0] as Element | undefined }
      captured.push(entry)
      const on = chart.on.bind(chart)
      chart.on = (name: unknown, handler: unknown) => {
        if (name === 'click') entry.onClick = handler as (event: unknown) => void
        return on(name, handler)
      }
      return chart
    },
  }
})

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let restore: () => void = () => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  captured.length = 0
  window.history.replaceState(null, '', '/')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 40))
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root?.unmount() })
  restore()
  container?.remove()
  container = null
  root = null
})

async function mountWith(body: Glance): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/glance/calendar')) return json({ month: '2026-09', firstDay: '2026-09-01', days: [] })
    if (url.includes('/glance')) return json(body)
    if (url.includes('/sources')) return json({ items: [] })
    return json({})
  }) as typeof fetch
  restore = () => { globalThis.fetch = original }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => { root?.render(<I18nProvider lng="en"><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></I18nProvider>) })
  await flush(client, () => container!.innerHTML)
}

/** The trace's host and its captured click handler, found by the trace's own accessible name. */
function trace(): { host: Element, click: (event: unknown) => void } {
  const host = container!.querySelector('[role="img"][aria-label="Heart rate today"]')
  if (host === null) throw new Error('no heart rate trace on the dashboard')
  const entry = captured.find((c) => c.dom === host)
  if (entry?.onClick === undefined) throw new Error('the heart rate trace registered no click')
  return { host, click: entry.onClick }
}

describe('the dashboard day\'s heart rate trace', () => {
  it('lists each reading with its value, an excluded one marked, in its table', async () => {
    const body = glanceBody()
    const points = body.day.heartRate.points.map((point, index) => (index === 1 ? { ...point, excluded: true } : point))
    await mountWith({ ...body, day: { ...body.day, heartRate: { ...body.day.heartRate, points } } })
    const table = trace().host.closest('figure')!.querySelector('table')!
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    // 08:00 and 11:38 in Amsterdam; mean 62 kept, the second marked excluded (a sample override's
    // reason lives on the corrections list, not on the point: IntradayHeartRate's own table comment).
    expect(rows.map((row) => [row[0], row[3], row[5]])).toEqual([['08:00', '62', ''], ['11:38', '71', 'excluded']])
  })

  it('opens the annotate panel on the tapped reading, with correct offered for a single row', async () => {
    await mountWith(glanceBody())
    // Source 0's mean line is series 2 (IntradayHeartRate's pointsBySeriesIndex); dataIndex 1 is the
    // 09:38 UTC reading.
    act(() => { trace().click({ componentType: 'series', seriesIndex: 2, dataIndex: 1 }) })
    const dialog = document.querySelector('.annotate-panel')!
    expect(dialog.querySelector('h2')?.textContent).toBe('heart_rate on 2026-09-23')
    expect([...dialog.querySelectorAll('.segment')].map((segment) => segment.textContent))
      .toEqual(['Exclude', 'Correct', 'Add a note', 'Add an event'])
  })
})
