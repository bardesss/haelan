// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Account } from '../src/pages/Account.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'

/**
 * The page the account sections moved to when Settings split in two.
 *
 * One thing to hold, and it is the split itself: which sections live here. Each section's own
 * suite already covers what it does; what none of them can say is that the line the page is drawn
 * along stayed where it was put - everything acting on the reader, nothing acting on the instance,
 * and the same page whoever is looking at it.
 */
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

const SESSION: Session = {
  personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function mountAs(overrides: Partial<Session> = {}): void {
  const session: Session = { ...SESSION, ...overrides }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  client.setQueryData(sourceNamesKey(session.personId), { items: [] })
  client.setQueryData(queryKeys.resource(session.personId, 'overrides'), { items: [] })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Account /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const cardLabels = (): string[] =>
  [...container!.querySelectorAll('.card > .label')].map((label) => label.textContent ?? '')

describe('the account page', () => {
  it('holds every section that acts on the reader, in reading order', () => {
    mountAs()
    expect(cardLabels()).toEqual([
      'Your account', 'What to sync', 'Agent access', 'Corrections and exclusions', 'Source names',
    ])
  })

  // The half of the split that is easy to lose later: an instance-wide section added here would
  // be invisible to the admin gate, since this page has none - it does not need one, because
  // nothing on it is gated in the first place.
  it('holds no instance-wide section, for an admin any more than for a member', () => {
    mountAs({ isAdmin: true })
    expect(container!.textContent).not.toContain('Members')
    expect(container!.textContent).not.toContain('Instance address')
    expect(container!.textContent).not.toContain('Database maintenance')
    expect(container!.textContent).not.toContain('About this instance')
  })
})
