import type { DbOrTx } from '../db/open.ts'
import { groupSessions, DEFAULT_OVERLAP_RATIO } from '../derive/sessionOverlap.ts'
import type { Priority } from '../derive/priority.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import { loadPriority } from '../store/sourcePriority.ts'
import { SettingsStore } from '../store/settings.ts'
import { workoutSummary } from '../api/workoutSummary.ts'
import { readSessions } from './sessions.ts'
import type { WorkoutSession } from './sessions.ts'

/**
 * One workout per event, however many sources recorded it.
 *
 * Since the companion app joined the Google Health API as a second source, every workout a watch
 * records reaches the archive twice: once through Google, once through Health Connect on the
 * phone. The rows stay two, because section 9 retains an alternate rather than deleting it and
 * every merge is computed on read, never stored. What changes is the answer a reader gets: the
 * list, the detail, the glance and the tools all read through here, so the Activity page, an agent
 * and the API agree that a run was one run, and they agree with `workout_count`, which
 * deriveExerciseDay has always computed from the same groupSessions call with the same ratio.
 *
 * Asymmetric with sleep on purpose. A night already has its own merge (sleepMerge.ts), built on
 * stage timelines rather than fields, and readSleepNights answers per source for the night page's
 * own source picker; neither is touched here.
 *
 * **Which member is primary.** Priority first, the person's own list for the metric `exercise`,
 * exactly as derivation ranks it. With one refinement derivation already makes implicitly: a kept
 * member always outranks an excluded one. deriveDay drops excluded sessions before it groups, so
 * when the primary is excluded and the phone's copy is not, the phone's copy is the workout it
 * counts. Ranking kept members first makes the list name that same copy, and it makes "excluded"
 * on a merged workout mean what the count means by it: every copy of this event was thrown out.
 * The one place the two can still differ is single linkage across three copies where excluding
 * the middle one splits a chain derivation then sees as two events; three sources for one workout
 * is not a shape any household here has.
 *
 * **Enrichment.** The merged workout is the primary's row, with attrs filled field by field from
 * the next member that has a value where the primary stored null (enrichAttrs). The primary's
 * start, end, dates and source stand: which device's clock bounds the event is the priority
 * list's decision, not something to average. Joined detail follows the same first-non-null order
 * where it is read (readWorkoutRoute walks `[id, ...alternateIds]`; cardio load and splits read
 * the merged attrs).
 */

/** What a merged read needs besides the rows: the ranking and the overlap threshold. */
export interface MergeRule {
  priority: Priority
  overlapRatio: number
}

/**
 * Groups exercise sessions into events and answers one merged workout per event, oldest first
 * by (startMs, id), the order readSessions answers in. A session of any other kind passes through
 * untouched; groupSessions never groups across kinds, and this never sees a sleep row from its
 * own callers, but a pure function should not have to trust that.
 */
