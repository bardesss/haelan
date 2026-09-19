import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RECOVERY_METRIC_SOURCES } from '@haelan/core/recovery-index'
import { asOfLabel, RecoveryIndexTile } from '../src/pages/dashboard/RecoveryIndexTile.js'
import { recoveryFetchRange } from '../src/data/useRecoveryIndex.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { ALL_SOURCES } from '../src/controls/source.js'
import type { Session } from '../src/auth/session.js'

describe('asOfLabel', () => {
  it('says nothing when the scored day is today', () => {
    expect(asOfLabel('2026-09-19', '2026-09-19')).toBeNull()
  })

  it('names the scored day when it is not today, because sync lag is the normal state', () => {
    expect(asOfLabel('2026-09-14', '2026-09-19')).toBe('2026-09-14')
  })
})

// Derived from RECOVERY_METRIC_SOURCES (@haelan/core/recovery-index), the one shared mapping of
// metric to agg, rather than a second hand-typed copy of it: useRecoveryIndex.ts's own
// LAST_METRICS/SUM_METRICS are unexported, so the query keys the loaded-state test seeds below
// still have to be rebuilt here rather than imported directly - but rebuilt from the same source
// of truth production code reads, not from a guess at what it currently says. If useRecoveryIndex
// ever stops deriving its own lists from RECOVERY_METRIC_SOURCES the same way, the seeded cache
// misses and the render below is stuck pending instead of loaded - a loud failure, not a silent
// false pass, the same trade settings-about.test.tsx accepts for the query keys it seeds by hand.
const LAST_METRICS = RECOVERY_METRIC_SOURCES.filter((s) => s.agg === 'last').map((s) => s.metric)
const SUM_METRICS = RECOVERY_METRIC_SOURCES.filter((s) => s.agg === 'sum').map((s) => s.metric)

const PERSON: Session = {
  personId: 'p1', displayName: 'Test', username: 'test', isAdmin: true, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

function shift(date: string, by: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 67 days of flat history with a little noise, centred on `centre` - the same shape
 * packages/core/test/recovery-index.test.ts's own `history()` fixture builds, which that suite
 * already checked scores `enough: true`: neither thin (67 days clears the 14-day floor) nor
 * zero-spread (the %3 wobble gives every window a real, small spread to measure a z-score against).
 */
function history(end: string, centre: number) {
  const points = []
  for (let back = 66; back >= 0; back -= 1) {
    points.push({
      localDate: shift(end, -back), value: centre + (back % 3) - 1,
      coverage: null, source: 'merged', sourceMix: null, updatedAtMs: null,
    })
  }
  return { points, reduction: null }
}

describe('the recovery index tile', () => {
  // The defect a fix-round review caught: the settled branch built its own <Card> without the
  // `label` prop every other branch passes, so "Recovery index" / "Herstelindex" rendered while
  // the card was loading, erroring, or empty, and disappeared the moment it had something to show
  // - the one state a reader actually spends time looking at. Seeded with react-query cache data
  // rather than a fetch stub, following settings-about.test.tsx's own pattern: a static render
  // sees whatever is already in the cache on its first pass, with no effect and no DOM needed to
  // let a request resolve.
  it('names itself once loaded, not only while pending, errored or empty', () => {
    const end = '2026-09-14'
    const range = { from: end, to: end }
    const fetchRange = { ...recoveryFetchRange(range), source: ALL_SOURCES }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session(), PERSON)
    client.setQueryData(
      queryKeys.resource(PERSON.personId, 'series', { metrics: LAST_METRICS, ...fetchRange, agg: 'last' }),
      Object.fromEntries(LAST_METRICS.map((metric) => [
        metric,
        history(end, metric === 'resting_heart_rate' ? 55 : metric === 'respiratory_rate' ? 14 : metric === 'sleep_bedtime_minutes' ? 1380 : 40),
      ])),
    )
    client.setQueryData(
      queryKeys.resource(PERSON.personId, 'series', { metrics: SUM_METRICS, ...fetchRange, agg: 'sum' }),
      { sleep_asleep_minutes: history(end, 430) },
    )

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en">
          <RecoveryIndexTile from={end} to={end} source={ALL_SOURCES} today={end} />
        </I18nProvider>
      </QueryClientProvider>,
    )

    // Proof the card actually reached the loaded branch, not merely that the assertion below
    // would also pass on the empty or pending copy: those never mention a score's own basis line.
    expect(html).toContain('against your own last')
    expect(html).toContain('Recovery index')
  })
})
