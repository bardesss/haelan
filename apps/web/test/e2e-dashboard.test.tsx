// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { StrictMode, act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Importing @haelan/core's root export and apps/server's own test harness from apps/web/test is
// deliberate and allowed here, not an accidental violation of the rule (see
// apps/web/src/data/useSourceNames.ts's own comment) that apps/web's SHIPPED code only reaches
// @haelan/core through its browser-safe subpaths (./metrics, ./coverage-signal, ...): that rule
// exists because the root export reaches better-sqlite3 and argon2, native modules no browser
// bundle can carry. A test file is never bundled or shipped. This is also the one test in the
// suite that needs a real server behind the render, and a real server needs a real database,
// which only the root export can open.
import { schema, DERIVATION_VERSION } from '@haelan/core'
import { withServer } from '../../server/test/harness.ts'
import type { Harness } from '../../server/test/harness.ts'

import { App } from '../src/Shell.js'
import { createBoundQueryClient } from '../src/api/queryClient.js'
import { I18nProvider } from '../src/i18n/index.js'
import { ErrorBoundary } from '../src/components/ErrorBoundary.js'
import { flush } from './flush.js'

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

function mount(node: ReactNode): void {
  act(() => { root?.render(node) })
}

const KNOWN_STEPS = 12_345
const SEEDED_DATE = '2026-08-15'

const NO_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Routes every request the mounted app makes through the real server, the way a browser reaching
 * it over a socket would - except the transport underneath is app.inject rather than a socket.
 *
 * app.inject resolves to a Fastify "light" response (statusCode, rawPayload, a headers object),
 * not a Response, and the app's own client code (apiSend in src/api/client.ts) reads
 * response.text(), response.ok and response.status. A stub that handed that code the injected
 * reply directly would work by accident on today's client and break the moment it read anything
 * else; building a real Response from the injected reply is what keeps this test exercising the
 * same contract a real browser fetch honours.
 *
 * The session cookie is attached by hand on every request. Nothing here is a browser with a
 * cookie jar, so nothing carries it automatically once signIn() below has it; this is the
 * "carries it the way a browser would" half of the replacement.
 */
// app.inject's own HTTPMethods type comes from fastify, which is not a dependency apps/web's own
// module resolution can see (apps/server has it, apps/web does not); named here rather than
// imported so this file never has to reach across that boundary for a type. This test only ever
// drives GET requests (the Dashboard mounts issues no mutation), but the union stays wide enough
// for the whole set app.inject actually accepts, so a future caller that does mutate is still
// typed rather than silently widened to string.
type InjectMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH'

function fetchThroughServer(app: Harness['app'], sessionCookie: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init.method ?? 'GET').toUpperCase() as InjectMethod
    // origin/host matter only to auth.ts's same-origin check on mutating methods (POST/PUT/etc),
    // which this test's GET-only Dashboard load never trips, but they are sent unconditionally so
    // this stays correct for any caller that does mutate.
    const headers: Record<string, string> = {
      cookie: `haelan_session=${sessionCookie}`,
      origin: 'http://localhost:4235',
      host: 'localhost:4235',
    }
    if (init.headers) {
      for (const [key, value] of new Headers(init.headers)) headers[key] = value
    }
    const injected = await app.inject({
      method, url, headers,
      payload: typeof init.body === 'string' ? init.body : undefined,
    })
    const responseHeaders = new Headers()
    const contentType = injected.headers['content-type']
    if (typeof contentType === 'string') responseHeaders.set('content-type', contentType)
    // .payload (a string), not .rawPayload (a Buffer): every response in this test is JSON text,
    // and DOM's BodyInit has no clean type for Node's Buffer. Response's constructor also throws
    // on a body paired with a status the spec says never carries one, which app.inject does not
    // enforce for its own payload the way a real HTTP stack does.
    const body = NO_BODY_STATUSES.has(injected.statusCode) ? null : injected.payload
    return new Response(body, { status: injected.statusCode, headers: responseHeaders })
  }) as typeof fetch
}

