// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { StrictMode, act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

// apps/server's own test harness from apps/web/test: allowed in a test file, for the reason
// e2e-dashboard.test.tsx gives at its imports.
import { withServer } from '../../server/test/harness.ts'
import type { Harness } from '../../server/test/harness.ts'

import { App } from '../src/Shell.js'
import { createBoundQueryClient } from '../src/api/queryClient.js'
import { I18nProvider } from '../src/i18n/index.js'
import { ErrorBoundary } from '../src/components/ErrorBoundary.js'
import { flush } from './flush.js'
import { fetchThroughServer } from './fetchThroughServer.js'

/**
 * The quick-log panel against the real server (M9c): the one test that fails when the web's mirror
 * of the glance's `log` (GlanceLog in useGlance.ts) and the server's shape part ways, since every
 * other panel test reads a fixture. The switch is set in the store before sign-in, the way the
 * Profile card's PUT would leave it.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

/** The person's today by the harness's pinned clock, in the zone signIn gives 'p1'. */
function todayOf(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(nowMs))
}

async function mountApp(harness: Harness, enabled: boolean): Promise<QueryClient> {
  // The page's own today comes from the browser's clock (Dashboard.tsx's localToday) and the
  // server's from the harness's pinned one; left apart, a tap on "today" is a day the server calls
  // the future. Only Date is faked, the way the demo build freezes it (frozenClock.ts), so every
  // timer the render and its refetches wait on still runs.
  vi.useFakeTimers({ toFake: ['Date'], now: harness.clock.nowMs })
  await harness.completeSetup()
  harness.app.haelan.stores.people.setQuickLogEnabled('p1', enabled)
  const cookie = await harness.signIn()
  globalThis.fetch = fetchThroughServer(harness.app, cookie)
  const client = createBoundQueryClient()
  act(() => {
    root?.render(
      <StrictMode>
        <I18nProvider lng="en">
          <QueryClientProvider client={client}>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </QueryClientProvider>
        </I18nProvider>
      </StrictMode>,
    )
  })
  await flush(client, () => document.body.innerHTML)
  return client
}

const logButton = () => container!.querySelector<HTMLButtonElement>('button.log-btn')
const panel = () => document.querySelector<HTMLElement>('[data-log-panel]')
const chip = (text: string) => [...panel()!.querySelectorAll<HTMLButtonElement>('.log-chip')]
  .find((button) => button.firstChild?.textContent === text)
const face = (label: string) => [...panel()!.querySelectorAll<HTMLButtonElement>('.log-face')]
  .find((button) => button.textContent === label)

describe('quick logging, through a real server and a real render', () => {
  it('logs a tap, a mood and a note from the Log button, and the server answers them back', async () => {
    const harness = await withServer()
    const originalFetch = globalThis.fetch
    try {
      const client = await mountApp(harness, true)
      const settle = () => flush(client, () => document.body.innerHTML)
      const today = todayOf(harness.clock.nowMs)

      expect(logButton()).not.toBeNull()
      act(() => { logButton()!.click() })
      await settle()
      expect(panel()?.querySelector('h2')?.textContent).toBe('Log for today')
      // The six seed chips, from the server's own quickLogPresetsOf, none counted yet.
      expect(chip('Caffeine')?.getAttribute('aria-label')).toBe('Caffeine')

      act(() => { chip('Caffeine')!.click() })
      await settle()
      // After the refetch, not only the optimistic count: the count the day log route read back.
      expect(chip('Caffeine')?.getAttribute('aria-label')).toBe('Caffeine, 1 today')
      const dayLog = await (await globalThis.fetch(`/api/v1/p/p1/quick-log/day/${today}`)).json() as { counts: Record<string, number> }
      expect(dayLog.counts).toEqual({ caffeine: 1 })

      act(() => { face('Good')!.click() })
      await settle()
      // Closed and opened again, so the mark is drawn from the refetched glance's `log.mood` and
      // not from the panel's own pending state.
      act(() => { logButton()!.click() })
      expect(panel()).toBeNull()
      act(() => { logButton()!.click() })
      await settle()
      expect(face('Good')?.getAttribute('aria-checked')).toBe('true')
      expect(panel()!.querySelectorAll('.log-face[aria-checked="true"]')).toHaveLength(1)

      const note = panel()!.querySelector<HTMLTextAreaElement>('textarea.log-note')!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Late dinner with friends.')
        note.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => { note.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
      await settle()
      const notes = await (await globalThis.fetch(`/api/v1/p/p1/notes?from=${today}&to=${today}`)).json() as { items: { localDate: string, body: string }[] }
      expect(notes.items.map(({ localDate, body }) => ({ localDate, body })))
        .toEqual([{ localDate: today, body: 'Late dinner with friends.' }])
    } finally {
      vi.useRealTimers()
      globalThis.fetch = originalFetch
      await harness.cleanup()
    }
  })

  it('draws no Log button while the switch is off', async () => {
    const harness = await withServer()
    const originalFetch = globalThis.fetch
    try {
      await mountApp(harness, false)
      // The dashboard did draw: its day navigator is there, only the button is not.
      expect(container!.querySelector('.day-nav')).not.toBeNull()
      expect(logButton()).toBeNull()
    } finally {
      vi.useRealTimers()
      globalThis.fetch = originalFetch
      await harness.cleanup()
    }
  })
})
