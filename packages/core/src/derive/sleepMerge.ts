import { assembleNights, deriveSleepDay } from './sleep.ts'
import type { SleepSegmentLike, SleepSessionLike } from './sleep.ts'
import { groupSessions } from './sessionOverlap.ts'
import { encodeMix } from './merge.ts'
import { MERGED_SOURCE } from './rollup.ts'
import type { DailyRow } from './rollup.ts'
import type { Priority } from './priority.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

// The night and the nap metrics are computed from disjoint sessions, so a source that only ever
// contributed a nap must not be named on the night's rows, and the reverse.
const NAP_METRICS = new Set(['sleep_nap_count', 'sleep_nap_minutes'])

/**
 * The merged view of a night, when more than one source recorded it.
 *
 * It decides only which recordings survive, then hands them to deriveSleepDay under the merged
 * source. The arithmetic stays in one place, exactly as mergeDay delegates to rollUpDay: a
 * merged efficiency and a per source efficiency cannot come to disagree about what efficiency is.
 *
 * groupSessions is what says two recordings are the same event and which source wins it. Every
 * session the winning source contributed to the event survives, since a night arrives in pieces.
 * A losing source's recording is not deleted, it simply does not count toward the merged
 * figures, and the per source rows beside this one are where it stays visible.
 */
export function mergeSleepDay(input: {
  personId: string
  localDate: string
  sessions: readonly SleepSessionLike[]
  segments: readonly SleepSegmentLike[]
  gapMinutes: number
  overlapRatio: number
  priority: Priority
}): DailyRow[] {
  if (input.sessions.length === 0) return []

  const groups = groupSessions({
    sessions: input.sessions.map((s) => ({
      id: s.id, sourceId: s.sourceId, kind: 'sleep', startMs: s.startMs, endMs: s.endMs,
    })),
    priority: input.priority,
    overlapRatio: input.overlapRatio,
  })

  const byId = new Map(input.sessions.map((s) => [s.id, s]))
  // The primary is one session, a night is not. This milestone exists because one source records
  // a night as several pieces, so keeping only the primary would delete every piece after the
  // first. The group still resolves to one winning source; that source keeps everything it saw.
  const winning = groups
    .flatMap((g) => [g.primary, ...g.alternates].filter((s) => s.sourceId === g.primary.sourceId))
    .map((s) => byId.get(s.id)!)

  const rows = deriveSleepDay({
    personId: input.personId,
    localDate: input.localDate,
    source: MERGED_SOURCE,
    sessions: winning,
    segments: input.segments,
    gapMinutes: input.gapMinutes,
  })

  // Run over the winning sessions a second time, rather than have deriveSleepDay report its own
  // grouping back: assembleNights is pure and cheap, and this keeps the return shape every
  // other caller of deriveSleepDay relies on untouched.
  const { night, naps } = assembleNights({ sessions: winning, gapMinutes: input.gapMinutes })
  const nightMix = mixOf(night)
  const napMix = mixOf(naps)

  return rows.map((row) => ({ ...row, sourceMix: NAP_METRICS.has(row.metric) ? napMix : nightMix }))
}

/** The absolute hour an instant falls in, shifted by the session's own offset first, so a night
 * crossing midnight cannot collide with itself the way a day-relative hour label would. */
function bucketOf(utcMs: number, offsetMinutes: number): number {
  return Math.floor((utcMs + offsetMinutes * MINUTE_MS) / HOUR_MS)
}

/**
 * The `daily.source_mix` column means "how many of the day's hours this source won" everywhere
 * else it is written, counted by mergeDay as distinct local hour buckets. A merged night's mix
 * has to count the same thing, not the session's elapsed span, or the field means two different
 * things depending on which code wrote it.
 */
function mixOf(sessions: readonly SleepSessionLike[]): string | null {
  const bucketsBySource = new Map<string, Set<number>>()
  for (const session of sessions) {
    // endMs - 1 keeps a session that ends exactly on the hour out of the bucket after it.
    const from = bucketOf(session.startMs, session.startOffsetMinutes)
    const to = bucketOf(session.endMs - 1, session.startOffsetMinutes)
    let buckets = bucketsBySource.get(session.sourceId)
    if (!buckets) { buckets = new Set(); bucketsBySource.set(session.sourceId, buckets) }
    for (let bucket = from; bucket <= to; bucket += 1) buckets.add(bucket)
  }
  // Null rather than '[]': an empty mix would claim a merge drew on no sources, when the truth
  // is there was nothing here to merge (no naps, or no night).
  if (bucketsBySource.size === 0) return null
  return encodeMix([...bucketsBySource].map(([source, buckets]) => ({ source, hours: buckets.size })))
}
