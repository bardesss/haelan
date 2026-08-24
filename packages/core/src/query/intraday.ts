import { and, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { samples } from '../db/schema/index.ts'
import { localDateOf, widenedUtcWindow } from '../derive/localDay.ts'
import { thinBand } from './downsample.ts'
import type { Thinned } from './downsample.ts'

const MINUTE_MS = 60_000
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
 * Only heart rate is downsampled to the minute in the catalogue (`downsampleToMinute`); every
 * other intraday metric, spo2 and hrv included, is stored one row per reading at `agg: 'raw'`.
 * A raw reading is its own min, mean and max for the instant it was taken, and where more than
 * one raw reading shares a minute they are combined exactly the way `downsampleToMinute` combines
 * them for heart rate: the minute's minimum, arithmetic mean and maximum. Without this every
 * metric but heart rate answered three nulls per point, which reads as worse than empty because
 * the caller sees points and finds no value in any of them.
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
  const { start: windowStart, end: windowEnd } = widenedUtcWindow(input.localDate)

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
  //
  // rawValues accumulates a raw metric's readings for the minute so they can be combined once
  // every row for that minute has been seen, rather than folded in one at a time: a running
  // min/mean/max would need its own running sum and count anyway, which is exactly what an array
  // and a single pass at the end already gives for free.
  const bySource = new Map<string, Map<number, IntradayPoint & { rawValues: number[] }>>()
  for (const row of rows) {
    if (row.value === null) continue
    // A raw reading keeps its own instant, not the minute; grouping it under the minute it
    // belongs to is what lets several readings in one minute combine, the same partition
    // downsampleToMinute uses at ingest for the one metric that already gets this treatment.
    const bucketMs = row.agg === 'raw' ? Math.floor(row.utcMs / MINUTE_MS) * MINUTE_MS : row.utcMs
    const byMinute = bySource.get(row.sourceId) ?? new Map<number, IntradayPoint & { rawValues: number[] }>()
    bySource.set(row.sourceId, byMinute)
    const point = byMinute.get(bucketMs)
      ?? { sourceId: row.sourceId, utcMs: bucketMs, min: null, mean: null, max: null, rawValues: [] }
    if (row.agg === 'min') point.min = row.value
    else if (row.agg === 'mean') point.mean = row.value
    else if (row.agg === 'max') point.max = row.value
    else if (row.agg === 'raw') point.rawValues.push(row.value)
    byMinute.set(bucketMs, point)
  }

  const sourceIds = [...bySource.keys()]
  if (sourceIds.length === 0) return { points: [], reduction: null }

  const requested = input.points ?? DEFAULT_POINTS
  // Divided across the sources present, so a caller asking for 500 points still gets at most 500
  // rather than 500 per source, in the ordinary case. The floor of 2 is a deliberate exception to
  // that budget, not a bug in it: thin always keeps at least the first and last point of whatever
  // series it is given, so with S sources present and a requested total below 2S, honouring the
  // budget exactly would mean asking some source's floor to go below 2, and thin cannot do that
  // without dropping a source to nothing. A device with zero points is silently missing from the
  // chart; a chart that came back with a few more points than asked for is still every device's
  // real shape. reduction below reports what was actually returned, so a caller can see the
  // budget was exceeded rather than being told it was met.
  const perSource = Math.max(2, Math.floor(requested / sourceIds.length))

  let totalFrom = 0
  let totalTo = 0
  let anyThinned = false
  const perSourcePoints = sourceIds.map((sourceId) => {
    const series: IntradayPoint[] = [...bySource.get(sourceId)!.values()]
      .map(({ rawValues, ...point }) => (
        rawValues.length === 0
          ? point
          : {
              ...point,
              min: Math.min(...rawValues),
              mean: rawValues.reduce((total, v) => total + v, 0) / rawValues.length,
              max: Math.max(...rawValues),
            }
      ))
      .sort((a, b) => a.utcMs - b.utcMs)
    // Banded, not a single scalar: bucketing on one derived y, even the point's own mean, is what
    // let a spike in max or a trough in min vanish while the mean stayed unremarkable. thinBand
    // buckets the low edge on min and the high edge on max independently, so both survive
    // regardless of what either point's mean happened to be; lttb is not an option here at all,
    // since it would discard exactly the extremes a band exists to show.
    const { points: thinnedSeries, reduction } = thinBand(series, perSource, {
      x: (p) => p.utcMs,
      low: (p) => p.min ?? p.mean ?? p.max ?? 0,
      high: (p) => p.max ?? p.mean ?? p.min ?? 0,
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
