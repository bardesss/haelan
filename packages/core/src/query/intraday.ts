import { and, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { samples } from '../db/schema/index.ts'
import { localDateOf } from '../derive/localDay.ts'
import { thin } from './downsample.ts'
import type { Thinned } from './downsample.ts'

const HOUR_MS = 3_600_000
const DEFAULT_POINTS = 500

export interface IntradayPoint {
  sourceId: string
  utcMs: number
  min: number | null
  mean: number | null
  max: number | null
}

/**
 * One day of per-minute samples for a metric, pivoted onto one row per minute per source and
 * thinned for a chart.
 *
 * Widens the UTC query the way `deriveDayInto` does, because a provider offset can put a local
 * day's instants up to 14 hours either side of its UTC midnight, then filters by each row's own
 * local date computed from its own offset. The person's current timezone never enters this: a
 * reading keeps the offset it was recorded under even if the person has since moved.
 *
 * Pivots on source and minute together rather than minute alone. Two devices can report the same
 * metric for the same minute, and picking one row to win each of min, mean and max independently,
 * by whichever the query happened to return last, is not a reading of anything. Choosing between
 * sources is the derive layer's job, applied once through its priority list when it writes the
 * merged daily rows; this reader has no second policy of its own, so it keeps every source's point
 * separate and lets a caller ask for one with `sourceId` if that is what it wants.
 *
 * Thinning is per source too, not shared. Handing one interleaved array covering every source to
 * a single `thin` call moves the same blending defect into the downsampler: `minmax` buckets by
 * index and picks extremes by value with no notion of source, so a bucket spanning two devices can
 * surface one device's minimum next to another device's maximum, a band whose edges belong to
 * different readings. Each source is thinned on its own share of the requested budget, and the
 * results are concatenated afterwards, so no bucket ever spans more than one source.
 */
export function readIntraday(db: DbOrTx, input: {
  personId: string
  metric: string
  localDate: string
  sourceId?: string
  points?: number
}): { points: IntradayPoint[], reduction: Thinned<IntradayPoint>['reduction'] } {
  const utcMidnight = Date.parse(`${input.localDate}T00:00:00Z`)
  const windowStart = utcMidnight - 14 * HOUR_MS
  const windowEnd = utcMidnight + 38 * HOUR_MS

  const rows = db.select().from(samples).where(and(
    eq(samples.personId, input.personId),
    eq(samples.metric, input.metric),
    gte(samples.utcMs, windowStart),
    lte(samples.utcMs, windowEnd),
    input.sourceId === undefined ? undefined : eq(samples.sourceId, input.sourceId),
  )).all()
    .filter((row) => localDateOf(row.utcMs, row.tzOffsetMinutes) === input.localDate)

  // Keyed by source first, then minute, rather than one map keyed by a string built from both: a
  // source id is arbitrary text and this avoids ever having to reason about whether two different
  // (source, minute) pairs could print to the same key.
  const bySource = new Map<string, Map<number, IntradayPoint>>()
  for (const row of rows) {
    const byMinute = bySource.get(row.sourceId) ?? new Map<number, IntradayPoint>()
    bySource.set(row.sourceId, byMinute)
    const point = byMinute.get(row.utcMs)
      ?? { sourceId: row.sourceId, utcMs: row.utcMs, min: null, mean: null, max: null }
    if (row.agg === 'min') point.min = row.value
    else if (row.agg === 'mean') point.mean = row.value
    else if (row.agg === 'max') point.max = row.value
    byMinute.set(row.utcMs, point)
  }

  const sourceIds = [...bySource.keys()]
  if (sourceIds.length === 0) return { points: [], reduction: null }

  const requested = input.points ?? DEFAULT_POINTS
  // Divided across the sources present, so a caller asking for 500 points still gets at most 500
  // rather than 500 per source. Never below 2: thin always keeps at least the first and last point
  // of whatever series it is given, and a smaller target would ask it to break that guarantee.
  const perSource = Math.max(2, Math.floor(requested / sourceIds.length))

  let totalFrom = 0
  let totalTo = 0
  let anyThinned = false
  const perSourcePoints = sourceIds.map((sourceId) => {
    const series = [...bySource.get(sourceId)!.values()].sort((a, b) => a.utcMs - b.utcMs)
    // minmax, not lttb: an intraday trace is drawn as a min/max band, and lttb would discard
    // exactly the extremes a band exists to show.
    const { points: thinnedSeries, reduction } = thin(series, perSource, {
      method: 'minmax',
      x: (p) => p.utcMs,
      y: (p) => p.mean ?? p.max ?? p.min ?? 0,
    })
    totalFrom += series.length
    totalTo += thinnedSeries.length
    if (reduction !== null) anyThinned = true
    return thinnedSeries
  })

  const points = perSourcePoints.flat()
    .sort((a, b) => a.utcMs - b.utcMs || a.sourceId.localeCompare(b.sourceId))

  return {
    points,
    // Aggregate across sources rather than per source: a client asking "was this thinned" wants
    // one answer for the day, and null still means none of the sources needed it.
    reduction: anyThinned ? { method: 'minmax', from: totalFrom, to: totalTo } : null,
  }
}
