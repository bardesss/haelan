// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { dayMetricTarget, sampleTarget } from '@haelan/core/target-key'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { AnnotatePanel } from '../src/components/AnnotatePanel.js'
import type { AnnotateTarget } from '../src/components/AnnotatePanel.js'

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

/**
 * Mounts a tree inside a real I18nProvider, following control-row-actions.test.tsx's own pattern:
 * this component sets real click, change and submit handlers, which only exist once the tree is
 * mounted for real, and using the real English copy is what lets the segment and message
 * assertions below key off actual reader-facing text rather than i18next fallback keys.
 */
function mount(node: ReactNode): void {
  act(() => { root?.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function withSession(node: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(queryKeys.session(), PERSON)
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

// Same device control-row.test.tsx's own copy of this helper uses: assigning .value directly goes
// through React's own tracked setter and leaves onChange never firing, pass or fail, no matter
// what the handler does. The native prototype setter bypasses that tracking the way a real
// keystroke would.
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function submitButton(): HTMLButtonElement {
  return container!.querySelector('button[type="submit"]') as HTMLButtonElement
}

function segment(label: string): HTMLButtonElement {
  const buttons = [...container!.querySelectorAll('.segment')] as HTMLButtonElement[]
  const found = buttons.find((b) => b.textContent === label)
  if (!found) throw new Error(`no segment labelled '${label}' among [${buttons.map((b) => b.textContent).join(', ')}]`)
  return found
}

function fields(): HTMLInputElement[] {
  return [...container!.querySelectorAll('input.input')] as HTMLInputElement[]
}

// By label rather than by position: the exclude and correct actions now share the reason field,
// so a test that wants to fill in one field among several reads the same way regardless of what
// else the current action happens to render around it.
function fieldFor(label: string): HTMLInputElement {
  const found = [...container!.querySelectorAll('.field')].find(
    (field) => field.querySelector('.label')?.textContent === label,
  )
  if (!found) throw new Error(`no field labelled '${label}'`)
  return found.querySelector('input') as HTMLInputElement
}

function mountPanel(target: AnnotateTarget): void {
  mount(withSession(<AnnotatePanel target={target} onClose={() => {}} />))
}

// Real rendered copy, the same thing a reader sees and the same thing the sibling assertion in
// 'the actions the panel offers' below reads: a test hook that title-cased the raw action id would
// pass 'Note' when the segment actually says "Add a note", which is not a check on what renders.
function actionLabels(): (string | null)[] {
  return [...container!.querySelectorAll('.segment')].map((b) => b.textContent)
}

function withheldText(): string | null {
  return container!.querySelector('.annotate-note-withheld')?.textContent ?? null
}

const TARGET: AnnotateTarget = { scope: 'day_metric', localDate: '2026-08-15', metric: 'steps' }

describe('the target key the panel writes with', () => {
  // The panel carries no field a reader could type a target key into at all: this asserts that
  // what actually reaches the route is exactly what dayMetricTarget builds from the click's own
  // day and metric, the same encoder the store and the route read back with, not a hand rolled
  // copy of its JSON shape living in apps/web.
  it('is built from the clicked point alone, with nothing typed', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'o1', affected: null, applied: true })
    }) as typeof fetch

    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    type(fields()[0]!, 'phone charging in another room')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(posted).not.toBeNull()
    expect(posted!['targetKey']).toBe(dayMetricTarget(TARGET))
  })
})

describe('exclude requires a reason', () => {
  it('keeps the submit button disabled until a reason is typed', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    expect(submitButton().disabled).toBe(true)
    type(fields()[0]!, 'travelling')
    expect(submitButton().disabled).toBe(false)
  })
})

describe('the actions the panel offers', () => {
  // The blocker the whole branch review found: the panel posted a day_metric correction that
  // OverrideStore.validate refuses at any scope but sample, so every correction 400d and the
  // reader was told it did not save. Dropping the tab at day_metric scope is still the fix for
  // that target, and this is what keeps it dropped there specifically: correct has since gained a
  // real home at sample scope (see the describe block below), but a day_metric click still has no
  // single instant a sample override could name, so this segment list stays three long regardless.
  it('offers exclude, note and event, and no correct', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    const labels = [...container!.querySelectorAll('.segment')].map((b) => b.textContent)
    expect(labels).toEqual(['Exclude', 'Add a note', 'Add an event'])
  })

  // The segment list above is the surface; this is the wire. A tab could be dropped from
  // actionsFor's day_metric branch while a correct-shaped write stayed reachable from this same
  // target regardless, and the only thing that actually matters is that no day_metric target ever
  // posts a correction, whatever the segment list currently offers.
  it('posts action exclude, the one override action a day_metric target accepts', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'o1', affected: null, applied: true })
    }) as typeof fetch

    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    type(fields()[0]!, 'phone charging in another room')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(posted).not.toBeNull()
    expect(posted!['action']).toBe('exclude')
    expect(posted!['scope']).toBe('day_metric')
    expect(posted!['correctedValue']).toBeUndefined()
  })
})

