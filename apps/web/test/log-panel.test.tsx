// @vitest-environment happy-dom
// happy-dom: the panel is tapped, typed into and driven by keys for real, and its writes settle
// through a stubbed fetch the way use-quick-log.test.tsx lets its mutations settle.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
const YESTERDAY = '2026-09-22'
const OLDER = '2026-09-19'

interface Req { method: string, url: string, body: unknown }

let container: HTMLDivElement | null = null
let root: Root | null = null
let client: QueryClient | null = null
let requests: Req[] = []
let restoreFetch: (() => void) | null = null
/** The day as the stubbed server holds it, seeded by render() and changed by the writes below,
 *  so the refetch every write's invalidation starts answers what a real server would. */
let server: GlanceLog = glanceLog()
let nextId = 1
const eventKinds = new Map<string, string>()

/** A small stand-in for the five routes the panel calls. */
function fakeServer(req: Req): Response {
  const path = req.url.replace('/api/v1/p/p1', '')
  if (req.method === 'GET' && path.startsWith('/quick-log/day/')) return json(server)
  if (req.method === 'POST' && path === '/quick-log') {
    const { kind, day } = req.body as { kind: string, day: string }
    const id = `e${nextId++}`
    eventKinds.set(id, kind)
    server = { ...server, counts: { ...server.counts, [kind]: (server.counts[kind] ?? 0) + 1 } }
    return json({ id, kind, startedAtMs: 1, localDate: day })
  }
  if (req.method === 'DELETE' && path.startsWith('/events/')) {
    const kind = eventKinds.get(path.slice('/events/'.length))!
    server = { ...server, counts: { ...server.counts, [kind]: server.counts[kind]! - 1 } }
    return json({})
  }
  if (path.startsWith('/moods/')) {
    server = { ...server, mood: req.method === 'PUT' ? (req.body as { score: number }).score : null }
    return json({})
  }
  if (path.startsWith('/notes/')) {
    server = { ...server, note: req.method === 'PUT' ? (req.body as { body: string }).body : null }
    return json({})
  }
  return json({})
}

/** What the stubbed server answers; a case replaces it. A promise lets a case hold a request open. */
let handler: (req: Req) => Response | Promise<Response> = fakeServer

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
const failure = (message: string) => json({ error: { kind: 'bad_request', message } }, 400)

beforeEach(() => {
  requests = []
  handler = fakeServer
  nextId = 1
  eventKinds.clear()
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
  vi.useRealTimers()
})

interface Props { day?: string, initial?: GlanceLog | null }

/** Mounts (or re-renders) the panel; `initial: null` mounts it with no seed, as a stepped day is. */
function render({ day = TODAY, initial = glanceLog() }: Props = {}, steps: string[] = [], closes: number[] = []): void {
  client ??= new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.session(), PERSON)
  if (initial !== null) server = initial
  act(() => {
    root!.render(
      <I18nProvider lng="en"><QueryClientProvider client={client!}>
        <LogPanel day={day} today={TODAY} {...(initial === null ? {} : { initial })} titleId="log-title"
          onStep={(d) => steps.push(d)} onClose={() => closes.push(1)} />
      </QueryClientProvider></I18nProvider>,
    )
  })
}

beforeEach(() => { client = null })

