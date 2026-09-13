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
import { flush } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
// Set by mockFetch, cleared by afterEach unconditionally: a test that asserts before restoring
// its own mock (or throws out of an assertion) used to leave globalThis.fetch patched for every
// test still to run in this file, turning one red test into a cascade of unrelated ones. Cleanup
// belongs to afterEach because that runs whether the test passed, failed or threw.
let restoreFetch: (() => void) | null = null

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
  if (restoreFetch) {
    restoreFetch()
    restoreFetch = null
  }
})

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/** Mounts inside a real I18nProvider (English) and a QueryClientProvider carrying a signed in
 * session, the same shape annotate-panel.test.tsx's own withSession/mount pair uses: this
 * component sets real fetch backed queries and mutations, which only exist once the tree is
 * mounted for real. Returns the QueryClient so a test can wait on it with flush(). */
function mount(node: ReactNode): QueryClient {
  const c = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  c.setQueryData(queryKeys.session(), PERSON)
  act(() => { root?.render(<I18nProvider lng="en"><QueryClientProvider client={c}>{node}</QueryClientProvider></I18nProvider>) })
  return c
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function html(): string {
  return container!.innerHTML
}

/**
 * Points globalThis.fetch at `handler` and registers the restore with afterEach via
 * `restoreFetch`, rather than handing the caller a function it has to remember to run before
 * every assertion. `stubFetch` below builds the handler; the one inline fetch override elsewhere
 * in this file goes through this too, so both paths get the same unconditional cleanup.
 */
function mockFetch(handler: (url: string, method: string) => Response | Promise<Response>): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init?.method ?? 'GET')
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
}

/**
 * Answers GET /overrides from a mutable list and DELETE /overrides/:id by both removing the row
 * from that list (the store commits the removal before the drain runs, whatever `applied` reports:
 * see useAnnotations.ts's own comment on useRemoveOverride) and answering with `removalApplied`,
 * so a test can drive both outcomes without the stub lying about what a real removal does to the
 * list underneath it.
 */
function stubFetch(initial: readonly StoredOverride[], removalApplied = true): void {
  let items = [...initial]
  mockFetch((url, method) => {
    if (method === 'DELETE') {
      const id = url.split('/overrides/')[1]
      items = items.filter((item) => item.id !== id)
      return respond(200, { id, affected: null, applied: removalApplied })
    }
    if (url.includes('/overrides')) return respond(200, { items })
    return respond(404, {})
  })
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

// A correction at sample scope, which is the only scope OverrideStore.validate accepts one at and
// the only shape a correct row can actually arrive in. It was a day_metric correction here, which
// no server in this project can answer with: validate refuses `correct` at day scope, and the
// panel never offers the action there either (AnnotatePanel.tsx's own actionsFor has why), so the
// row this file used to render a correction from could never have been written. A sample
// correction can now come from the panel too, off a click on an intraday chart, but this list
// still reads every row regardless of who wrote it, panel or sync layer.
const SAMPLE_CORRECT_UTC_MS = Date.parse('2026-08-16T07:15:00Z')
const SAMPLE_CORRECT: StoredOverride = {
  id: 'o2', scope: 'sample',
  targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: SAMPLE_CORRECT_UTC_MS }),
  action: 'correct', correctedValue: 62, reason: 'watch mis-logged a spike',
}

// The precision-audit fix this file gained alongside the others: a raw, many-decimal corrected
// value reached this visible cell exactly the way day.hrMean reached hrTooltip's, with no
// formatting step between the store and the reader. respiratory_rate's catalogue precision is 1
// (metrics.ts), not 0 like SAMPLE_CORRECT's heart_rate above, so this also proves the value is
// rounded by the metric its own target key names rather than to a hardcoded precision.
const SAMPLE_CORRECT_UNROUNDED: StoredOverride = {
  id: 'o7', scope: 'sample',
  targetKey: sampleTarget({ source: 'watch', metric: 'respiratory_rate', utcMs: SAMPLE_CORRECT_UTC_MS }),
  action: 'correct', correctedValue: 14.666666666666666, reason: 'watch mis-logged a spike',
}

