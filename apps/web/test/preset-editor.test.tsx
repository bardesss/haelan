// @vitest-environment happy-dom
// happy-dom: the editor is typed into, dragged and driven by keys for real, and Done settles
// through a stubbed fetch the way log-panel.test.tsx lets the panel's writes settle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PresetEditor } from '../src/components/logPanel/PresetEditor.js'
import { LogPanel } from '../src/components/logPanel/LogPanel.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { GlanceLog } from '../src/data/useGlance.js'
import { glanceLog } from './glanceFixture.js'
import { flush, pumpUntil } from './flush.js'

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
  birthDate: null, sex: null, sleepTargetMinutes: 480, sleepUseBaseline: true, quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

const TODAY = '2026-09-23'

interface Req { method: string, url: string, body: unknown }

let container: HTMLDivElement | null = null
let root: Root | null = null
let client: QueryClient | null = null
let requests: Req[] = []
let restoreFetch: (() => void) | null = null
/** The day as the stubbed server holds it; a saved list of chips lands in its presets. */
let server: GlanceLog = glanceLog()

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
const failure = (message: string) => json({ error: { kind: 'bad_request', message } }, 400)

function fakeServer(req: Req): Response {
  const path = req.url.replace('/api/v1/p/p1', '')
  if (req.method === 'GET' && path.startsWith('/quick-log/day/')) return json(server)
  if (req.method === 'PUT' && path === '/quick-log/presets') {
    const { kinds } = req.body as { kinds: string[] }
    server = { ...server, presets: kinds }
    return json({ kinds })
  }
  return json({})
}

let handler: (req: Req) => Response | Promise<Response> = fakeServer

beforeEach(() => {
  requests = []
  handler = fakeServer
  client = null
  server = glanceLog()
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
    }
    requests.push(req)
    return handler(req)
  }) as typeof fetch
  restoreFetch = () => { globalThis.fetch = original }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  restoreFetch?.()
})

function newClient(): QueryClient {
  client ??= new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return client
}

/** Mounts the editor alone, counting its onDone and onCancel calls. */
function renderEditor(kinds: string[], suggestions: string[] = [], calls = { done: 0, cancel: 0 }): typeof calls {
  const queryClient = newClient()
  act(() => {
    root!.render(
      <I18nProvider lng="en"><QueryClientProvider client={queryClient}>
        <PresetEditor kinds={kinds} suggestions={suggestions}
          onDone={() => { calls.done++ }} onCancel={() => { calls.cancel++ }} />
      </QueryClientProvider></I18nProvider>,
    )
  })
  return calls
}

const settle = () => flush(client!, () => document.body.innerHTML)
const items = () => [...container!.querySelectorAll<HTMLElement>('.log-edit-item')]
const names = () => items().map((li) => li.querySelector('.log-edit-name')!.textContent)
const item = (name: string) => items().find((li) => li.querySelector('.log-edit-name')!.textContent === name)!
const button = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const byLabel = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const field = () => container!.querySelector<HTMLInputElement>('input')!
const errors = () => [...container!.querySelectorAll('.log-error')].map((p) => p.textContent)
const announced = () => container!.querySelector('.log-editor [aria-live="polite"]')!.textContent
const writes = () => requests.filter((r) => r.method !== 'GET')

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function key(el: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  act(() => { el.dispatchEvent(event) })
  return event
}
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** One act() per drag event, as a real pointer delivers them one at a time. */
function drag(el: Element, type: string): void {
  act(() => { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })) })
}

