// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { dayMetricTarget } from '@haelan/core/target-key'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { AnnotatePanel } from '../src/components/AnnotatePanel.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
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

const TARGET = { localDate: '2026-08-15', metric: 'steps' }

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

describe('exclude and correct require a reason', () => {
  it('keeps the submit button disabled until a reason is typed, on exclude', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    expect(submitButton().disabled).toBe(true)
    type(fields()[0]!, 'travelling')
    expect(submitButton().disabled).toBe(false)
  })

  it('keeps the submit button disabled on correct until a reason is typed, even with a value entered', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Correct'))
    // Corrected value renders first on this tab, reason second: see the field order in
    // AnnotatePanel.tsx's action === 'correct' branch.
    type(fields()[0]!, '8500')
    expect(submitButton().disabled).toBe(true)
    type(fields()[1]!, 'watch mis-logged steps')
    expect(submitButton().disabled).toBe(false)
  })
})

describe('correct requires a value', () => {
  it('keeps the submit button disabled with a reason typed but no corrected value', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Correct'))
    type(fields()[1]!, 'watch mis-logged steps')
    expect(submitButton().disabled).toBe(true)
  })

  // Not a second copy of the "no corrected value" case above: this is the browser's own value
  // sanitisation algorithm for type="number", proved rather than assumed. It is what makes an
  // isNaN check on correctedNumber dead code in AnnotatePanel.tsx: no keystroke can leave this
  // field holding a non-numeric, non-empty string for that check to ever see.
  it('sanitises a non numeric keystroke in the corrected value field to empty, same as leaving it blank', () => {
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Correct'))
    const valueInput = fields()[0]!
    type(valueInput, 'not a number')
    expect(valueInput.value).toBe('')
    type(fields()[1]!, 'watch mis-logged steps')
    expect(submitButton().disabled).toBe(true)
  })
})

describe('the correct action', () => {
  // The whole two-state response was designed around this action: the reader is changing a
  // number, not just marking a day, so a payload that silently posted 'exclude' or dropped
  // correctedValue would save the wrong write while looking, from the disabled-button tests
  // alone, exactly like a correct submission.
  it('posts action correct and the typed corrected value, not exclude', async () => {
    let posted: Record<string, unknown> | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      posted = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      return respond(200, { id: 'o1', affected: null, applied: true })
    }) as typeof fetch

    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => {}} />))
    click(segment('Correct'))
    type(fields()[0]!, '8500')
    type(fields()[1]!, 'watch mis-logged steps')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(posted).not.toBeNull()
    expect(posted!['action']).toBe('correct')
    expect(posted!['correctedValue']).toBe(8500)
    expect(posted!['targetKey']).toBe(dayMetricTarget(TARGET))
  })

  // Both applied-outcome tests further down submit on the default exclude tab, which proves the
  // gate exists but not that the correct branch reaches the same onSuccess wiring: a mutate call
  // with its own inline `{ onSuccess }` per action is exactly the shape where one branch could
  // close unconditionally while its sibling stayed gated, and the suite would not notice.
  it('closes the panel once a correction has applied', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: true,
    })) as typeof fetch

    let closed = false
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => { closed = true }} />))
    click(segment('Correct'))
    type(fields()[0]!, '8500')
    type(fields()[1]!, 'watch mis-logged steps')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(closed).toBe(true)
  })

  it('stays open and reports not yet applied for a correction that has not applied', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => respond(200, {
      id: 'o1', affected: { from: '2026-08-15', to: '2026-08-15' }, applied: false,
    })) as typeof fetch

    let closed = false
    mount(withSession(<AnnotatePanel target={TARGET} onClose={() => { closed = true }} />))
    click(segment('Correct'))
    type(fields()[0]!, '8500')
    type(fields()[1]!, 'watch mis-logged steps')
    click(submitButton())
    await settle()
    globalThis.fetch = original

    expect(closed).toBe(false)
    expect(container!.textContent).toContain('The correction is saved. The numbers behind it have not caught up yet.')
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
  it('stays open and reports the correction is saved but not yet applied', async () => {
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
    expect(container!.textContent).toContain('The correction is saved. The numbers behind it have not caught up yet.')
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
