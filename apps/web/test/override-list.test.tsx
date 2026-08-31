// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { dayMetricTarget, sampleTarget, sessionTarget } from '@haelan/core/target-key'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { OverrideList } from '../src/pages/settings/OverrideList.js'
import type { StoredOverride } from '../src/data/useAnnotations.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
}

/** Mounts inside a real I18nProvider (English) and a QueryClientProvider carrying a signed in
 * session, the same shape annotate-panel.test.tsx's own withSession/mount pair uses: this
 * component sets real fetch backed queries and mutations, which only exist once the tree is
 * mounted for real. */
function mount(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => { root?.render(<I18nProvider lng="en"><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nProvider>) })
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fixed wait rather than flush()'s isFetching-polling: annotate-panel.test.tsx's own precedent
 * for the same situation (a mounted tree with a mock fetch that resolves fast, waited on after a
 * click). flush() assumes whatever it is waiting for is still in flight by the time it takes its
 * first sample, which holds for a page's own initial load but not here: a mutation's fetch plus
 * the refetch its own onSuccess triggers both resolve against this file's mocked, instantly
 * settling fetch inside the same act() the click already flushed, so by the time a poll loop
 * would take its first reading there is nothing left in flight to see, and flush() waits out its
 * own budget for an in-flight state that already came and went. Proved by running it: it hangs
 * every time, not intermittently.
 */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

/**
 * Answers GET /overrides from a mutable list and DELETE /overrides/:id by both removing the row
 * from that list (the store commits the removal before the drain runs, whatever `applied` reports:
 * see useAnnotations.ts's own comment on useRemoveOverride) and answering with `removalApplied`,
 * so a test can drive both outcomes without the stub lying about what a real removal does to the
 * list underneath it.
 */
function stubFetch(initial: readonly StoredOverride[], removalApplied = true): () => void {
  let items = [...initial]
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') {
      const id = url.split('/overrides/')[1]
      items = items.filter((item) => item.id !== id)
      return respond(200, { id, affected: null, applied: removalApplied })
    }
    if (url.includes('/overrides')) return respond(200, { items })
    return respond(404, {})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function rows(): HTMLTableRowElement[] {
  return [...container!.querySelectorAll('tbody tr')] as HTMLTableRowElement[]
}

function cells(row: HTMLTableRowElement): string[] {
  return [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

const DAY_METRIC_EXCLUDE: StoredOverride = {
  id: 'o1', scope: 'day_metric',
  targetKey: dayMetricTarget({ localDate: '2026-08-15', metric: 'steps' }),
  action: 'exclude', correctedValue: null, reason: 'travelling, phone left at home',
}

const DAY_METRIC_CORRECT: StoredOverride = {
  id: 'o2', scope: 'day_metric',
  targetKey: dayMetricTarget({ localDate: '2026-08-16', metric: 'heart_rate' }),
  action: 'correct', correctedValue: 62, reason: 'watch mis-logged a spike',
}

const SAMPLE_UTC_MS = Date.parse('2026-08-15T10:32:00Z')
const SAMPLE: StoredOverride = {
  id: 'o3', scope: 'sample',
  targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: SAMPLE_UTC_MS }),
  action: 'exclude', correctedValue: null, reason: 'strap slipped, spurious spike',
}

const SESSION: StoredOverride = {
  id: 'o4', scope: 'session',
  targetKey: sessionTarget('s1'),
  action: 'exclude', correctedValue: null, reason: 'workout misclassified by the watch',
}

// A row this build's own encoder never writes: proof that a target key this build cannot parse
// still renders a complete row rather than being dropped, unlike chartAnnotations.ts's own
// overridesByMetric, which is allowed to skip a row like this because a chart has nowhere to draw
// it. This list is the one place that guarantee cannot fall back on "skip it".
const UNPARSEABLE: StoredOverride = {
  id: 'o5', scope: 'day_metric',
  targetKey: '{not valid json',
  action: 'exclude', correctedValue: null, reason: 'a target key from a build ahead of this one',
}

