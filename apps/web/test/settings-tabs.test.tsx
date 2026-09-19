// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { Settings } from '../src/pages/Settings.js'
import { instanceUrlKey } from '../src/data/useInstanceUrl.js'
import { maintenanceKey } from '../src/data/useMaintenance.js'
import { membersKey } from '../src/data/useMembers.js'

/**
 * The tab strip Settings gained when the account sections moved to their own page.
 *
 * What these hold, which no section's own suite can: that the strip is navigation rather than a
 * control (its state is the url, so a reload and a shared link both land where the reader was),
 * and that the list of tabs is itself the admin gate - a member has no tab naming a section they
 * cannot use, so no query string can mount one for them.
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
  window.history.replaceState(null, '', '/')
})

const ADMIN: Session = {
  personId: 'admin-1', displayName: 'Admin', username: 'admin', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/**
 * Mounts the page at `path` as a given session.
 *
 * Every section the page can reach is seeded, not just the one a case is about: which tab renders
 * is the thing under test, so a case that guessed wrong would otherwise reach the real network
 * instead of failing on the assertion it was written for.
 */
function mountAt(path: string, overrides: Partial<Session> = {}): void {
  const session: Session = { ...ADMIN, ...overrides }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), session)
  client.setQueryData(membersKey(), { items: [] })
  client.setQueryData(instanceUrlKey(), { baseUrl: 'http://localhost:4235', redirectUri: 'http://localhost:4235/oauth/callback' })
  client.setQueryData(maintenanceKey(), {
    bytes: 1_000, bloat: { bytes: 0, fraction: 0 }, backups: { keep: 3, intervalHours: 24, last: null },
  })
  client.setQueryData(queryKeys.rebuildHealth(), { people: [] })
  window.history.replaceState(null, '', path)
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><Settings /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const tabNames = (): string[] =>
  [...container!.querySelectorAll('.settings-tabs a')].map((a) => a.textContent ?? '')

const currentTab = (): string | null =>
  container!.querySelector('.settings-tabs [aria-current="page"]')?.textContent ?? null

const cardLabels = (): string[] =>
  [...container!.querySelectorAll('.card > .label')].map((h) => h.textContent ?? '')

describe('the settings tabs', () => {
  it('opens on the first tab when the url names none', () => {
    mountAt('/settings')
    expect(tabNames()).toEqual(['Members', 'Instance', 'Info'])
    expect(currentTab()).toBe('Members')
    expect(cardLabels()).toEqual(['Members'])
  })

  it('opens the tab the url names, so a link and a reload land in the same place', () => {
    mountAt('/settings?tab=instance')
    expect(currentTab()).toBe('Instance')
    // All three of this tab's cards, in order: the address/maintenance pair was a half-width row
    // on the old page and stays one here, and the rebuild card joins them full width below rather
    // than needing a tab of its own.
    expect(cardLabels()).toEqual(['Instance address', 'Database maintenance', 'Rebuild health'])
  })

  it('links each tab to its own url rather than acting on the page in place', () => {
    mountAt('/settings')
    const hrefs = [...container!.querySelectorAll('.settings-tabs a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/settings?tab=members', '/settings?tab=instance', '/settings?tab=info'])
  })

  // A tab nobody has: a typo, a stale bookmark from before a tab was renamed, or a link to a tab
  // this reader is not allowed. All three land on a real tab rather than on an empty page.
  it('falls back to the first tab when the url names one that does not exist', () => {
    mountAt('/settings?tab=nonsense')
    expect(currentTab()).toBe('Members')
    expect(cardLabels()).toEqual(['Members'])
  })

  describe('for a member who is not an admin', () => {
    it('draws no strip at all, because a chooser of one is not a chooser', () => {
      mountAt('/settings', { isAdmin: false })
      expect(container!.querySelector('.settings-tabs')).toBeNull()
      expect(cardLabels()).toEqual(['About this instance'])
    })

    // The gate itself. The three admin sections are not merely hidden from the strip: naming one
    // in the url resolves against the tabs this reader has, which is only the last one.
    it('shows the info tab even when the url names an admin tab', () => {
      mountAt('/settings?tab=members', { isAdmin: false })
      expect(cardLabels()).toEqual(['About this instance'])
      expect(container!.textContent).not.toContain('Instance address')
    })
  })
})
