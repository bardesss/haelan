import type { SessionLike } from './overrides.ts'
import { groupSessions } from './sessionOverlap.ts'
import type { SessionGroup } from './sessionOverlap.ts'
import type { Priority } from './priority.ts'
import type { DailyRow } from './rollup.ts'
import { MERGED_SOURCE } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'
import { absoluteHourOf } from './localDay.ts'
import { encodeMix } from './merge.ts'

/**
 * Workouts, from sessions to a day's count and minutes.
 *
 * The same run recorded by a watch and a phone is one workout, not two. groupSessions decides
 * that, exactly as it does for the merged view of sleep, so one function serves both a real
 * source's own sessions (where grouping only ever catches that source's own resync duplicate)
 * and the merged view (where it also catches a second source recording the same event).
 */

export interface ExerciseSessionLike {
  id: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
}

const MINUTE_MS = 60_000

/**
 * A day's exercise sessions to `daily` rows, for the given source.
 *
 * A day with no sessions returns no rows at all, unlike a stored zero: a session carries no
 * coverage question underneath it the way a sample does, so absence is the whole answer, and the
 * dashboard reads "no workouts" from the missing row exactly as it already does for a night with
 * no sleep.
 */
export function deriveExerciseDay(input: {
  personId: string
  localDate: string
  source: string
  sessions: readonly ExerciseSessionLike[]
  priority: Priority
  overlapRatio: number
}): DailyRow[] {
  if (input.sessions.length === 0) return []

  const groups = groupSessions({
    sessions: input.sessions.map((s): SessionLike => (
      { id: s.id, sourceId: s.sourceId, kind: 'exercise', startMs: s.startMs, endMs: s.endMs }
    )),
    priority: input.priority,
    overlapRatio: input.overlapRatio,
  })

  const byId = new Map(input.sessions.map((s) => [s.id, s]))
  // Each group's own primary, not the group's members summed: an alternate is the same event
  // recorded by another source, and summing it in would double the very minutes grouping exists
  // to keep from being doubled.
  const minutes = groups.reduce((total, group) => {
    const primary = byId.get(group.primary.id)!
    return total + minutesBetween(primary.startMs, primary.endMs)
  }, 0)

  // Only a merged row has a mix to report: a per source row is that source's own sessions and
  // never drew on another one. Schema comment on daily.source_mix, and sleepMerge.ts's mixOf is
  // the same convention applied to a different session kind, not a second format.
  const sourceMix = input.source === MERGED_SOURCE ? mixOf(groups, byId) : null

  const push = (metric: string, agg: DailyRow['agg'], value: number): DailyRow => ({
    personId: input.personId,
    localDate: input.localDate,
    metric,
    agg,
    source: input.source,
    value,
    // A session has no samples underneath it, so the fraction of the day's hours carrying one is
    // not a question this row can answer, for the same reason derive/sleep.ts leaves it null.
    coverage: null,
    sourceMix,
    derivationVersion: DERIVATION_VERSION,
  })

  return [
    push('workout_count', 'count', groups.length),
    push('workout_minutes', 'sum', minutes),
  ]
}

const minutesBetween = (fromMs: number, toMs: number): number => Math.round((toMs - fromMs) / MINUTE_MS)

/**
 * The `daily.source_mix` column means "how many of the day's hours this source won" everywhere
 * else it is written, and a merged workout's mix has to count the same thing or the field means
 * two different things depending on which code wrote it. Only each group's winning primary
 * contributes: an alternate lost the event to a higher priority source, the same reasoning that
 * keeps it out of `minutes` above, and the two figures would disagree about what was merged if
 * the mix counted sessions the minute total does not.
 */
function mixOf(
  groups: readonly SessionGroup[],
  byId: ReadonlyMap<string, ExerciseSessionLike>,
): string | null {
  const bucketsBySource = new Map<string, Set<number>>()
  for (const group of groups) {
    const primary = byId.get(group.primary.id)!
    // endMs - 1 keeps a session that ends exactly on the hour out of the bucket after it.
    const from = absoluteHourOf(primary.startMs, primary.startOffsetMinutes)
    const to = absoluteHourOf(primary.endMs - 1, primary.startOffsetMinutes)
    let buckets = bucketsBySource.get(primary.sourceId)
    if (!buckets) { buckets = new Set(); bucketsBySource.set(primary.sourceId, buckets) }
    for (let bucket = from; bucket <= to; bucket += 1) buckets.add(bucket)
  }
  // Null rather than '[]': an empty mix would claim a merge drew on no sources, when the truth is
  // there was nothing here to merge (no workouts that day).
  if (bucketsBySource.size === 0) return null
  return encodeMix([...bucketsBySource].map(([source, buckets]) => ({ source, hours: buckets.size })))
}
