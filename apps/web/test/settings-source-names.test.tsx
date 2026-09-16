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
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Same shape as source-names.test.tsx's own mount: a fresh QueryClient per test, the session
 * pre-seeded so useSession() never has to fetch, and the sources query pre-seeded under the same
 * key the card reads (sourceActivityKey, a child of sourceNamesKey so the two mutations'
 * prefix invalidation still reaches it). An unseeded
 * query would reach the real network in this environment rather than merely running slow (see
 * apps/web/test/control-row.test.tsx's own comment on withQuery), so every test here seeds it
 * even the one passing an empty list.
 */
function mountSection(sources: NamedSourceWithActivity[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const inputElements = (): HTMLInputElement[] =>
  [...container!.querySelectorAll('input')] as HTMLInputElement[]

const inputValues = (): string[] =>
  inputElements().map((i) => i.value)

const placeholders = (): string[] =>
  [...container!.querySelectorAll('input')].map((i) => i.getAttribute('placeholder') ?? '')

const rowDetail = (index: number): string =>
  [...container!.querySelectorAll('.source-name-detail')][index]?.textContent ?? ''

const text = (selector: string): string => container!.querySelector(selector)?.textContent ?? ''

const fieldErrors = (): string[] =>
  [...container!.querySelectorAll('.field-error')].map((e) => e.textContent ?? '')

/**
 * Same shape as mountSection, but returns the QueryClient too: the write-path tests below need it
 * to flush() on (the mutation and the refetch it invalidates are both queryClient traffic, not DOM
 * traffic flush() could otherwise see) and mountSection's own callers never needed that.
 */
function mountForWrites(sources: NamedSourceWithActivity[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

/**
 * Stands in for the real route (apps/server's PUT/DELETE .../sources/:id/alias): GET answers
 * whatever the last write left behind, so the refetch a successful mutation's onSuccess triggers
 * (the prefix invalidation in useSourceNames.ts) shows the new name rather than the seeded one.
 * PUT refuses a name already worn by a different source in this list, the one server rule these
 * tests care about (SourceAliasStore.put's own duplicate check, packages/core/src/store/sourceAliases.ts),
 * answered the same shape the real route does: a 400 with {error: {kind: 'config', message}}, which
 * is what SourceNames.tsx's inline error branch keys on.
 */
function mockSourcesApi(initial: NamedSourceWithActivity[]): {
  restore: () => void
  requests: { method: string, url: string, body: Record<string, unknown> | null }[]
} {
  let items = initial
  const requests: { method: string, url: string, body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    requests.push({ method, url, body })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (method === 'GET') return json(200, { items })

    const match = /\/sources\/([^/]+)\/alias/.exec(url)
    const sourceId = match?.[1]
    if (sourceId === undefined) throw new Error(`unexpected request: ${method} ${url}`)

    if (method === 'PUT') {
      const alias = String(body!['alias'])
      const taken = items.some((s) => s.id !== sourceId && s.alias === alias)
      if (taken) return json(400, { error: { kind: 'config', message: `'${alias}' is already the name of another source` } })
      items = items.map((s) => (s.id === sourceId ? { ...s, alias, name: alias } : s))
      return json(200, { name: alias })
    }
    if (method === 'DELETE') {
      items = items.map((s) => (s.id === sourceId
        ? { ...s, alias: null, name: s.displayName === '' ? s.id : s.displayName }
        : s))
      return json(200, { name: items.find((s) => s.id === sourceId)!.name })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requests }
}

// Native setter, not `input.value =`: the latter goes through React's own tracked setter and
// leaves onChange never firing, the same reason annotate-panel.test.tsx's own type() helper exists.
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

// Real focus, not a bare dispatchEvent: blur() on an element that was never focused is a no-op in
// happy-dom (as in a real browser), so this earns the focusout SourceNames.tsx's onBlur listens on.
function focusAndBlur(input: HTMLInputElement): void {
  act(() => { input.focus() })
  act(() => { input.blur() })
}

// The row's onKeyDown calls e.currentTarget.blur() itself on Enter; this only supplies the
// keydown and the focus a blur() needs to do anything, not the blur call, so a passing test here
// is evidence the component's own Enter handling (not this helper) produced the commit.
function pressEnter(input: HTMLInputElement): void {
  act(() => { input.focus() })
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
}

/**
 * A source that is reporting normally. The activity fields are as required on the wire as the
 * name is, so every fixture here carries them; `namedSource` exists so a test that cares about
 * one of them says so and inherits the rest.
 */
const SOURCE: NamedSourceWithActivity = {
  id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4',
  alias: 'My watch', name: 'My watch', kind: 'device', createdAtMs: 0,
  lastReportedDate: '2026-02-01', reportingDates: 30, medianGapDays: 1,
  status: 'reporting', reportingNow: true,
}

const namedSource = (over: Partial<NamedSourceWithActivity> = {}): NamedSourceWithActivity => ({ ...SOURCE, ...over })

describe('a source that has stopped reporting', () => {
  it('says when a stale source last reported', () => {
    mountSection([namedSource({
      id: 'watch', status: 'stale', reportingNow: false, lastReportedDate: '2026-01-20',
    })])
    // The exact string, not a substring: a substring check would survive the date formatting
    // breaking, which is the thing most likely to break.
    const expected = new Date('2026-01-20T00:00:00Z').toLocaleString('en', { dateStyle: 'medium' })
    expect(text('.source-name-stale')).toBe(`Stopped reporting — last was ${expected}`)
  })

  it('says nothing about staleness for a source that is reporting', () => {
    mountSection([namedSource({ status: 'reporting', reportingNow: true })])
    expect(container!.querySelector('.source-name-stale')).toBeNull()
  })

  it('says so plainly when a source has never reported at all', () => {
    mountSection([namedSource({ status: 'unjudged', reportingNow: false, lastReportedDate: null })])
    expect(text('.source-name-stale')).toBe('Has never reported')
  })

  it('tells a source judged stale apart from one it has no verdict about', () => {
    // The whole reason `unjudged` exists: a source with too little history to have a cadence
    // must not be called stale, because nothing supports the claim. The card grouped on
    // reportingNow alone, so a dead watch and a two-day app read identically.
    mountSection([
      namedSource({ id: 'watch', status: 'stale', reportingNow: false, lastReportedDate: '2026-01-20' }),
      namedSource({ id: 'app', status: 'unjudged', reportingNow: false, lastReportedDate: '2026-01-02' }),
    ])
    const rows = [...container!.querySelectorAll('.source-names-dormant .source-name-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('.source-name-stale')?.textContent)
      .toContain('Stopped reporting')
    expect(rows[1]!.querySelector('.source-name-stale')?.textContent)
      .toContain('Too little history to judge')
  })

  it('groups the ones no longer reporting under their own heading', () => {
    mountSection([
      namedSource({ id: 'live', name: 'My watch', reportingNow: true }),
      namedSource({ id: 'gone', name: 'Old app', reportingNow: false, status: 'unjudged' }),
    ])
    expect(text('.source-names-dormant-heading')).toBe('No longer reporting')
    expect(container!.querySelectorAll('.source-names-dormant .source-name-row')).toHaveLength(1)
    // Still rendered, not hidden: a household may want to rename or prioritise one.
    expect(container!.querySelectorAll('.source-name-row')).toHaveLength(2)
  })

  it('shows no heading at all when every source is reporting', () => {
    mountSection([namedSource({ id: 'a', reportingNow: true }), namedSource({ id: 'b', reportingNow: true })])
    expect(container!.querySelector('.source-names-dormant-heading')).toBeNull()
  })
})

describe('the source names section', () => {
  it('shows the current name, the provider name and the id for each source', () => {
    mountSection([
      namedSource({ id: 'abc123' }),
    ])
    // The whole value, not a substring: toContain('My watch') would also pass on the id.
    expect(inputValues()).toEqual(['My watch'])
    expect(rowDetail(0)).toBe('Pixel Watch 4 - abc123')
  })

  it('offers an empty field for a source nobody named, with the provider name as the placeholder', () => {
    mountSection([
      namedSource({ id: 'abc123', externalId: 'x', displayName: 'com.lyfta', alias: null, name: 'com.lyfta', kind: 'app' }),
    ])
    expect(inputValues()).toEqual([''])
    expect(placeholders()).toEqual(['com.lyfta'])
  })

  it('says so when the person has no sources yet', () => {
    mountSection([])
    // A container holding a whole section, not a single name or label cell, so a substring match
    // here does not hide a format regression the way it would on inputValues/rowDetail above.
    expect(container!.textContent).toContain('Nothing has reported data yet')
  })
})

// The three behaviours the spec describes for this component (blur/Enter commit, emptying the
// field to clear a name, the inline duplicate error) had no coverage at all before this: the suite
// above only ever seeds the query and reads what rendered, never types into a field. Each of these
// mocks the network at the fetch boundary the way annotate-panel.test.tsx does, since useSourceNames
// and its two mutations all go through apiGet/apiSend rather than anything this file could stub
// more directly.
describe('committing a name from the field', () => {
  it('renames the source when the field is blurred', async () => {
    const api = mockSourcesApi([SOURCE])
    const client = mountForWrites([SOURCE])

    type(inputElements()[0]!, 'New name')
    focusAndBlur(inputElements()[0]!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    const put = api.requests.find((r) => r.method === 'PUT')
    expect(put?.url).toContain('/sources/watch/alias')
    expect(put?.body).toEqual({ alias: 'New name' })
    expect(fieldErrors()).toEqual([])
  })

  it('renames the source when Enter is pressed', async () => {
    const api = mockSourcesApi([SOURCE])
    const client = mountForWrites([SOURCE])

    type(inputElements()[0]!, 'New name')
    pressEnter(inputElements()[0]!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    const put = api.requests.find((r) => r.method === 'PUT')
    expect(put?.url).toContain('/sources/watch/alias')
    expect(put?.body).toEqual({ alias: 'New name' })
    expect(fieldErrors()).toEqual([])
  })

  // SourceNames.tsx's own opening comment: emptying the field is the only way to clear a name, so
  // this is the one path that has to send DELETE rather than PUT.
  it('clears the name, rather than renaming it, when the field is emptied', async () => {
    const api = mockSourcesApi([SOURCE])
    const client = mountForWrites([SOURCE])

    type(inputElements()[0]!, '')
    focusAndBlur(inputElements()[0]!)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false)
    const del = api.requests.find((r) => r.method === 'DELETE')
    expect(del?.url).toContain('/sources/watch/alias')
    expect(fieldErrors()).toEqual([])
  })

  // rename.error and clear.error come back as an ApiError, whose `kind` reflects the response
  // status the server sent, not text this test invents: 'config' is what a 400 becomes (see
  // apps/web/src/api/client.ts's KIND_BY_STATUS), the status SourceAliasStore.put's own duplicate
  // check answers with.
  it('shows the server\'s own message inline when the name is already taken', async () => {
    const other: NamedSourceWithActivity = namedSource({
      id: 'app', externalId: 'x', displayName: 'com.lyfta', alias: null, name: 'com.lyfta',
      kind: 'app', createdAtMs: 20,
    })
    const api = mockSourcesApi([SOURCE, other])
    const client = mountForWrites([SOURCE, other])

    const appInput = inputElements()[1]!
    type(appInput, 'My watch')
    focusAndBlur(appInput)
    await flush(client, () => container!.innerHTML)
    api.restore()

    expect(fieldErrors()).toEqual(["'My watch' is already the name of another source"])
  })
})
