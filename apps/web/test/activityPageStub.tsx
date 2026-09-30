import type { ActivityPeriodData } from '../src/data/periodTypes.js'
import { PERSON, WATCH } from './sleepPageStub.js'

// The Activity page's fetch stub, beside the Sleep page's (sleepPageStub.tsx, whose session and
// query harness it shares): every route the page calls. Synthetic throughout.

// The control row's own rebuild field: a status answer without it is a shape the route never sends.
const NO_REBUILD_NEWS = { quarantined: false, droppedPages: 0, lastError: null, drops: [] }

export interface ActivityStub {
  /** The /activity/period answer; a function of the request's URL where a test needs it per range. */
  period: ActivityPeriodData | ((url: string) => ActivityPeriodData)
  /** Answer /activity/period with this status instead. */
  status?: number
  /** The /series answer (compare with last year's only reader), by request URL. */
  series?: (url: string) => unknown
}

/** Stubs fetch for the page; every URL asked is pushed to `urls`. Returns the restore. */
export function stubActivity(urls: string[], stub: ActivityStub): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/auth/me')) return json(PERSON)
    if (url.includes('/activity/period')) {
      if (stub.status !== undefined) return json({ error: 'refused' }, stub.status)
      return json(typeof stub.period === 'function' ? stub.period(url) : stub.period)
    }
    if (url.includes('/series') && stub.series !== undefined) return json(stub.series(url))
    if (url.includes('/sources')) return json({ items: [WATCH] })
    if (url.includes('/overrides') || url.includes('/notes') || url.includes('/events')) return json({ items: [] })
    if (url.includes('/api/sync/status')) return json({ running: false, lastFinishedAtMs: null, rebuild: NO_REBUILD_NEWS })
    return json({})
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}
