// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SourceNames } from '../src/pages/settings/SourceNames.js'
import { sourceActivityKey } from '../src/data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../src/data/useSourceNames.js'
import { sourcePriorityKey } from '../src/data/useSourcePriority.js'
import type { PriorityBody } from '../src/data/useSourcePriority.js'
import { flush } from './flush.js'

// Neither `renderWithProviders`/`mockApi` nor `apps/web/test/helpers.tsx` exist in this codebase:
// every other test under this directory mounts by hand with createRoot + act and seeds a fresh
// QueryClient (settings-source-names.test.tsx, source-names.test.tsx), so this file matches that
// shape rather than the two names the task brief guessed at.

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

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const namedSource = (over: Partial<NamedSourceWithActivity> = {}): NamedSourceWithActivity => ({
  id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4',
  alias: null, name: 'My watch', kind: 'device', createdAtMs: 0,
  lastReportedDate: '2026-02-01', reportingDates: 30, medianGapDays: 1,
  status: 'reporting', reportingNow: true, continuedElsewhere: false, panelChoice: null,
  ...over,
})

/** Same shape as settings-source-names.test.tsx's own mountSection, plus the priority query. */
function mountSection(sources: NamedSourceWithActivity[], priority: PriorityBody): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  client.setQueryData(sourcePriorityKey(PERSON.personId), priority)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

const orderHeadings = (): string[] =>
  [...container!.querySelectorAll('.source-order-list li')].map((li) => li.querySelector('h4')?.textContent ?? '')

const findButton = (name: RegExp): HTMLButtonElement =>
  [...container!.querySelectorAll('button')].find((b) => name.test(b.getAttribute('aria-label') ?? '')) as HTMLButtonElement

const liveRegionText = (): string =>
  container!.querySelector('[aria-live="polite"]')?.textContent ?? ''

/**
 * Stands in for both real routes a move touches: the PUT itself, and the two GETs the mutation's
 * own onSuccess invalidates (useSetSourcePriority invalidates the whole person, per its own
 * comment, since a ranking change re-derives every card's merged rows, not only this list).
 * Answering only the PUT left those two GETs unhandled, which errored the sources query the
 * moment a move succeeded and swapped the whole card to ErrorState - wiping out the aria-live
 * region along with everything else and making a real regression (finding 4) read as a passing
 * click with nothing to show for it.
 */
