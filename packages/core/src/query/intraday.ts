import { and, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { samples } from '../db/schema/index.ts'
import { localDateOf } from '../derive/localDay.ts'
import { thin } from './downsample.ts'
import type { Thinned } from './downsample.ts'

const HOUR_MS = 3_600_000
const DEFAULT_POINTS = 500

export interface IntradayPoint {
  utcMs: number
  min: number | null
  mean: number | null
  max: number | null
}

/**
 * One day of per-minute samples for a metric, pivoted onto one row per minute and thinned for a
 * chart.
 *
 * Widens the UTC query the way `deriveDayInto` does, because a provider offset can put a local
 * day's instants up to 14 hours either side of its UTC midnight, then filters by each row's own
 * local date computed from its own offset. The person's current timezone never enters this: a
 * reading keeps the offset it was recorded under even if the person has since moved.
 */
export function readIntraday(db: DbOrTx, input: {
  personId: string
  metric: string
  localDate: string
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
  )).all()
    .filter((row) => localDateOf(row.utcMs, row.tzOffsetMinutes) === input.localDate)

  const byMinute = new Map<number, IntradayPoint>()
  for (const row of rows) {
    const point = byMinute.get(row.utcMs) ?? { utcMs: row.utcMs, min: null, mean: null, max: null }
    if (row.agg === 'min') point.min = row.value
    else if (row.agg === 'mean') point.mean = row.value
    else if (row.agg === 'max') point.max = row.value
    byMinute.set(row.utcMs, point)
  }

  const points = [...byMinute.values()].sort((a, b) => a.utcMs - b.utcMs)

  // minmax, not lttb: an intraday trace is drawn as a min/max band, and lttb would discard
  // exactly the extremes a band exists to show.
  const { points: thinned, reduction } = thin(points, input.points ?? DEFAULT_POINTS, {
    method: 'minmax',
    x: (p) => p.utcMs,
    y: (p) => p.mean ?? p.max ?? p.min ?? 0,
  })

  return { points: thinned, reduction }
}
