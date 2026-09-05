// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { ControlRow } from '../src/components/ControlRow.js'
import type { PageControlsState } from '../src/controls/usePageControls.js'
import { syncStatusKey } from '../src/data/useSyncStatus.js'
import { sourceNamesKey } from '../src/data/useSourceNames.js'
import type { NamedSource } from '../src/data/useSourceNames.js'

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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam', connected: true, baseUrl: 'http://localhost:4235',
}

const named = (id: string, displayName: string, alias: string | null): NamedSource => ({
  id, externalId: `x:${id}`, displayName, alias,
  name: alias ?? (displayName === '' ? id : displayName),
  kind: 'device', createdAtMs: 0,
})

const CONTROLS: PageControlsState = {
  tab: 'week', anchor: '2026-08-30', source: '12e34bba19af18604590e870380d9c6e',
  from: '2026-08-24', to: '2026-08-30', historicalTo: '2026-08-30',
  setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
}

function mount(node: ReactNode, sources: NamedSource[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(syncStatusKey(PERSON.personId), { running: false, lastFinishedAtMs: null })
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: sources })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">{node}</I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const optionLabels = (): string[] =>
  [...container!.querySelectorAll('option')].map((o) => o.textContent ?? '')

describe('the source picker', () => {
  it('labels a source with the name its person gave it', () => {
    mount(
      <ControlRow controls={CONTROLS} sources={['12e34bba19af18604590e870380d9c6e']} syncedMinutesAgo={1} />,
      [named('12e34bba19af18604590e870380d9c6e', 'Pixel Watch 4', 'My watch')],
    )
    // The whole label, not a substring: toContain('My watch') would also pass on the id.
    expect(optionLabels()).toEqual(['All sources', 'My watch'])
  })

  it('falls back to the provider name when nobody set one', () => {
    mount(
      <ControlRow controls={CONTROLS} sources={['12e34bba19af18604590e870380d9c6e']} syncedMinutesAgo={1} />,
      [named('12e34bba19af18604590e870380d9c6e', 'Pixel Watch 4', null)],
    )
    expect(optionLabels()).toEqual(['All sources', 'Pixel Watch 4'])
  })

  // The whole point of nameOf returning the id: a failed or unanswered names query must leave the
  // picker exactly as usable as it is today, never blank.
  it('falls back to the id when the names are not there', () => {
    mount(
      <ControlRow controls={CONTROLS} sources={['12e34bba19af18604590e870380d9c6e']} syncedMinutesAgo={1} />,
      [],
    )
    expect(optionLabels()).toEqual(['All sources', '12e34bba19af18604590e870380d9c6e'])
  })

  it('keeps the option value as the id, so the query is unchanged', () => {
    mount(
      <ControlRow controls={CONTROLS} sources={['12e34bba19af18604590e870380d9c6e']} syncedMinutesAgo={1} />,
      [named('12e34bba19af18604590e870380d9c6e', 'Pixel Watch 4', 'My watch')],
    )
    expect([...container!.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toEqual(['all', '12e34bba19af18604590e870380d9c6e'])
  })
})