describe('the end to end path: a real server behind a real render', () => {
  // Parent section 14 has carried this open item since the beginning: one path proven from
  // sign-in through to a Dashboard drawing real numbers. The M3 dashboard milestone claimed it
  // would retire the item and did not. What existed before this test covered the wizard driven
  // against a real server (apps/server/test/e2e-setup.test.ts) and pages rendered against a
  // stubbed fetch (dashboard-round-trip.test.tsx); nothing connected a real server to a real
  // render. This is that one test, not the eight-per-page version the original milestone spec
  // asked for: the value is in proving the seam once, and eight copies would cost eight times the
  // maintenance to prove the same seam again.
  it('draws a seeded steps total on the Dashboard, through a real server and a real render', async () => {
    const harness = await withServer()
    const originalFetch = globalThis.fetch
    try {
      // One person (harness.signIn below completes the wizard for 'p1'/'bartus'), one derived
      // daily row carrying a known value. Written straight into the daily table, the same way
      // packages/core/src/testing/fixtures.ts's own seedSecondPerson does, rather than replayed
      // through the sync/derive pipeline: this task proves the read path from a real row to a
      // real render, not the pipeline that would normally produce that row from raw samples,
      // which is exercised end to end already in e2e-setup.test.ts.
      //
      // source: 'merged' is what personQuery.series's preferMerged prefers for a date when the
      // caller asks with no source filter (packages/core/src/query/personQuery.ts), which is what
      // the Dashboard's steps tile does by default - the shape a real device reconciliation
      // writes, not a raw per-device row.
      //
      // completeSetup() first: daily.person_id references people.id, and nothing has created 'p1'
      // yet at this point. signIn() below would call it anyway (it is idempotent), but the insert
      // has to run before that regardless, so it is named here rather than left implicit.
      await harness.completeSetup()
      harness.app.haelan.instance.db.insert(schema.daily).values({
        personId: 'p1', localDate: SEEDED_DATE, metric: 'steps', agg: 'sum', source: 'merged',
        value: KNOWN_STEPS, coverage: 1, sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]),
        derivationVersion: DERIVATION_VERSION,
      }).run()

      // Through the real login route: harness.signIn() itself calls app.inject against
      // /api/auth/login, not a seeded cache entry. This is the sign-in half of the seam.
      const sessionCookie = await harness.signIn()
      globalThis.fetch = fetchThroughServer(harness.app, sessionCookie)

      // The Dashboard route ('/'), with an explicit day range on the seeded date rather than the
      // default month view. Two reasons: datesFor('day', anchor) sets from = to = anchor
      // (controls/range.ts), the simplest range to seed exactly one row for, and a day range is
      // also the one range where every card on this page swaps its chart for a plain ChartNote
      // (Dashboard.tsx's tile() and its sleep schedule card both read oneDayRange) or, for the
      // heart rate and sleep-stage cards, falls to an empty state with nothing seeded - so this
      // render never has to reach echarts or set up its chart-token custom properties the way
      // dashboard-round-trip.test.tsx's stubbed render does. useRoute reads window.location
      // through useSyncExternalStore, independent of anything React controls yet, so this is set
      // before the first render rather than through a click.
      window.history.replaceState(null, '', `/?range=day&on=${SEEDED_DATE}`)

      const client = createBoundQueryClient()
      mount(
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
      await flush(client, () => container!.innerHTML)

      const cards = [...container!.querySelectorAll('.card')]
      // 'Steps' names the tile card exactly; the insight card two slots over is labelled 'Steps,
      // this period against the last' (dashboard.insights.steps in en.json) and would not match.
      const stepsCard = cards.find((card) => card.querySelector('.label')?.textContent === 'Steps')
      if (!stepsCard) {
        throw new Error(`no card labelled "Steps" among ${cards.length} rendered cards; got: ${container!.innerHTML}`)
      }
      const value = stepsCard.querySelector('.value')
      // The whole cell, not a substring: formatMetricValue rounds to steps' catalogue precision
      // (0 decimals, packages/core/src/derive/metrics.ts's TOTAL) and groups thousands for the
      // 'en' locale this test's I18nProvider is pinned to. A substring check
      // (toContain('12345')) would still pass against a wrong precision ('12345.0') or a dropped
      // thousands separator, which is exactly the kind of regression an end to end test exists to
      // catch rather than let through with the rest of the pipeline stubbed away.
      expect(value?.textContent).toBe('12,345')
    } finally {
      globalThis.fetch = originalFetch
      await harness.cleanup()
    }
  })
})