describe('every scope renders a complete row', () => {
  it('shows scope, target, action, reason and date for a day_metric row', async () => {
    const restore = stubFetch([DAY_METRIC_EXCLUDE])
    mount(<OverrideList />)
    await settle()
    restore()

    const row = rows()[0]!
    const [scope, target, action, reason, date] = cells(row)
    expect(scope).toBe('Day and metric')
    expect(target).toBe('steps')
    expect(action).toBe('Exclude')
    expect(reason).toBe('travelling, phone left at home')
    expect(date).toBe('2026-08-15')
  })

  // The one case the brief names directly: a corrected day was once labelled "excluded" while
  // looking correct, because the two actions shared one channel. actionText's own value branch is
  // what this pins, both in what it shows (the corrected value, not just the verb) and in what it
  // must never show for this row.
  it('shows the corrected value for a correct row, and never the word Exclude', async () => {
    const restore = stubFetch([DAY_METRIC_CORRECT])
    mount(<OverrideList />)
    await settle()
    restore()

    const row = rows()[0]!
    const [, , action] = cells(row)
    expect(action).toBe('Correct to 62')
    expect(container!.textContent).not.toContain('Exclude')
  })

  it('shows a sample row with its source, metric and the sample instant as its date', async () => {
    const restore = stubFetch([SAMPLE])
    mount(<OverrideList />)
    await settle()
    restore()

    const row = rows()[0]!
    const [scope, target, , , date] = cells(row)
    expect(scope).toBe('Sample')
    expect(target).toBe('heart_rate from watch')
    // The exact same Intl call the component makes, not a hand rolled expectation: locale
    // formatting is an ICU detail this test has no business re-implementing.
    expect(date).toBe(new Date(SAMPLE_UTC_MS).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }))
  })

  // The scope this task exists for: nothing before it could show a session scoped row at all.
  it('shows a session row with its session id, and says plainly that it carries no date', async () => {
    const restore = stubFetch([SESSION])
    mount(<OverrideList />)
    await settle()
    restore()

    const row = rows()[0]!
    const [scope, target, , , date] = cells(row)
    expect(scope).toBe('Session')
    expect(target).toBe('Session s1')
    expect(date).toBe('Not recorded for this scope')
  })

  it('renders a target key this build cannot parse as a complete row, not a dropped one and not raw JSON', async () => {
    const restore = stubFetch([DAY_METRIC_EXCLUDE, UNPARSEABLE])
    mount(<OverrideList />)
    await settle()
    restore()

    expect(rows()).toHaveLength(2)
    const broken = rows().find((row) => cells(row)[3] === 'a target key from a build ahead of this one')!
    const [scope, target, action, , date] = cells(broken)
    expect(scope).toBe('Day and metric')
    expect(action).toBe('Exclude')
    expect(target).toBe('Target could not be read')
    expect(date).toBe('Not recorded for this scope')
    expect(container!.textContent).not.toContain('{not valid json')
  })
})

describe('the remove button names its own row', () => {
  it('gives every remove button a distinct accessible name', async () => {
    const restore = stubFetch([DAY_METRIC_EXCLUDE, DAY_METRIC_CORRECT, SAMPLE, SESSION])
    mount(<OverrideList />)
    await settle()
    restore()

    const buttons = [...container!.querySelectorAll('tbody button')] as HTMLButtonElement[]
    expect(buttons).toHaveLength(4)
    const labels = buttons.map((b) => b.getAttribute('aria-label'))
    expect(new Set(labels).size).toBe(4)
    expect(labels.every((l) => l !== null && l !== '')).toBe(true)
  })
})

describe('removing an override', () => {
  it('takes the row out of the list once the removal has applied', async () => {
    const restore = stubFetch([DAY_METRIC_EXCLUDE, SAMPLE], true)
    mount(<OverrideList />)
    await settle()
    expect(rows()).toHaveLength(2)

    const button = container!.querySelector('tbody button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    restore()

    expect(rows()).toHaveLength(1)
    expect(container!.textContent).not.toContain('The numbers behind it have not caught up yet')
  })

  // The problem this task states by name: a reader who removes a correction and sees an unchanged
  // number elsewhere will remove it again looking for a second effect. The row is still gone (the
  // override really is deleted the moment the write commits, applied or not), but it must not
  // disappear silently: this is the list's own answer to the same applied:false state
  // AnnotatePanel handles by staying open.
  it('takes the row out of the list even when the removal has not applied yet, and says so', async () => {
    const restore = stubFetch([DAY_METRIC_EXCLUDE], false)
    mount(<OverrideList />)
    await settle()

    const button = container!.querySelector('tbody button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    restore()

    expect(rows()).toHaveLength(0)
    expect(container!.textContent).toContain('Removed. The numbers behind it have not caught up yet.')
  })
})

describe('the query states', () => {
  it('shows a retry on a failed read', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(500, { error: { message: 'boom' } })) as typeof fetch
    mount(<OverrideList />)
    await settle()
    globalThis.fetch = original

    expect(container!.textContent).toContain('This did not load.')
    expect(container!.querySelector('button')?.textContent).toBe('Try again')
  })

  it('shows an empty state when the person has no overrides at all', async () => {
    const restore = stubFetch([])
    mount(<OverrideList />)
    await settle()
    restore()

    expect(container!.textContent).toContain('No corrections yet')
    expect(container!.querySelector('table')).toBeNull()
  })
})
