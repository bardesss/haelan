import { deriveSleepDay } from './sleep.ts'
import type { SleepSegmentLike, SleepSessionLike } from './sleep.ts'
import { groupSessions } from './sessionOverlap.ts'
import { encodeMix } from './merge.ts'
import { MERGED_SOURCE } from './rollup.ts'
import type { DailyRow } from './rollup.ts'
import type { Priority } from './priority.ts'

const MINUTE_MS = 60_000

/**
 * The merged view of a night, when more than one source recorded it.
 *
 * It decides only which recordings survive, then hands them to deriveSleepDay under the merged
 * source. The arithmetic stays in one place, exactly as mergeDay delegates to rollUpDay: a
 * merged efficiency and a per source efficiency cannot come to disagree about what efficiency is.
 *
 * groupSessions is what says two recordings are the same event and which source wins it. The
 * alternate is not deleted, it simply does not count toward the merged figures, and the per
 * source rows beside this one are where it stays visible.
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
  const primaries = groups.map((group) => byId.get(group.primary.id)!)

  const rows = deriveSleepDay({
    personId: input.personId,
    localDate: input.localDate,
    source: MERGED_SOURCE,
    sessions: primaries,
    segments: input.segments,
    gapMinutes: input.gapMinutes,
  })

  // Hours, because that is what the column means on every other merged row. A night is measured
  // in hours anyway, so nothing is lost rounding to one decimal, and the per source rows carry
  // the exact minutes for anyone who needs them.
  const hoursBySource = new Map<string, number>()
  for (const primary of primaries) {
    const hours = (primary.endMs - primary.startMs) / (60 * MINUTE_MS)
    hoursBySource.set(primary.sourceId, (hoursBySource.get(primary.sourceId) ?? 0) + hours)
  }
  const mix = encodeMix([...hoursBySource].map(([source, hours]) => ({
    source, hours: Math.round(hours * 10) / 10,
  })))

  return rows.map((row) => ({ ...row, sourceMix: mix }))
}