const settle = () => flush(client!, () => document.body.innerHTML)
const byLabel = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const face = (name: string) => [...container!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!
const chip = (kind: string) => [...container!.querySelectorAll<HTMLButtonElement>('.log-chips button')]
  .find((b) => b.getAttribute('aria-label')!.startsWith(kind))!
const live = () => container!.querySelector('[aria-live="polite"]')!
const errors = () => [...container!.querySelectorAll('.log-error')].map((p) => p.textContent)
const note = () => container!.querySelector('textarea')!
const writes = () => requests.filter((r) => r.method !== 'GET')

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function key(el: Element, name: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { el.dispatchEvent(event) })
  return event
}
function type(el: HTMLTextAreaElement, value: string): void {
  // React tracks a textarea's value itself; setting it through the prototype's setter is what makes
  // the input event read as a change rather than as the value React already knows.
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function blur(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
}

describe('LogPanel title', () => {
  it('reads "Log for today" on today, with the next arrow disabled', () => {
    render()
    const h2 = container!.querySelector('h2')!
    expect(h2.id).toBe('log-title')
    expect(h2.textContent).toBe('Log for today')
    expect(container!.querySelector('.log-title small')!.textContent).toBe('Wednesday, September 23')
    expect(byLabel('Next day')!.getAttribute('aria-disabled')).toBe('true')
    const steps: string[] = []
    render({}, steps)
    click(byLabel('Next day')!)
    expect(steps).toEqual([])
  })

  // happy-dom applies no stylesheet, so the rule itself is read: P2 fades the whole › on today,
  // border included, to .35, rather than greying only its icon inside a full-strength border.
  it('fades the whole disabled arrow, not only its icon, with a plain cursor', () => {
    const css = readFileSync('apps/web/src/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
    const rule = /\.log-top \.icon-button\[aria-disabled='true'\] \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/opacity: \.35;/)
    expect(rule).toMatch(/cursor: default;/)
    expect(rule).not.toMatch(/(^|[^-])color:/)
  })

  it('steps back with the previous arrow, then reads "Log for yesterday" with next enabled', () => {
    const steps: string[] = []
    render({}, steps)
    click(byLabel('Previous day')!)
    expect(steps).toEqual([YESTERDAY])
    render({ day: YESTERDAY }, steps)
    expect(container!.querySelector('h2')!.textContent).toBe('Log for yesterday')
    expect(byLabel('Next day')!.getAttribute('aria-disabled')).toBeNull()
    click(byLabel('Next day')!)
    expect(steps).toEqual([YESTERDAY, TODAY])
  })

  it('names an older day by its weekday and date', () => {
    render({ day: OLDER })
    expect(container!.querySelector('h2')!.textContent).toBe('Log for Sat, Sep 19')
    expect(container!.querySelector('.log-title small')!.textContent).toBe('Saturday, September 19')
  })

  it('closes on the close button', () => {
    const closes: number[] = []
    render({}, [], closes)
    click(byLabel('Close')!)
    expect(closes).toEqual([1])
  })
})

describe('LogPanel mood', () => {
  it('sets a face at once and sends it, then clears it on a second tap', async () => {
    render()
    click(face('Good'))
    expect(face('Good').getAttribute('aria-checked')).toBe('true')
    await settle()
    expect(writes()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/moods/${TODAY}`, body: { score: 4 } }])
    click(face('Good'))
    expect(face('Good').getAttribute('aria-checked')).toBe('false')
    await settle()
    expect(writes()[1]).toEqual({ method: 'DELETE', url: `/api/v1/p/p1/moods/${TODAY}`, body: null })
  })

  it('returns the mark and shows the server message when the write fails', async () => {
    handler = (req) => req.method === 'PUT' ? failure('score out of range') : fakeServer(req)
    render({ initial: glanceLog({ mood: 2 }) })
    click(face('Good'))
    expect(face('Good').getAttribute('aria-checked')).toBe('true')
    await settle()
    expect(face('Good').getAttribute('aria-checked')).toBe('false')
    expect(face('Poor').getAttribute('aria-checked')).toBe('true')
    expect(errors()).toEqual(['score out of range'])
  })

  it('moves and selects with the arrow keys, Home and End', async () => {
    render({ initial: glanceLog({ mood: 4 }) })
    key(face('Good'), 'ArrowRight')
    expect(face('Great').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(face('Great'))
    key(face('Great'), 'Home')
    expect(face('Bad').getAttribute('aria-checked')).toBe('true')
    key(face('Bad'), 'End')
    expect(face('Great').getAttribute('aria-checked')).toBe('true')
    await settle()
    expect(writes().map((r) => r.body)).toEqual([{ score: 5 }, { score: 1 }, { score: 5 }])
  })
})

describe('LogPanel chips', () => {
  it('names each chip by its count, and counts a tap before the server answers', async () => {
    let release: () => void = () => {}
    handler = (req) => req.method === 'POST'
      ? new Promise<Response>((resolve) => { release = () => resolve(fakeServer(req)) })
      : fakeServer(req)
    render({ initial: glanceLog({ presets: ['caffeine', 'sauna'], counts: { caffeine: 1 } }) })
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 1 today')
    expect(chip('sauna').getAttribute('aria-label')).toBe('sauna')
    expect(chip('sauna').textContent).toBe('sauna')
    click(chip('Caffeine'))
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 2 today')
    await pumpUntil(() => writes().length > 0, 'the tap request')
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 2 today')
    expect(writes()).toEqual([{ method: 'POST', url: '/api/v1/p/p1/quick-log', body: { kind: 'caffeine', day: TODAY } }])
    release()
    await settle()
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 2 today')
  })

  it('takes the count back and shows the message when a tap fails', async () => {
    handler = (req) => req.method === 'POST' ? failure('quick logging is off') : fakeServer(req)
    render({ initial: glanceLog({ counts: { caffeine: 1 } }) })
    click(chip('Caffeine'))
    await settle()
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 1 today')
    expect(errors()).toEqual(['quick logging is off'])
  })

  it('says "that day" on a past day', () => {
    render({ day: OLDER, initial: glanceLog({ counts: { alcohol: 3 } }) })
    expect(chip('Alcohol').getAttribute('aria-label')).toBe('Alcohol, 3 that day')
  })
})

describe('LogPanel undo', () => {
  it('offers Undo for the tap, which deletes the event and lowers the count', async () => {
    render({ initial: glanceLog({ counts: { caffeine: 1 } }) })
    click(chip('Caffeine'))
    await settle()
    expect(live().textContent).toBe('Caffeine loggedUndo')
    click([...live().querySelectorAll('button')].find((b) => b.textContent === 'Undo')!)
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 1 today')
    expect(live().textContent).toBe('')
    await settle()
    expect(writes()[1]).toEqual({ method: 'DELETE', url: '/api/v1/p/p1/events/e1', body: null })
    expect(chip('Caffeine').getAttribute('aria-label')).toBe('Caffeine, 1 today')
  })

  it('clears the line after ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    render()
    click(chip('Caffeine'))
    // flush() sleeps on setTimeout, which is faked here; the tap settles on microtasks alone.
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
    await pumpUntilLine()
    expect(live().textContent).toBe('Caffeine loggedUndo')
    act(() => { vi.advanceTimersByTime(9_999) })
    expect(live().textContent).toBe('Caffeine loggedUndo')
    act(() => { vi.advanceTimersByTime(1) })
    expect(live().textContent).toBe('')
  })

  it('keeps the latest tap undoable when an earlier one settles after it', async () => {
    // The server files both taps as they arrive (e1, then e2), but the first answer is held back
    // until the second has already settled.
    let releaseFirst: () => void = () => {}
    handler = (req) => {
      if (req.method !== 'POST' || (req.body as { kind: string }).kind !== 'alcohol') return fakeServer(req)
      const answer = fakeServer(req)
      return new Promise<Response>((resolve) => { releaseFirst = () => resolve(answer) })
    }
    render()
    click(chip('Alcohol'))
    await pumpUntil(() => writes().length === 1, 'the first tap')
    click(chip('Caffeine'))
    await pumpUntil(() => live().textContent !== '', 'the second tap line')
    expect(live().textContent).toBe('Caffeine loggedUndo')
    releaseFirst()
    await settle()
    expect(live().textContent).toBe('Caffeine loggedUndo')
    click([...live().querySelectorAll('button')].find((b) => b.textContent === 'Undo')!)
    await settle()
    expect(writes().at(-1)).toEqual({ method: 'DELETE', url: '/api/v1/p/p1/events/e2', body: null })
  })

  it('gives a new tap its own ten seconds, clearing the old line\'s timer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    render()
    click(chip('Caffeine'))
    await pumpUntilLine()
    expect(live().textContent).toBe('Caffeine loggedUndo')
    act(() => { vi.advanceTimersByTime(6_000) })
    click(chip('Alcohol'))
    await pumpUntilLine()
    expect(live().textContent).toBe('Alcohol loggedUndo')
    // 12 s after the first tap, 6 s after the second: the first line's timer would have fired at 10.
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(live().textContent).toBe('Alcohol loggedUndo')
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(live().textContent).toBe('')
  })

  it('names the day on a past day', async () => {
    render({ day: OLDER })
    click(chip('Caffeine'))
    await settle()
    expect(live().textContent).toBe('Caffeine logged for Saturday, September 19Undo')
    expect(writes()[0]!.body).toEqual({ kind: 'caffeine', day: OLDER })
  })
})

/** Microtask pumping for the fake-timer case, where flush()'s own setTimeout never fires. */
async function pumpUntilLine(): Promise<void> {
  for (let i = 0; i < 200 && live().textContent === ''; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('LogPanel note', () => {
  it('saves on blur what was typed', async () => {
    render()
    type(note(), 'Late dinner')
    blur(note())
    await settle()
    expect(writes()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Late dinner' } }])
  })

  it('saves on Enter without inserting a newline, and Shift+Enter is left alone', async () => {
    render()
    type(note(), 'Slept badly')
    const shifted = key(note(), 'Enter', true)
    expect(shifted.defaultPrevented).toBe(false)
    expect(writes()).toEqual([])
    const plain = key(note(), 'Enter')
    expect(plain.defaultPrevented).toBe(true)
    await settle()
    expect(writes()).toEqual([{ method: 'PUT', url: `/api/v1/p/p1/notes/${TODAY}`, body: { body: 'Slept badly' } }])
  })

  it('sends nothing for an unchanged note', async () => {
    render({ initial: glanceLog({ note: 'Birthday' }) })
    expect(note().value).toBe('Birthday')
    blur(note())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(writes()).toEqual([])
  })

  it('deletes the note when cleared', async () => {
    render({ initial: glanceLog({ note: 'Birthday' }) })
    type(note(), '')
    blur(note())
    await settle()
    expect(writes()).toEqual([{ method: 'DELETE', url: `/api/v1/p/p1/notes/${TODAY}`, body: null }])
  })

  it('resets to the loaded note when the day changes', () => {
    render({ initial: glanceLog({ note: 'Birthday' }) })
    type(note(), 'half typed')
    render({ day: YESTERDAY, initial: glanceLog({ note: 'Travel day' }) })
    expect(note().value).toBe('Travel day')
  })
})

describe('LogPanel stepped day', () => {
  it('asks for the day and shows the title and a placeholder until it arrives', async () => {
    let release: (r: Response) => void = () => {}
    handler = (req) => req.url.includes('/quick-log/day/')
      ? new Promise<Response>((resolve) => { release = resolve })
      : fakeServer(req)
    render({ day: OLDER, initial: null })
    await pumpUntil(() => requests.length > 0, 'the day request')
    expect(requests.map((r) => r.url)).toEqual([`/api/v1/p/p1/quick-log/day/${OLDER}`])
    expect(container!.querySelector('h2')!.textContent).toBe('Log for Sat, Sep 19')
    expect(container!.textContent).toContain('Loading')
    expect(container!.querySelector('[role="radiogroup"]')).toBeNull()
    release(json(glanceLog({ mood: 3 })))
    await settle()
    expect(face('Okay').getAttribute('aria-checked')).toBe('true')
  })

  it('offers a retry when the day fails to load', async () => {
    handler = () => json({ error: { kind: 'internal', message: 'boom' } }, 500)
    render({ day: OLDER, initial: null })
    await settle()
    expect(container!.querySelector('[role="radiogroup"]')).toBeNull()
    expect([...container!.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true)
  })
})
