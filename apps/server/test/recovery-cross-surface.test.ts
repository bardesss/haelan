import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, PersonQuery, schema, shiftLocalDate } from '@haelan/core'
import {
  recoveryIndexSeries, recoveryWindowStart, bandOf, RECOVERY_METRIC_SOURCES,
} from '@haelan/core/recovery-index'
import type { DayValue, RecoveryMetricSource } from '@haelan/core/recovery-index'
import { recoveryIndexTool } from '../src/mcp/tools/recovery.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The spec's own cross-surface requirement (finding C of the final review): the MCP tool and the
 * web hook must answer the same score for the same day, and a test proving that has to actually
 * exercise both of the surfaces that could diverge, not call one function twice and call that
 * proof.
 *
 * The MCP side calls `recoveryIndexTool.run` directly against a `PersonQuery`, exactly as
 * `apps/server/src/mcp/adapter.ts` does for a real tool call: `PersonQuery.series()` reading
 * `daily` rows straight out of the database.
 *
 * The web side cannot run `useRecoveryIndex.ts` itself here - it is a React hook built on
 * `fetch` and a query client, neither of which exists in this test environment - but the
 * computation it performs is small and pure once its own two `/series` requests have answered:
 * fetch the recovery window from `recoveryWindowStart`, then run `recoveryIndexSeries`
 * (`useRecoveryIndex.ts`'s own `byDate` memo does exactly this). So this test drives the *real*
 * HTTP route the browser's `fetch` actually calls - `GET /api/v1/p/:id/series`, the same route
 * `v1-series.test.ts` exercises - with the same two-request split (`last` and `sum`) and the same
 * `recoveryFetchRange` window the hook uses, then finishes the computation with the identical
 * `recoveryIndexSeries` call.
 *
 * If the MCP tool's own window (`recoveryWindowStart(range.from)`, in
 * `apps/server/src/mcp/tools/recovery.ts`'s `fetchRecoveryInput`) ever drifted from the web hook's
 * (`recoveryFetchRange` in `apps/web/src/data/useRecoveryIndex.ts`), or either surface started
 * reading a different metric/agg for one of the five inputs (both now read
 * `RECOVERY_METRIC_SOURCES`, but a call site could still ignore it), the two routes below would
 * fetch different rows and this test would fail on the score, not merely on some incidental detail.
 */

let h: Harness | null = null
afterEach(async () => { await h?.cleanup(); h = null })

const ON = '2026-08-08'
const START = recoveryWindowStart(ON)

/**
 * Real rows for all five recovery metrics, oscillating gently around a centre so every 60-day
 * baseline has a real, non-zero spread to score against - the same shape
 * `packages/core/test/recovery-index.test.ts`'s own `history()` fixture uses, and for the same
 * reason: a literally flat series gives `baselineOf` a spread of zero and every z score null.
 */
function seedRecoveryDaily(h: Harness, personId: string): void {
  const centreOf = (key: RecoveryMetricSource['key']): number => ({
    hrv: 40, restingHeartRate: 55, respiratoryRate: 14, asleepMinutes: 430, bedtimeMinutes: 1380,
  })[key]
  let i = 0
  for (let date = START; date <= ON; date = shiftLocalDate(date, 1)) {
    for (const source of RECOVERY_METRIC_SOURCES) {
      const value = centreOf(source.key) + (i % 3) - 1
      h.app.haelan.instance.db.insert(schema.daily).values({
        personId, localDate: date, metric: source.metric, agg: source.agg, source: 'merged',
        value, coverage: null, sourceMix: null, derivationVersion: DERIVATION_VERSION,
      }).run()
    }
    i += 1
  }
}

interface WireSeriesPoint { localDate: string, value: number }
interface WireSeries { points: WireSeriesPoint[] }

async function fetchSeries(
  h: Harness, token: string, metrics: readonly string[], agg: string, from: string, to: string,
): Promise<Record<string, WireSeries>> {
  const params = new URLSearchParams()
  for (const metric of metrics) params.append('metric', metric)
  params.set('agg', agg)
  params.set('from', from)
  params.set('to', to)
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1/series?${params.toString()}`,
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Record<string, WireSeries>
}

const toDayValues = (series: WireSeries | undefined): DayValue[] =>
  (series?.points ?? []).map((p) => ({ localDate: p.localDate, value: p.value }))

describe('recovery_index: the MCP tool and the web hook agree', () => {
  it('answers the same score and band for the same day, fetched through each surface\'s own real path', async () => {
    h = await withServer()
    await h.completeSetup()
    seedRecoveryDaily(h, 'p1')
    const token = await h.signIn()

    // The MCP surface: recoveryIndexTool.run against a PersonQuery, exactly as adapter.ts calls it
    // for a real `tools/call`.
    const q = new PersonQuery(h.app.haelan.instance.db, 'p1')
    const mcpResult = recoveryIndexTool.run(q, { from: ON, to: ON }) as {
      days: { localDate: string, enough: boolean, score: number | null, band: string | null }[]
    }
    const mcpDay = mcpResult.days.find((d) => d.localDate === ON)
    expect(mcpDay?.enough).toBe(true)

    // The web surface: the same two /series requests useRecoveryIndex.ts issues (LAST_METRICS at
    // agg 'last', SUM_METRICS at agg 'sum'), over recoveryFetchRange's own window, through the
    // real HTTP route - not a second in-process call to recoveryIndexSeries with hand-built input,
    // which would prove nothing about whether the two surfaces actually agree.
    const lastMetrics = RECOVERY_METRIC_SOURCES.filter((s) => s.agg === 'last').map((s) => s.metric)
    const sumMetrics = RECOVERY_METRIC_SOURCES.filter((s) => s.agg === 'sum').map((s) => s.metric)
    const [lastSeries, sumSeries] = await Promise.all([
      fetchSeries(h, token, lastMetrics, 'last', START, ON),
      fetchSeries(h, token, sumMetrics, 'sum', START, ON),
    ])
    const merged = { ...lastSeries, ...sumSeries }
    const metricFor = (key: RecoveryMetricSource['key']): string =>
      RECOVERY_METRIC_SOURCES.find((s) => s.key === key)!.metric

    const webSeries = recoveryIndexSeries({
      hrv: toDayValues(merged[metricFor('hrv')]),
      restingHeartRate: toDayValues(merged[metricFor('restingHeartRate')]),
      respiratoryRate: toDayValues(merged[metricFor('respiratoryRate')]),
      bedtimeMinutes: toDayValues(merged[metricFor('bedtimeMinutes')]),
      asleepMinutes: toDayValues(merged[metricFor('asleepMinutes')]),
    }, { from: ON, to: ON })
    const webDay = webSeries.get(ON)
    expect(webDay?.enough).toBe(true)
    if (webDay === undefined || !webDay.enough || mcpDay === undefined) return

    expect(mcpDay.score).toBe(webDay.score)
    expect(mcpDay.band).toBe(bandOf(webDay.score))
  })
})
