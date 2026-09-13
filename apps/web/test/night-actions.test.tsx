// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { Night } from '../src/data/useNights.js'
import { NightSessions } from '../src/pages/sleep/NightSessions.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false,
  timezone: 'Europe/Amsterdam', connected: true, credentialsUnreadable: false,
  baseUrl: 'http://localhost:4235',
}

const NIGHT: Night = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1', 's2'],
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: ['s2'],
}

function mount(night: Night): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><NightSessions night={night} /></I18nProvider>
      </QueryClientProvider>,
    )
  })
  return client
}

describe('the night\'s sessions', () => {
  it('offers one control per session the night was assembled from', () => {
    mount(NIGHT)
    expect(container?.querySelectorAll('.night-session')).toHaveLength(2)
  })

  it('marks the session that is already excluded, rather than offering to exclude it again', () => {
    mount(NIGHT)
    const rows = [...(container?.querySelectorAll('.night-session') ?? [])]
    const excluded = rows.filter((row) => row.textContent?.includes('Excluded'))
    expect(excluded).toHaveLength(1)
    // The stronger half of the claim: the excluded row itself carries no button, so there is no
    // way to click "exclude" on a session that is already excluded. An implementation that shows
    // the "Excluded" label ALONGSIDE the exclude button (rather than instead of it) would still
    // pass the count assertion above; this is the one that catches it.
    expect(excluded[0]?.querySelector('button')).toBeNull()
  })

  it('opens the annotate panel at session scope for the session whose control was clicked', () => {
    mount(NIGHT)
    const button = container?.querySelector('.night-session button') as HTMLButtonElement | null
    act(() => { button?.click() })
    const dialog = container?.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // Exclude and note only: correct is sample scope, and an event belongs to a day.
    expect(dialog?.textContent).toContain('Exclude')
    expect(dialog?.textContent).not.toContain('Correct')
  })
})
