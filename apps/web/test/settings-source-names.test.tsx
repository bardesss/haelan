// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { SourceNames } from '../src/pages/settings/SourceNames.js'
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
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: false, timezone: 'Europe/Amsterdam',
}

/**
 * Same shape as source-names.test.tsx's own mount: a fresh QueryClient per test, the session
 * pre-seeded so useSession() never has to fetch, and the sources query pre-seeded under the same
 * key useSourceNames/useRenameSource/useClearSourceName all share (sourceNamesKey). An unseeded
 * query would reach the real network in this environment rather than merely running slow (see
 * apps/web/test/control-row.test.tsx's own comment on withQuery), so every test here seeds it
 * even the one passing an empty list.
 */
function mountSection(sources: NamedSource[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  client.setQueryData(sourceNamesKey(PERSON.personId), { items: sources })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><SourceNames /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const inputValues = (): string[] =>
  [...container!.querySelectorAll('input')].map((i) => i.value)

const placeholders = (): string[] =>
  [...container!.querySelectorAll('input')].map((i) => i.getAttribute('placeholder') ?? '')

const rowDetail = (index: number): string =>
  [...container!.querySelectorAll('.source-name-detail')][index]?.textContent ?? ''

describe('the source names section', () => {
  it('shows the current name, the provider name and the id for each source', () => {
    mountSection([
      { id: 'abc123', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', alias: 'My watch', name: 'My watch', kind: 'device', createdAtMs: 0 },
    ])
    // The whole value, not a substring: toContain('My watch') would also pass on the id.
    expect(inputValues()).toEqual(['My watch'])
    expect(rowDetail(0)).toBe('Pixel Watch 4 - abc123')
  })

  it('offers an empty field for a source nobody named, with the provider name as the placeholder', () => {
    mountSection([
      { id: 'abc123', externalId: 'x', displayName: 'com.lyfta', alias: null, name: 'com.lyfta', kind: 'app', createdAtMs: 0 },
    ])
    expect(inputValues()).toEqual([''])
    expect(placeholders()).toEqual(['com.lyfta'])
  })

  it('says so when the person has no sources yet', () => {
    mountSection([])
    // A container holding a whole section, not a single name or label cell, so a substring match
    // here does not hide a format regression the way it would on inputValues/rowDetail above.
    expect(container!.textContent).toContain('Nothing has reported data yet')
  })
})