describe('PresetEditor', () => {
  it('removes a kind with its remove button', () => {
    renderEditor(['caffeine', 'sauna', 'alcohol'])
    expect(names()).toEqual(['Caffeine', 'sauna', 'Alcohol'])
    click(byLabel('Remove sauna'))
    expect(names()).toEqual(['Caffeine', 'Alcohol'])
    click(byLabel('Remove Caffeine'))
    expect(names()).toEqual(['Alcohol'])
  })

  it('adds a trimmed kind on Enter and clears the field', () => {
    renderEditor(['caffeine'])
    type(field(), '  sauna ')
    const enter = key(field(), 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(names()).toEqual(['Caffeine', 'sauna'])
    expect(field().value).toBe('')
    expect(errors()).toEqual([])
  })

  it('refuses a duplicate with the validation message and keeps what was typed', () => {
    renderEditor(['caffeine', 'alcohol'])
    type(field(), 'Alcohol')
    key(field(), 'Enter')
    expect(names()).toEqual(['Caffeine', 'Alcohol'])
    expect(errors()).toEqual(['kind 3 repeats "alcohol"'])
    expect(field().value).toBe('Alcohol')
  })

  it('offers the suggestions not already in the list', () => {
    renderEditor(['caffeine'], ['sauna', 'caffeine', 'travel'])
    const options = [...container!.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['sauna', 'travel'])
    expect(field().getAttribute('list')).toBe(container!.querySelector('datalist')!.id)
  })

  it('moves a focused kind with the arrow keys, keeps it focused and announces the move', () => {
    renderEditor(['caffeine', 'sauna', 'alcohol'])
    const right = key(item('Caffeine'), 'ArrowRight')
    expect(right.defaultPrevented).toBe(true)
    expect(names()).toEqual(['sauna', 'Caffeine', 'Alcohol'])
    expect(document.activeElement).toBe(item('Caffeine'))
    expect(announced()).toBe('Caffeine moved to position 2')
    key(item('Caffeine'), 'ArrowLeft')
    key(item('Caffeine'), 'ArrowLeft')
    expect(names()).toEqual(['Caffeine', 'sauna', 'Alcohol'])
    expect(announced()).toBe('Caffeine moved to position 1')
  })

  it('reorders by dragging one kind onto another', () => {
    renderEditor(['caffeine', 'sauna', 'alcohol'])
    expect(item('Alcohol').getAttribute('draggable')).toBe('true')
    drag(item('Alcohol'), 'dragstart')
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    act(() => { item('Caffeine').dispatchEvent(over) })
    // A drop target has to cancel dragover, or the browser never delivers the drop.
    expect(over.defaultPrevented).toBe(true)
    drag(item('Caffeine'), 'drop')
    drag(item('Alcohol'), 'dragend')
    expect(names()).toEqual(['Alcohol', 'Caffeine', 'sauna'])
    expect(announced()).toBe('Alcohol moved to position 1')
  })

  it('saves the new order on Done and then calls onDone', async () => {
    const calls = renderEditor(['caffeine', 'sauna', 'alcohol'])
    key(item('Alcohol'), 'ArrowLeft')
    click(byLabel('Remove sauna'))
    click(button('Done'))
    await settle()
    expect(writes()).toEqual([{ method: 'PUT', url: '/api/v1/p/p1/quick-log/presets', body: { kinds: ['caffeine', 'alcohol'] } }])
    expect(calls).toEqual({ done: 1, cancel: 0 })
  })

  it('keeps the editor open with the server message when Done fails', async () => {
    handler = (req) => req.method === 'PUT' ? failure('kinds holds at most 16') : fakeServer(req)
    const calls = renderEditor(['caffeine'])
    click(button('Done'))
    await settle()
    expect(calls).toEqual({ done: 0, cancel: 0 })
    expect(errors()).toEqual(['kinds holds at most 16'])
    expect(names()).toEqual(['Caffeine'])
  })

  it('discards on Escape without a request, and the key goes no further', async () => {
    const seen: string[] = []
    const spy = (event: KeyboardEvent) => { seen.push(event.key) }
    document.addEventListener('keydown', spy)
    try {
      const calls = renderEditor(['caffeine', 'sauna'])
      click(byLabel('Remove sauna'))
      key(item('Caffeine'), 'Escape')
      await settle()
      expect(calls).toEqual({ done: 0, cancel: 1 })
      expect(writes()).toEqual([])
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', spy)
    }
  })

  it('discards on Cancel', () => {
    const calls = renderEditor(['caffeine'])
    click(button('Cancel'))
    expect(calls).toEqual({ done: 0, cancel: 1 })
    expect(writes()).toEqual([])
  })

  it('disables adding at 16 kinds, and says why', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => `kind${i + 1}`)
    renderEditor(sixteen)
    expect(field().disabled).toBe(true)
    expect(container!.textContent).toContain('At most 16 chips')
    click(byLabel('Remove kind16'))
    expect(field().disabled).toBe(false)
    expect(container!.textContent).not.toContain('At most 16 chips')
  })
})

describe('LogPanel edit mode', () => {
  function renderPanel(): void {
    const queryClient = newClient()
    const initial = glanceLog({ presets: ['caffeine', 'sauna'], counts: { alcohol: 2 } })
    server = initial
    act(() => {
      root!.render(
        <I18nProvider lng="en"><QueryClientProvider client={queryClient}>
          <LogPanel day={TODAY} today={TODAY} initial={initial} titleId="log-title" onStep={() => {}} onClose={() => {}} />
        </QueryClientProvider></I18nProvider>,
      )
    })
  }
  const chips = () => [...container!.querySelectorAll('.log-chips button')].map((b) => b.textContent)

  it('opens the editor in place of the chips, offering the day\'s kinds and the seed set', () => {
    renderPanel()
    click(button('Edit'))
    expect(container!.querySelector('.log-chips')).toBeNull()
    expect(names()).toEqual(['Caffeine', 'sauna'])
    const options = [...container!.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['alcohol', 'illness', 'travel', 'medication', 'injury'])
    // The mood stays in reach while editing.
    expect(container!.querySelector('[role="radiogroup"]')).not.toBeNull()
  })

  it('returns to the chips on Done, drawn from the saved list', async () => {
    renderPanel()
    click(button('Edit'))
    key(item('sauna'), 'ArrowLeft')
    click(button('Done'))
    await settle()
    expect(container!.querySelector('.log-editor')).toBeNull()
    expect(chips()).toEqual(['sauna', 'Caffeine'])
    expect(document.activeElement).toBe(button('Edit'))
  })

  it('keeps the editor up until the refetch brings the saved list, never showing the old order', async () => {
    let release: () => void = () => {}
    handler = (req) => req.method === 'GET'
      ? new Promise<Response>((resolve) => { release = () => resolve(fakeServer(req)) })
      : fakeServer(req)
    renderPanel()
    click(button('Edit'))
    key(item('sauna'), 'ArrowLeft')
    click(button('Done'))
    await pumpUntil(() => requests.some((r) => r.method === 'GET'), 'the refetch after saving')
    expect(container!.querySelector('.log-chips')).toBeNull()
    expect(names()).toEqual(['sauna', 'Caffeine'])
    release()
    await settle()
    expect(chips()).toEqual(['sauna', 'Caffeine'])
  })

  it('returns to the unchanged chips on Cancel', () => {
    renderPanel()
    click(button('Edit'))
    click(byLabel('Remove sauna'))
    click(button('Cancel'))
    expect(chips()).toEqual(['Caffeine', 'sauna'])
    expect(writes()).toEqual([])
  })
})
