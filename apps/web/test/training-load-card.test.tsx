// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { CHRONIC_DAYS, MIN_WORN_CHRONIC } from '@haelan/core/training-load'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { TrainingLoadCard } from '../src/pages/activity/TrainingLoadCard.js'
import { I18nProvider } from '../src/i18n/index.js'
import { flush } from './flush.js'

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
  vi.restoreAllMocks()
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const ON = '2026-09-13'

function dayBefore(offset: number): string {
  return new Date(Date.parse(`${ON}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10)
}

/** `days` worn days back from ON, each carrying `load`. */
function stub(days: number, load: number | ((offset: number) => number)): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    urls.push(String(input))
    const points = Array.from({ length: days }, (_, offset) => ({
      localDate: dayBefore(offset),
      value: typeof load === 'function' ? load(offset) : load,
      coverage: null, source: 'merged', sourceMix: null, updatedAtMs: null,
    }))
    return Promise.resolve(new Response(
      JSON.stringify({ cardio_load_edwards: { points, reduction: null } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
  }))
  return { urls }
}

async function mount(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <I18nProvider><TrainingLoadCard on={ON} source="merged" /></I18nProvider>
    </QueryClientProvider>
  )
  act(() => { root?.render(tree) })
  await flush(client, () => container!.innerHTML)
  return client
}

describe('the training load card', () => {
  // The rule this reader states in its own header, asserted rather than trusted: a point budget is
  // an argument about display, and a load that moved when a chart's budget moved would not be
  // measuring anything. This is the assertion that fails if anyone adds `points` to the request.
  it('asks for the series unthinned, over exactly the chronic window', async () => {
    const { urls } = stub(CHRONIC_DAYS, 10)
    await mount()
    const call = urls.find((url) => url.includes('/series'))
    expect(call).toBeDefined()
    expect(call).not.toContain('points=')
    expect(call).toContain(`from=${dayBefore(CHRONIC_DAYS - 1)}`)
    expect(call).toContain(`to=${ON}`)
  })

  it('reads a steady month as a ratio of one against its own usual week', async () => {
    stub(CHRONIC_DAYS, 10)
    await mount()
    expect(container!.textContent).toContain('1.00x your usual')
    // Weekly equivalent load: ten a day, seven days.
    expect(container!.textContent).toContain('70')
  })

  it('says how far off it is rather than going blank below the floor', async () => {
    stub(MIN_WORN_CHRONIC - 1, 10)
    await mount()
    expect(container!.textContent).toContain('Not enough worn days')
    expect(container!.textContent).toContain(String(MIN_WORN_CHRONIC))
    expect(container!.textContent).toContain(String(MIN_WORN_CHRONIC - 1))
  })

  it('shows the loads but no ratio when the whole window was worn and sedentary', async () => {
    stub(CHRONIC_DAYS, 0)
    await mount()
    expect(container!.textContent).toContain('No usual load')
    expect(container!.textContent).not.toContain('x your usual')
  })
})