// A correction whose target key this build cannot parse at all: targetInfo's own catch branch
// hands actionText a null metric, so METRICS[metric].precision cannot be read for it. Pins the
// bounded fallback (UNREADABLE_METRIC_PRECISION in OverrideList.tsx) rather than a fifteen digit
// float reaching this cell the way it would with no fallback at all.
const SAMPLE_CORRECT_UNREADABLE: StoredOverride = {
  id: 'o8', scope: 'sample',
  targetKey: '{not valid json',
  action: 'correct', correctedValue: 90.18407633664866, reason: 'a correction this build cannot place',
}

// A sample correction whose target key parses cleanly (unlike SAMPLE_CORRECT_UNREADABLE, whose
// key itself is malformed JSON) but names a metric the catalogue does not carry: a renamed or
// removed metric, or a bad write from an external POST /overrides caller that OverrideStore.validate
// never checked the metric id of (validate only checks the target key's SHAPE, see overrides.ts's
// own comment). formatMetricValue now throws on an unknown id (M3e review, Minor 4); this pins
// that the list still falls back to the same bounded UNREADABLE_METRIC_PRECISION path rather than
// an uncaught throw inside a table row's render blanking the whole list.
const SAMPLE_CORRECT_UNKNOWN_METRIC: StoredOverride = {
  id: 'o9', scope: 'sample',
  targetKey: sampleTarget({ source: 'watch', metric: 'not_a_real_metric', utcMs: SAMPLE_CORRECT_UTC_MS }),
  action: 'correct', correctedValue: 90.18407633664866, reason: 'a metric this build no longer carries',
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

// A second row that fails to parse the same way UNPARSEABLE does, so its target and date cells
// read identically ("Target could not be read" / "Not recorded for this scope") despite naming a
// different real, unreadable key: the one case target+date alone cannot tell two rows apart.
const UNPARSEABLE_2: StoredOverride = {
  id: 'o6', scope: 'day_metric',
  targetKey: '{also not valid json',
  action: 'exclude', correctedValue: null, reason: 'a second unreadable row',
}

describe('every scope renders a complete row', () => {
  it('shows scope, target, action, reason and date for a day_metric row', async () => {
    stubFetch([DAY_METRIC_EXCLUDE])
    const c = mount(<OverrideList />)
    await flush(c, html)

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
    stubFetch([SAMPLE_CORRECT])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const row = rows()[0]!
    const [, , action] = cells(row)
    expect(action).toBe('Correct to 62')
    expect(container!.textContent).not.toContain('Exclude')
  })

  // The bug this task fixed, pinned directly on this table: before formatMetricValue existed,
  // this cell interpolated item.correctedValue raw, so a reader would have seen
  // "Correct to 14.666666666666666" rather than a value rounded to respiratory_rate's own
  // catalogue precision (1).
  it('rounds a corrected value to its own metric\'s catalogue precision, not a raw float', async () => {
    stubFetch([SAMPLE_CORRECT_UNROUNDED])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const row = rows()[0]!
    const [, , action] = cells(row)
    expect(action).toBe('Correct to 14.7')
  })

  it('rounds a corrected value it cannot place to a metric to a bounded fallback, not a raw float', async () => {
    stubFetch([SAMPLE_CORRECT_UNREADABLE])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const row = rows()[0]!
    const [, , action] = cells(row)
    expect(action).toBe('Correct to 90.18')
  })

  it('rounds a corrected value for a metric the catalogue no longer carries to the same bounded fallback, not a crash', async () => {
    stubFetch([SAMPLE_CORRECT_UNKNOWN_METRIC])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const row = rows()[0]!
    const [, , action] = cells(row)
    expect(action).toBe('Correct to 90.18')
  })

  it('shows a sample row with its source, metric and the sample instant as its date', async () => {
    stubFetch([SAMPLE])
    const c = mount(<OverrideList />)
    await flush(c, html)

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
    stubFetch([SESSION])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const row = rows()[0]!
    const [scope, target, , , date] = cells(row)
    expect(scope).toBe('Session')
    expect(target).toBe('Session s1')
    expect(date).toBe('Not recorded for this scope')
  })

  it('renders a target key this build cannot parse as a complete row, not a dropped one and not raw JSON', async () => {
    stubFetch([DAY_METRIC_EXCLUDE, UNPARSEABLE])
    const c = mount(<OverrideList />)
    await flush(c, html)

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

describe('the table names itself for a screen reader', () => {
  // happy-dom applies no stylesheet, so a visually hidden caption or header cell renders exactly
  // like a visible one here: nothing about this test tells the two apart, which is exactly why the
  // structure has to be asserted directly rather than inferred from what a sighted pass looked
  // like. A corrected day once read "excluded" to a screen reader while looking correct visually
  // (this milestone's own precedent), which is the class of defect a visual only read cannot catch.
  it('gives the table a caption naming what it lists', async () => {
    stubFetch([DAY_METRIC_EXCLUDE])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const caption = container!.querySelector('table > caption')
    expect(caption).not.toBeNull()
    expect(caption!.textContent).toBe('Corrections and exclusions')
  })

  it('marks every column header with scope="col", including the visually hidden remove column', async () => {
    stubFetch([DAY_METRIC_EXCLUDE])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const headers = [...container!.querySelectorAll('thead th')] as HTMLTableCellElement[]
    expect(headers.map((h) => h.textContent)).toEqual(
      ['Scope', 'Target', 'Action', 'Reason', 'Date', 'Remove'],
    )
    for (const header of headers) {
      expect(header.getAttribute('scope'), header.outerHTML).toBe('col')
    }
  })
})

describe('the remove button names its own row', () => {
  it('gives every remove button a distinct accessible name', async () => {
    stubFetch([DAY_METRIC_EXCLUDE, SAMPLE_CORRECT, SAMPLE, SESSION])
    const c = mount(<OverrideList />)
    await flush(c, html)

    const buttons = [...container!.querySelectorAll('tbody button')] as HTMLButtonElement[]
    expect(buttons).toHaveLength(4)
    const labels = buttons.map((b) => b.getAttribute('aria-label'))
    expect(new Set(labels).size).toBe(4)
    expect(labels.every((l) => l !== null && l !== '')).toBe(true)
  })

  // The gap target+date alone cannot close: two rows whose keys both fail to parse read identical
  // target and date cells ("Target could not be read" / "Not recorded for this scope"), so only
  // the id folded into the aria-label keeps their remove buttons apart.
  it('stays distinct even for two rows whose target keys both fail to parse', async () => {
    stubFetch([UNPARSEABLE, UNPARSEABLE_2])
    const c = mount(<OverrideList />)
    await flush(c, html)

    expect(rows()).toHaveLength(2)
    const buttons = [...container!.querySelectorAll('tbody button')] as HTMLButtonElement[]
    const labels = buttons.map((b) => b.getAttribute('aria-label'))
    expect(new Set(labels).size).toBe(2)
  })
})

describe('removing an override', () => {
  it('takes the row out of the list once the removal has applied', async () => {
    stubFetch([DAY_METRIC_EXCLUDE, SAMPLE], true)
    const c = mount(<OverrideList />)
    await flush(c, html)
    expect(rows()).toHaveLength(2)

    const button = container!.querySelector('tbody button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(c, html)

    expect(rows()).toHaveLength(1)
    expect(container!.textContent).not.toContain('The numbers behind it have not caught up yet')
  })

  // The problem this task states by name: a reader who removes a correction and sees an unchanged
  // number elsewhere will remove it again looking for a second effect. The row is still gone (the
  // override really is deleted the moment the write commits, applied or not), but it must not
  // disappear silently: this is the list's own answer to the same applied:false state
  // AnnotatePanel handles by staying open.
  it('takes the row out of the list even when the removal has not applied yet, and says so', async () => {
    stubFetch([DAY_METRIC_EXCLUDE], false)
    const c = mount(<OverrideList />)
    await flush(c, html)

    const button = container!.querySelector('tbody button') as HTMLButtonElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(c, html)

    expect(rows()).toHaveLength(0)
    expect(container!.textContent).toContain('Removed. The numbers behind it have not caught up yet.')
  })
})

describe('the query states', () => {
  it('shows a retry on a failed read', async () => {
    mockFetch(() => respond(500, { error: { message: 'boom' } }))
    const c = mount(<OverrideList />)
    await flush(c, html)

    expect(container!.textContent).toContain('This did not load.')
    expect(container!.querySelector('button')?.textContent).toBe('Try again')
  })

  it('shows an empty state when the person has no overrides at all', async () => {
    stubFetch([])
    const c = mount(<OverrideList />)
    await flush(c, html)

    expect(container!.textContent).toContain('No corrections yet')
    expect(container!.querySelector('table')).toBeNull()
  })
})
