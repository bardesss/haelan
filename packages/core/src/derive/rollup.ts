import type { SampleAgg } from '../db/schema/derived.ts'
import type { DailyAgg } from './metrics.ts'
import { metricSpec } from './metrics.ts'
import { coverageOf } from './coverage.ts'
import { DERIVATION_VERSION } from './version.ts'

export { DERIVATION_VERSION }

export interface SampleLike {
  sourceId: string
  metric: string
  utcMs: number
  tzOffsetMinutes: number
  agg: SampleAgg
  value: number | null
  n: number
}

/**
 * The `daily.source` of a row the provider reconciled rather than one we derived. Neither a
 * source id nor `merged`: we did not compute the merge and cannot inspect it against per source
 * data, and filing it as `merged` would make section 9's promise false without saying so.
 */
export const PROVIDER_SOURCE = 'provider'

export interface DailyRow {
  personId: string
  localDate: string
  metric: string
  agg: DailyAgg
  source: string
  value: number | null
  coverage: number | null
  derivationVersion: number
}

export interface RollUpDayInput {
  personId: string
  localDate: string
  /** One person, one local day. Rows from another day would be counted into this one. */
  rows: readonly SampleLike[]
}

type Scored = SampleLike & { value: number }

// Which sample rows feed which daily aggregate. A row's own agg records how it was computed:
// 'raw' is what the source reported, and only per minute downsampling produces min, mean and
// max. Taking a daily max from mean rows would answer a different question quietly.
const FEEDS: Record<DailyAgg, ReadonlySet<SampleAgg>> = {
  min: new Set<SampleAgg>(['raw', 'min']),
  max: new Set<SampleAgg>(['raw', 'max']),
  mean: new Set<SampleAgg>(['raw', 'mean']),
  p50: new Set<SampleAgg>(['raw', 'mean']),
  sum: new Set<SampleAgg>(['raw', 'sum']),
  count: new Set<SampleAgg>(['raw', 'count']),
  // 'last' feeds from every row: the latest reading of the day is the latest reading however it
  // was computed, and there is no 'last' sample agg to filter on.
  last: new Set<SampleAgg>(['raw', 'min', 'mean', 'max', 'sum', 'count']),
}

function compute(agg: DailyAgg, rows: readonly Scored[]): number | null {
  const feeding = rows.filter((r) => FEEDS[agg].has(r.agg))
  if (feeding.length === 0) return null
  switch (agg) {
    case 'min': return Math.min(...feeding.map((r) => r.value))
    case 'max': return Math.max(...feeding.map((r) => r.value))
    case 'sum': return feeding.reduce((total, r) => total + r.value, 0)
    case 'count': return feeding.reduce((total, r) => total + r.n, 0)
    case 'last': return [...feeding].sort((a, b) => a.utcMs - b.utcMs).at(-1)!.value
    case 'mean': {
      // Weighted by n, because a minute row that collapsed thirty readings is not worth the
      // same as one that collapsed two.
      const weight = feeding.reduce((total, r) => total + r.n, 0)
      if (weight === 0) return null
      return feeding.reduce((total, r) => total + r.value * r.n, 0) / weight
    }
    case 'p50': {
      const sorted = feeding.map((r) => r.value).sort((a, b) => a - b)
      const middle = sorted.length / 2
      return sorted.length % 2 === 1
        ? sorted[Math.floor(middle)]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2
    }
  }
}

/**
 * A day's sample rows to its `daily` rows, per source. Pure: no clock, no database, no
 * randomness, so a golden fixture is the whole test.
 *
 * Per source and never merged. Spec invariant 4: merging never happens on write, and choosing
 * between sources is M2b's, computed from these rows rather than instead of them.
 */
export function rollUpDay(input: RollUpDayInput): DailyRow[] {
  // Nested rather than a joined string key: a delimiter that can appear in a metric name or a
  // source id is a defect waiting for the first source whose id contains one.
  const byMetric = new Map<string, Map<string, Scored[]>>()
  for (const row of input.rows) {
    // A null value is a reading the device did not take. Counting it as zero is the single
    // easiest way to turn a gap into a fabricated measurement.
    if (row.value === null) continue
    let bySource = byMetric.get(row.metric)
    if (!bySource) {
      bySource = new Map<string, Scored[]>()
      byMetric.set(row.metric, bySource)
    }
    const bucket = bySource.get(row.sourceId)
    if (bucket) bucket.push(row as Scored)
    else bySource.set(row.sourceId, [row as Scored])
  }

  const out: DailyRow[] = []
  for (const [metric, bySource] of byMetric) {
    const spec = metricSpec(metric)
    // A metric the catalogue does not declare has no meaningful aggregates, and inventing one
    // here would put a number on a chart that nothing chose.
    if (!spec) continue
    for (const [source, rows] of bySource) {
      const coverage = coverageOf(rows)
      for (const agg of spec.aggs) {
        const value = compute(agg, rows)
        if (value === null) continue
        out.push({
          personId: input.personId,
          localDate: input.localDate,
          metric,
          agg,
          source,
          value,
          coverage,
          derivationVersion: DERIVATION_VERSION,
        })
      }
    }
  }
  return out
}
