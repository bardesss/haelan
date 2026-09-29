import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import type { SleepPeriodData } from '../src/data/periodTypes.js'

// The Sleep page's harness, shared by sleep-page.test.tsx and sleep-balance-card.test.tsx: a
// session, and a fetch stub answering every route the page calls. Synthetic throughout.

export const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true, birthDate: null, sex: null,
  sleepTargetMinutes: 480,
  sleepUseBaseline: true,
  quickLogEnabled: true,
  connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// The control row's own rebuild field: a status answer without it is a shape the route never sends.
const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

export const WATCH = {
  id: 'watch', externalId: 'com.example.watch', displayName: 'My watch', alias: null, name: 'My watch',
  kind: 'device', createdAtMs: 0,
}

export function withQuery(node: ReactNode): { client: QueryClient, tree: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), PERSON)
  return { client, tree: <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

export interface SleepStub {
  /** The /sleep/period answer; a function of the request's URL where a test needs it per range. */
  period: SleepPeriodData | ((url: string) => SleepPeriodData)
  /** The /sleep/nights items (useNights), for the schedule's naps. */
  nights?: unknown[]
  /** The /overrides items, for the balance's exclusions. */
  overrides?: unknown[]
  /** Answer /sleep/period with this status instead. */
  status?: number
  /** The /series answer (compare with last year's only reader), by request URL. */
  series?: (url: string) => unknown
}

/** Stubs fetch for the page; every URL asked is pushed to `urls`. Returns the restore. */
export function stubSleep(urls: string[], stub: SleepStub): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/sleep/period')) {
      if (stub.status !== undefined) return json({ error: 'refused' }, stub.status)
      return json(typeof stub.period === 'function' ? stub.period(url) : stub.period)
    }
    if (url.includes('/series') && stub.series !== undefined) return json(stub.series(url))
    if (url.includes('/sleep/nights')) return json({ items: stub.nights ?? [], cursor: null })
    if (url.includes('/sources')) return json({ items: [WATCH] })
    if (url.includes('/overrides')) return json({ items: stub.overrides ?? [] })
    if (url.includes('/notes') || url.includes('/events')) return json({ items: [] })
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}