export function mergeWorkouts(list: readonly WorkoutSession[], rule: MergeRule): WorkoutSession[] {
  const byId = new Map(list.map((s) => [s.id, s]))
  const groups = groupSessions({
    sessions: list.map((s) => ({ id: s.id, sourceId: s.sourceId, kind: s.kind, startMs: s.startMs, endMs: s.endMs })),
    priority: rule.priority,
    overlapRatio: rule.overlapRatio,
  })

  const merged = groups.map((group) => {
    const ranked = [group.primary, ...group.alternates].map((member) => byId.get(member.id)!)
    // A stable partition, so the priority order groupSessions settled on survives within each half.
    const members = [...ranked.filter((m) => !m.excluded), ...ranked.filter((m) => m.excluded)]
    return mergeGroup(members)
  })

  return merged.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function mergeGroup(members: readonly WorkoutSession[]): WorkoutSession {
  const primary = members[0]!
  if (members.length === 1) return primary
  return {
    ...primary,
    attrs: enrichAttrs(members.map((m) => m.attrs)),
    // Every member's source, not only the ones that filled a field: "also recorded by" is a fact
    // about the event, and a phone copy that added nothing still recorded it.
    sources: [...new Set(members.map((m) => m.sourceId))],
    alternateIds: members.slice(1).map((m) => m.id),
  }
}

/**
 * Paths whose record is taken whole from one member rather than filled field by field. The one
 * exception to the generic rule, and it is there because of how the provider writes the record:
 * proto3 JSON omits a zero Duration, so a zone missing from the primary's breakdown is a zero it
 * spent there, not an unknown. Filling it from another member would add peak minutes to a run
 * that had none, and the four durations would stop summing to the time the primary recorded.
 */
const WHOLE_RECORDS: ReadonlySet<string> = new Set(['metricsSummary.heartRateZoneDurations'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * attrs, best ranked member first, into one: each field from the first member whose value is not
 * null, recursing into records so one missing field inside `metricsSummary` can be filled without
 * taking the whole summary from a lower ranked source.
 *
 * Null and absent are the only gaps. A recorded zero, a recorded false and an empty array are
 * each something a device said, and workoutSummary already goes to some length to keep "0 km"
 * apart from "no distance recorded"; treating either as missing here would undo that one step
 * before it. Arrays are values, never merged element by element: a split list is one device's
 * cut of the run, and interleaving two would describe neither.
 */
export function enrichAttrs(values: readonly unknown[], path = ''): unknown {
  const present = values.filter((v) => v !== null && v !== undefined)
  // Null when some member stored an explicit null, absent (undefined) when none had the key: the
  // stored shape keeps every one of mapSessions' keys, and this should hand back the same keys.
  if (present.length === 0) return values.some((v) => v === null) ? null : undefined
  const first = present[0]
  if (!isRecord(first) || WHOLE_RECORDS.has(path)) return first

  // A later member holding a scalar where the first holds a record has nothing to fill it with.
  const records = present.filter(isRecord)
  const keys = [...new Set(records.flatMap((r) => Object.keys(r)))]
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = enrichAttrs(records.map((r) => r[key]), path === '' ? key : `${path}.${key}`)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * The person's own ranking and the instance's overlap ratio, the two inputs runDerive reads
 * before it calls deriveExerciseDay, so the list and the count group with one rule.
 */
export function mergeRuleFor(db: DbOrTx, personId: string): MergeRule {
  return {
    priority: loadPriority(db, personId),
    overlapRatio: new SettingsStore(db).get()?.sessionOverlapRatio ?? DEFAULT_OVERLAP_RATIO,
  }
}

/**
 * Merged workouts whose primary falls in a local date range.
 *
 * Read one day wider on each side, then filtered on the primary's own date. Two copies of one
 * event can be filed under different dates: a run ending just after midnight on one device and
 * just before it on the other, or the same clock under two offsets. Grouping only the rows inside
 * the range would answer the in-range copy as a workout of its own, and a reader paging from one
 * week to the next would see the run twice, once at the end of each. A chain longer than a day is
 * not a workout.
 *
 * `type` and `last` are applied after merging, not before. Filtered first, a phone copy carrying
 * RUNNING could be kept while the primary it merges into was not asked for; and `last` counted on
 * raw rows answers two copies of one run as "your last two".
 */
export function readMergedWorkouts(db: DbOrTx, input: {
  personId: string
  from: string
  to: string
  type?: string
  last?: number
  rule: MergeRule
}): WorkoutSession[] {
  const raw = readSessions(db, {
    personId: input.personId,
    kind: 'exercise',
    from: shiftLocalDate(input.from, -1),
    to: shiftLocalDate(input.to, 1),
  })
  const inRange = mergeWorkouts(raw, input.rule)
    .filter((w) => w.localDate >= input.from && w.localDate <= input.to)
  const matched = input.type === undefined
    ? inRange
    : inRange.filter((w) => workoutSummary(w.attrs).exerciseType === input.type)
  return input.last === undefined ? matched : matched.slice(-input.last)
}

/**
 * The merged workout a session id belongs to, whichever copy the id names.
 *
 * An alternate's id answers its event's merged workout, whose `id` is the primary's. Links made
 * before this merge existed named whichever copy a reader clicked, and exclusions and notes were
 * made against those ids too, so an old link has to keep opening the workout rather than 404.
 * The caller answers the merged workout under the id it was asked about; the response's own `id`
 * says which row now stands for it.
 */
export function mergedWorkoutFor(db: DbOrTx, input: {
  personId: string
  session: WorkoutSession
  rule: MergeRule
}): WorkoutSession {
  const { session } = input
  if (session.kind !== 'exercise') return session
  const around = readSessions(db, {
    personId: input.personId,
    kind: 'exercise',
    from: shiftLocalDate(session.localDate, -1),
    to: shiftLocalDate(session.localDate, 1),
  })
  const merged = mergeWorkouts(around, input.rule)
  return merged.find((w) => w.id === session.id || w.alternateIds.includes(session.id)) ?? session
}