// Task 5's own coverage: correct gets its home at sample scope, guarded by `n` (the number of
// stored rows a plotted point stands in for). Both branches of that guard, plus the write it
// finally unlocks, none of which the day_metric-only suite above ever exercises.
describe('the panel\'s actions depend on what the click named', () => {
  it('offers three actions for a day click', () => {
    mountPanel({ scope: 'day_metric', localDate: '2026-08-21', metric: 'heart_rate' })
    expect(actionLabels()).toEqual(['Exclude', 'Add a note', 'Add an event'])
  })

  // One stored row behind the point means one instant to correct, which is the only thing a
  // sample override can name.
  it('offers correct for a sample click with one row behind it', () => {
    mountPanel({ scope: 'sample', localDate: '2026-08-21', metric: 'heart_rate', sourceId: 'watch', utcMs: 1, n: 1 })
    expect(actionLabels()).toEqual(['Exclude', 'Correct', 'Add a note', 'Add an event'])
  })

  it('withholds correct when the point stands for several readings, and says why', () => {
    mountPanel({ scope: 'sample', localDate: '2026-08-21', metric: 'spo2', sourceId: 'watch', utcMs: 1, n: 6 })
    expect(actionLabels()).toEqual(['Exclude', 'Add a note', 'Add an event'])
    expect(withheldText()).toBe('This point combines 6 readings, so there is no single value to correct.')
  })

  it('writes a sample scoped override for a sample click', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'o1', affected: null, applied: true })
    }) as typeof fetch

    mountPanel({ scope: 'sample', localDate: '2026-08-21', metric: 'heart_rate', sourceId: 'watch', utcMs: 1, n: 1 })
    click(segment('Correct'))
    type(fieldFor('Reason'), 'strap glitch')
    type(fieldFor('Corrected value'), '62')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    // Built with sampleTarget itself, not a hand written literal: the two sides of this assertion
    // agree by construction on what a (source, metric, utcMs) triple encodes to, rather than one
    // of them silently drifting from targetKey.ts's own JSON shape.
    expect(posted).toEqual({
      scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1 }),
      action: 'correct',
      correctedValue: 62,
      reason: 'strap glitch',
    })
  })
})

describe('the event kind field', () => {
  it('offers the seed set from the schema comment as datalist options', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Add an event'))
    const options = [...container!.querySelectorAll('datalist option')] as HTMLOptionElement[]
    expect(options.map((o) => o.value)).toEqual(['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine'])
  })

  it('accepts a kind outside the seed set and sends exactly what was typed', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'e1' })
    }) as typeof fetch

    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Add an event'))
    // Kind is the first field on this tab; startedAt already carries a default from the clicked
    // day, so typing a kind alone is enough to satisfy this tab's own required fields.
    type(fields()[0]!, 'sauna')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(posted).not.toBeNull()
    expect(posted!['kind']).toBe('sauna')
  })
})

describe('the two applied outcomes render differently', () => {
  it('closes the panel once the write has applied', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: true,
    })) as typeof fetch

    let closed = false
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => { closed = true }} />))
    type(fields()[0]!, 'illness')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(closed).toBe(true)
  })

  // The one state the brief calls out by name: the write is saved, the drain has not caught up,
  // and closing here would let a reader walk away believing a number that has not moved.
  it('stays open and reports the exclusion is saved but not yet applied', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: false,
    })) as typeof fetch

    let closed = false
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => { closed = true }} />))
    type(fields()[0]!, 'illness')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(closed).toBe(false)
    expect(container!.textContent).toContain('The exclusion is saved. The numbers behind it have not caught up yet.')
  })
})

describe('the overlay', () => {
  it('closes on a click outside the panel, not on a click inside it', () => {
    let closed = false
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => { closed = true }} />))
    click(container!.querySelector('.annotate-panel') as HTMLElement)
    expect(closed).toBe(false)
    click(container!.querySelector('.annotate-overlay') as HTMLElement)
    expect(closed).toBe(true)
  })
})
