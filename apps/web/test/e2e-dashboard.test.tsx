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

import { App } from '../src/Shell.js'
import { createBoundQueryClient } from '../src/api/queryClient.js'
import { I18nProvider } from '../src/i18n/index.js'
import { ErrorBoundary } from '../src/components/ErrorBoundary.js'
import { flush } from './flush.js'
import { fetchThroughServer } from './fetchThroughServer.js'

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

/**
 * The person's today by the harness's own clock, which is what the glance route reads (it has no
 * range parameter: the server decides the day in the person's zone from app.haelan.now()). The
 * harness pins that clock and signs in a person in Europe/Amsterdam, so seeding this date is
 * seeding "today" for the page, with nothing depending on when the suite runs.
 */
function todayOf(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(nowMs))
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
      // One person (harness.signIn below completes the wizard for 'p1'/'robin'), one derived
      // daily row carrying a known value. Written straight into the daily table, the same way
      // packages/core/src/testing/fixtures.ts's own seedSecondPerson does, rather than replayed
      // through the sync/derive pipeline: this task proves the read path from a real row to a
      // real render, not the pipeline that would normally produce that row from raw samples,
      // which is exercised end to end already in e2e-setup.test.ts.
      //
      // source: 'merged' is what personQuery.series's preferMerged prefers for a date when the
      // caller asks with no source filter (packages/core/src/query/personQuery.ts), which is what
      // the glance's steps figure asks for - the shape a real device reconciliation
      // writes, not a raw per-device row.
      //
      // completeSetup() first: daily.person_id references people.id, and nothing has created 'p1'
      // yet at this point. signIn() below would call it anyway (it is idempotent), but the insert
      // has to run before that regardless, so it is named here rather than left implicit.
      await harness.completeSetup()
      harness.app.haelan.instance.db.insert(schema.daily).values({
        personId: 'p1', localDate: todayOf(harness.clock.nowMs), metric: 'steps', agg: 'sum', source: 'merged',
        value: KNOWN_STEPS, coverage: 1, sourceMix: JSON.stringify([{ source: 'watch', hours: 24 }]),
        derivationVersion: DERIVATION_VERSION,
      }).run()

      // Through the real login route: harness.signIn() itself calls app.inject against
      // /api/auth/login, not a seeded cache entry. This is the sign-in half of the seam.
      const sessionCookie = await harness.signIn()
      globalThis.fetch = fetchThroughServer(harness.app, sessionCookie)

      // The Dashboard route ('/'), with no range parameter: since M9b it is the glance, which has
      // no range to pick. One seeded row on today draws no chart either (the strip needs two days
      // with values, and there is no night or heart rate trace), so this render never has to reach
      // echarts or set up its chart-token custom properties. useRoute reads window.location
      // through useSyncExternalStore, independent of anything React controls yet, so this is set
      // before the first render rather than through a click.
      window.history.replaceState(null, '', '/')

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
      // The Today card, whose headline figure is labelled 'Steps'.
      const stepsCard = cards.find((card) => card.querySelector('.label')?.textContent === 'Steps')
      if (!stepsCard) {
        throw new Error(`no card labelled "Steps" among ${cards.length} rendered cards; got: ${container!.innerHTML}`)
      }
      expect(stepsCard.querySelector('.dash-card-title strong')?.textContent).toBe('Today')
      // The figure right under the 'Steps' label, the first of the card's two headline figures.
      const value = stepsCard.querySelector('.label + .dash-headline-sm')
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