function mockPriorityApi(
  sources: NamedSourceWithActivity[],
  initial: PriorityBody,
  options: { failPut?: boolean } = {},
): {
  restore: () => void
  requests: { method: string, url: string, body: unknown }[]
} {
  let priority = initial
  const requests: { method: string, url: string, body: unknown }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'GET' && url.includes('/source-priority')) return json(200, priority)
    if (method === 'GET' && url.includes('/sources')) return json(200, { items: sources })
    if (method === 'PUT' && url.includes('/source-priority')) {
      // The stale-list case named in FIX 1: a source appeared between the GET and the click, so
      // the write this list describes no longer matches what the server has.
      if (options.failPut) return json(400, { error: { kind: 'config', message: 'stale' } })
      const sourceIds = (body as { sourceIds: string[] }).sourceIds
      priority = {
        configured: sourceIds.length > 0,
        order: sourceIds.map((sourceId) => ({ sourceId, configured: true })),
      }
      return json(200, priority)
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

describe('the source ranking control', () => {
  it('lists every source best first, dormant included', () => {
    // A retired watch stays in the list. Omitting it would demote it below every live source,
    // which is why useSourcesWithActivity's full list feeds this section rather than the
    // live/dormant partition the card already uses for the name rows above it.
    mountSection(
      [
        namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
        namedSource({ id: 'old', name: 'Old watch', reportingNow: false }),
      ],
      {
        configured: false,
        order: [
          { sourceId: 'watch', configured: false },
          { sourceId: 'old', configured: false },
        ],
      },
    )
    expect(orderHeadings()).toEqual(['My watch', 'Old watch'])
  })

  it('moves a source up and sends the whole list', async () => {
    const sources = [
      namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
      namedSource({ id: 'phone', name: 'Phone', reportingNow: true }),
    ]
    const priority: PriorityBody = {
      configured: false,
      order: [
        { sourceId: 'watch', configured: false },
        { sourceId: 'phone', configured: false },
      ],
    }
    const client = mountSection(sources, priority)
    const api = mockPriorityApi(sources, priority)

    act(() => { findButton(/move phone up/i).click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    const put = api.requests.find((r) => r.method === 'PUT')
    expect(put?.url).toContain('/p/p1/source-priority')
    // The whole reordered list, not a patch: a partial send would demote every source it left out.
    expect(put?.body).toEqual({ sourceIds: ['phone', 'watch'] })
    // Buttons rather than drag were chosen for accessibility, and that choice is only honoured if
    // a screen reader is actually told what happened: neither the row moving nor a disabled state
    // flipping says anything on its own for a move in the middle of a longer list.
    expect(liveRegionText()).toBe('Phone moved to position 1 of 2')
  })

  it('falls back to its own error state when the ranking fails to load, without hiding the names above it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    client.setQueryData(sourceActivityKey(PERSON.personId), { items: [namedSource()] })
    // Left unseeded on purpose: the ranking query has nothing cached, so it reaches this stub,
    // which always answers 500 - the one query on this card given no seed and no working mock.
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { kind: 'transient', message: 'unavailable' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nProvider lng="en"><SourceNames /></I18nProvider>
        </QueryClientProvider>,
      )
    })
    await flush(client, () => container!.innerHTML)
    globalThis.fetch = original

    // The name rows above answer off their own, separately seeded query: one query failing must
    // not blank the whole card, only the section whose own query failed.
    expect(container!.querySelector('.source-name-row')).not.toBeNull()
    expect(container!.querySelector('.source-order')?.textContent).toContain('This did not load')
  })

  it('says so and announces it when a reorder is rejected', async () => {
    const sources = [
      namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
      namedSource({ id: 'phone', name: 'Phone', reportingNow: true }),
    ]
    const priority: PriorityBody = {
      configured: false,
      order: [
        { sourceId: 'watch', configured: false },
        { sourceId: 'phone', configured: false },
      ],
    }
    const client = mountSection(sources, priority)
    const api = mockPriorityApi(sources, priority, { failPut: true })

    act(() => { findButton(/move phone up/i).click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    // Both come from the client's own copy, not from the rejected response: nothing came back
    // for either one to echo.
    expect(liveRegionText()).toBe('That did not save. Try again.')
    expect(container!.querySelector('.source-order .field-error')?.textContent)
      .toBe('That did not save. Try again.')
    // The list itself is untouched: a rejected write must not reorder anything on its own.
    expect(orderHeadings()).toEqual(['My watch', 'Phone'])
  })

  it('announces a reset the same way it announces a move', async () => {
    const sources = [namedSource({ id: 'watch', name: 'My watch', reportingNow: true })]
    const priority: PriorityBody = { configured: true, order: [{ sourceId: 'watch', configured: true }] }
    const client = mountSection(sources, priority)
    const api = mockPriorityApi(sources, priority)

    const resetButton = [...container!.querySelectorAll('button')]
      .find((b) => /default order/i.test(b.textContent ?? '')) as HTMLButtonElement
    act(() => { resetButton.click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    const put = api.requests.find((r) => r.method === 'PUT')
    expect(put?.body).toEqual({ sourceIds: [] })
    expect(liveRegionText()).toBe('Order reset to the default')
  })

  it('restores focus to the button that was pressed, once it is enabled again', async () => {
    // Four sources so a move in the middle lands away from either boundary: B goes from index 1
    // to index 2, and its own down button is still short of the last position afterward.
    const sources = [
      namedSource({ id: 'a1', name: 'A', reportingNow: true }),
      namedSource({ id: 'a2', name: 'B', reportingNow: true }),
      namedSource({ id: 'a3', name: 'C', reportingNow: true }),
      namedSource({ id: 'a4', name: 'D', reportingNow: true }),
    ]
    const priority: PriorityBody = {
      configured: false,
      order: sources.map((s) => ({ sourceId: s.id, configured: false })),
    }
    const client = mountSection(sources, priority)
    const api = mockPriorityApi(sources, priority)

    const button = findButton(/move b down/i)
    act(() => { button.click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    // The whole point of buttons over drag is a screen reader driving them one press at a time;
    // losing focus to <body> after every press, the way a disabled focused element does in every
    // browser, would defeat that on each activation.
    expect(document.activeElement).toBe(button)
    expect(button.disabled).toBe(false)
  })

  it('moves focus to the row\'s other button when the pressed one lands at a boundary', async () => {
    const sources = [
      namedSource({ id: 'watch', name: 'My watch', reportingNow: true }),
      namedSource({ id: 'phone', name: 'Phone', reportingNow: true }),
    ]
    const priority: PriorityBody = {
      configured: false,
      order: [
        { sourceId: 'watch', configured: false },
        { sourceId: 'phone', configured: false },
      ],
    }
    const client = mountSection(sources, priority)
    const api = mockPriorityApi(sources, priority)

    act(() => { findButton(/move phone up/i).click() })
    await flush(client, () => container!.innerHTML)
    api.restore()

    // Phone is first now, so its own up button is the one this press just disabled by reaching
    // the boundary. Focus goes to its down button rather than nowhere.
    expect(findButton(/move phone up/i).disabled).toBe(true)
    expect(document.activeElement).toBe(findButton(/move phone down/i))
  })
})
