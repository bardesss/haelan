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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Same shape as source-names.test.tsx's own mount: a fresh QueryClient per test, the session
 * pre-seeded so useSession() never has to fetch, and the sources query pre-seeded under the same
 * key the card reads (sourceActivityKey, a child of sourceNamesKey so the two mutations'
 * prefix invalidation still reaches it). An unseeded
 * query would reach the real network in this environment rather than merely running slow (see
 * apps/web/test/control-row.test.tsx's own comment on withQuery), so every test here seeds it
 * even the one passing an empty list.
 *
 * SourceNames also mounts useSourcePriority now, and that query gets the same treatment: seeded
 * here rather than left to reach the network, the same reason sourceActivityKey is. Built from
 * `sources` rather than a fixed fixture, so a test that passes its own list still gets an answer
 * naming every source in it - an unconfigured order, since ranking is not what this file's own
 * tests are about.
 */
function seededPriority(sources: NamedSourceWithActivity[]) {
  return { configured: false, order: sources.map((s) => ({ sourceId: s.id, configured: false })) }
}

function mountSection(sources: NamedSourceWithActivity[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceActivityKey(PERSON.personId), { items: sources })
  client.setQueryData(sourcePriorityKey(PERSON.personId), seededPriority(sources))
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

// The name fields only. Each row also carries a "Show in status panel" checkbox now, which is an
// <input> too; a bare 'input' selector would hand the name tests a checkbox reading 'on'.
const inputElements = (): HTMLInputElement[] =>
  [...container!.querySelectorAll('input[type="text"]')] as HTMLInputElement[]

const inputValues = (): string[] =>
  inputElements().map((i) => i.value)

const placeholders = (): string[] =>
  [...container!.querySelectorAll('input[type="text"]')].map((i) => i.getAttribute('placeholder') ?? '')

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
  client.setQueryData(sourcePriorityKey(PERSON.personId), seededPriority(sources))
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

    // SourceNames now also mounts useSourcePriority, so a GET here has to answer two different
    // shapes: the ranking section reads {configured, order}, and answering it with {items} the
    // way the rename list wants left `order` undefined and crashed the row it built.
    if (method === 'GET' && url.includes('/source-priority')) {
      return json(200, { configured: false, order: items.map((s) => ({ sourceId: s.id, configured: false })) })
    }
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
  status: 'reporting', reportingNow: true, continuedElsewhere: false, panelChoice: null,
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

/**
 * What tells two rows apart when their names cannot.
 *
 * The card's existing rule is that a source reporting normally needs no line, because its last
 * reading is yesterday and saying so is noise. That holds while the name distinguishes the row,
 * and it stops holding on a real household: six of this archive's seventeen sources are
 * `com.android.healthconnect.phone.<32 hex>`, identical but for the hash, all of kind `app`, all
 * reporting. Nothing on those rows says which is the phone that has been recording for a year and
 * which is a reinstall that logged three days - so the card asks the reader to name sources it
 * gives them no way to tell apart.
 *
 * The discriminator is the volume, not the recency: recency is "yesterday" for all six. It is
 * already on the wire for every source, live and dormant alike, and was rendered for neither.
 */
describe('what a live source says about itself', () => {
  it('states how many dates it has reported on', () => {
    mountSection([namedSource({ reportingDates: 236, reportingNow: true })])
    expect(text('.source-name-volume')).toBe('236 days reported')
  })

  it('says one day rather than 1 days', () => {
    mountSection([namedSource({ reportingDates: 1, reportingNow: true })])
    expect(text('.source-name-volume')).toBe('1 day reported')
  })

  it('separates a busy source from a near-empty one carrying the same name', () => {
    mountSection([
      namedSource({ id: 'a', name: 'com.android.healthconnect.phone', reportingDates: 236 }),
      namedSource({ id: 'b', name: 'com.android.healthconnect.phone', reportingDates: 3 }),
    ])
    const volumes = Array.from(container!.querySelectorAll('.source-name-volume')).map((e) => e.textContent)
    expect(volumes).toEqual(['236 days reported', '3 days reported'])
  })

  // A source that has produced nothing has no volume worth printing, and "0 days reported" beside
  // the "Has never reported" line below it would say the same thing twice.
  it('prints no volume for a source that has never reported', () => {
    mountSection([namedSource({ reportingDates: 0, lastReportedDate: null, reportingNow: false })])
    expect(container!.querySelector('.source-name-volume')).toBeNull()
  })

  /*
   * What a row leads with.
   *
   * The raw id is kept - SourceNames.tsx's own reason is that deep links carry it, so somebody
   * debugging one has to be able to read it off this screen, and that requirement is real. It was
   * weighted wrongly though: the provider's name and a 32 character hash were set at body size
   * between the field and everything else, so seventeen rows led with the one thing a reader
   * cannot act on and the facts they can act on came last.
   *
   * So the identifiers move behind the name, the kind and the volume rather than in front of them.
   * Still printed in full and still selectable - a title tooltip would satisfy "readable" and not
   * "copyable", and copying it is the whole reason a debugger is on this screen.
   */
  it('leads with what a reader can act on and puts the provider identifiers last', () => {
    mountSection([namedSource()])
    const classes = Array.from(container!.querySelector('.source-name-row')!.children)
      .map((child) => child.className)
      .filter((name) => name.startsWith('source-name-'))
    expect(classes).toEqual(['source-name-kind', 'source-name-volume', 'source-name-detail'])
  })
})

/**
 * The status panel's own switch, one per row.
 *
 * With no explicit choice a source follows the default the panel itself applies - reported within
 * the last thirty days - so the switch has to draw that default, not a blanket "off". Otherwise the
 * two surfaces would disagree about the same source on the same day: the panel listing a watch
 * whose switch here reads unchecked. The rule comes from @haelan/core/status-panel, the same
 * function composeStatus uses on the server.
 */
describe('showing a source in the status panel', () => {
  // Yesterday by the UTC clock, which is inside the thirty-day window in whatever timezone the
  // person's today is computed in, so this does not depend on where the suite runs.
  const RECENT = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const LONG_AGO = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)

  let requests: { method: string, url: string, body: unknown }[] = []
  let original: typeof fetch
  beforeEach(() => {
    requests = []
    original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as { visible: boolean } : undefined
      requests.push({ method, url, body })
      const payload = url.endsWith('/panel') ? { visible: method === 'DELETE' ? null : body!.visible } : { items: [] }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = original })

  const toggle = (index = 0): HTMLInputElement =>
    [...container!.querySelectorAll<HTMLInputElement>('.source-panel-toggle input[type="checkbox"]')][index]!
  const automatic = (): HTMLButtonElement | null =>
    [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Back to automatic') ?? null
  const panelWrites = () => requests.filter((r) => r.url.endsWith('/panel'))

  it('draws a recent source with no choice as shown, and an old one as hidden', () => {
    mountSection([
      namedSource({ id: 'watch', lastReportedDate: RECENT, panelChoice: null }),
      namedSource({ id: 'old', name: 'Old scale', alias: 'Old scale', lastReportedDate: LONG_AGO, panelChoice: null }),
    ])
    expect(toggle(0).checked).toBe(true)
    expect(toggle(1).checked).toBe(false)
    expect(container!.querySelector('.source-panel-toggle')!.textContent).toBe('Show in status panel')
    // No choice has been made, so there is nothing to go back from.
    expect(automatic()).toBeNull()
  })

  // Seventeen rows each carrying "Show in status panel" is seventeen identical names to a screen
  // reader; the source's own name is what tells them apart. The visible words lead the name, so
  // a voice-control user saying what they see still reaches the control.
  it('names the source in the switch and the way back, for a screen reader', () => {
    mountSection([namedSource({ lastReportedDate: RECENT, panelChoice: false })])
    expect(toggle().getAttribute('aria-label')).toBe('Show in status panel: My watch')
    expect(automatic()!.getAttribute('aria-label')).toBe('Back to automatic: My watch')
  })

  // A second press while the first is in flight would race it, and the switch would flicker
  // between the two answers as they land.
  it('holds the switch still while a choice is being saved', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    mountForWrites([namedSource({ lastReportedDate: RECENT, panelChoice: null })])
    expect(toggle().disabled).toBe(false)
    // Async, so the mutation has started and reported itself pending before the assertion.
    await act(async () => { toggle().click() })
    expect(toggle().disabled).toBe(true)
  })

  it('follows an explicit choice over the default', () => {
    mountSection([namedSource({ lastReportedDate: RECENT, panelChoice: false })])
    expect(toggle().checked).toBe(false)
  })

  it('sends the choice when the switch is turned off', async () => {
    const client = mountForWrites([namedSource({ lastReportedDate: RECENT, panelChoice: null })])
    act(() => { toggle().click() })
    await flush(client, () => container!.innerHTML)
    expect(panelWrites()).toEqual([{ method: 'PUT', url: '/api/v1/p/p1/sources/watch/panel', body: { visible: false } }])
  })

  it('offers the way back to automatic once a choice is made, and it forgets the choice', async () => {
    const client = mountForWrites([namedSource({ lastReportedDate: RECENT, panelChoice: false })])
    expect(automatic()).not.toBeNull()
    act(() => { automatic()!.click() })
    await flush(client, () => container!.innerHTML)
    expect(panelWrites()).toEqual([{ method: 'DELETE', url: '/api/v1/p/p1/sources/watch/panel', body: undefined }])
  })
})
