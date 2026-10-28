import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily } from '../db/schema/index.ts'
import { zoneBoundsFromFormula, zoneBoundsOf, zoneSecondsFromMinutes } from '../api/cardioLoad.ts'
import type { ZoneBounds } from '../api/cardioLoad.ts'
import { readSessionHeartRateMinutes } from '../query/sessionHeartRate.ts'
import { groupSessions } from './sessionOverlap.ts'
import type { SessionLike } from './overrides.ts'
import type { ExerciseSessionLike } from './exercise.ts'
import type { Priority } from './priority.ts'
import type { DailyRow } from './rollup.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE, ZONE_FORMULA_BASIS } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'

/**
 * A day's heart rate zone minutes, from its workouts' own heart rate, for a day that has none.
 *
 * Google sends `time_in_heart_rate_zone_*_minutes` for a watch day and a phone sends nothing, so a
 * phone-only household had no zone minutes and therefore no cardio load at all (#385). This fills
 * that gap from the minute heart rate recorded during the day's exercise sessions, sorted into the
 * day's zones.
 *
 * Workout time only, never the whole day's trace. #385 validated the formula zones against
 * exercise, where the heart rate is the person working; the rest of a day is sitting, walking to a
 * meeting and sleeping, and summing that into "light" would hand every phone day a load the formula
 * was never checked against. It is also what the read-time workout fill already does
 * (query/workoutDerived.ts, readFillZoneBounds): one workout's zones on its own page and the day's
 * zones on the dashboard come from the same minutes and the same bounds.
 *
 * Google's own rows always win. Where a target - a source, or the merged view - already has any
 * zone row for the day, it is left exactly as it is: those minutes were computed by the device
 * that measured them, against the ceilings it measured them with, and a second estimate written
 * beside them would be two answers to one question. The check is per target, so a phone's own row
 * is still written on a day a watch reported its zones, and the merged view keeps the watch's.
 *
 * The bounds come from the day's provider ceilings when all four are there (basis null: these are
 * a device's zones, sorted by us), else from the formula with the person's birthday and that day's
 * resting heart rate (basis `zone_formula`). Either way they are the bounds readFillZoneBounds
 * picks for a workout on that day, read in the same order, so the day and the workout never
 * disagree about which zone a minute was in.
 */

const ZONE_METRICS = {
  lightSeconds: 'time_in_heart_rate_zone_light_minutes',
  moderateSeconds: 'time_in_heart_rate_zone_moderate_minutes',
  vigorousSeconds: 'time_in_heart_rate_zone_vigorous_minutes',
  peakSeconds: 'time_in_heart_rate_zone_peak_minutes',
} as const

const ZONE_METRIC_NAMES = new Set<string>(Object.values(ZONE_METRICS))

// Heart rate is stored one reading a minute, so every reading zoneSecondsFromMinutes counts is
// sixty seconds and this division always lands on a whole number.
const SECONDS_PER_MINUTE = 60

export function deriveWorkoutZonesDay(tx: DbOrTx, input: {
  personId: string
  localDate: string
  birthDate: string | null
  /** The day's exercise sessions, session exclusions already applied. */
  sessions: readonly ExerciseSessionLike[]
  /** This pass's `[...derived, ...merged]`, before day_metric exclusions. */
  rows: readonly DailyRow[]
  /** The day's day_metric exclusions, so a resting heart rate or a ceiling thrown out is not used. */
  excluded: ReadonlySet<string>
  priority: Priority
  overlapRatio: number
}): DailyRow[] {
  // Before any read: most days have no workout, and those cost nothing here.
  if (input.sessions.length === 0) return []

  const resolved = boundsFor(tx, input)
  if (resolved === null) return []
  const { bounds, basis } = resolved

  const targets = [...new Set(input.sessions.map((s) => s.sourceId)), MERGED_SOURCE]
  const out: DailyRow[] = []
  for (const target of targets) {
    if (input.rows.some((row) => row.source === target && ZONE_METRIC_NAMES.has(row.metric))) continue

    const own = target === MERGED_SOURCE ? input.sessions : input.sessions.filter((s) => s.sourceId === target)
    // Through groupSessions even for one source's own list, exactly as deriveExerciseDay does: a
    // resync can store the same workout twice under one source, and for the merged view the same
    // run recorded by a watch and a phone is one workout. Only each group's primary is read, so
    // neither case counts the same minutes twice.
    const primaries = groupSessions({
      sessions: own.map((s): SessionLike => (
        { id: s.id, sourceId: s.sourceId, kind: 'exercise', startMs: s.startMs, endMs: s.endMs }
      )),
      priority: input.priority,
      overlapRatio: input.overlapRatio,
    }).map((group) => group.primary)

    // The reader the workout page and the Banister load use, with its pinned-source rule and the
    // person's sample exclusions and corrections, inside this transaction. endMs - 1 because a
    // session's span is half open, the read fillOne makes too: a reading stamped on the end
    // instant belongs to whatever came after.
    const minutes = primaries.flatMap((s) => readSessionHeartRateMinutes(tx, {
      personId: input.personId,
      startMs: s.startMs,
      endMs: s.endMs - 1,
      sessionSourceId: s.sourceId,
    }).minutes)
    // No heart rate at all is no zone minutes, not four zeros: a zero would read as a workout
    // measured at rest and put a load of nothing on the day.
    if (minutes.length === 0) continue

    const seconds = zoneSecondsFromMinutes(minutes, bounds)
    for (const [key, metric] of Object.entries(ZONE_METRICS) as [keyof typeof ZONE_METRICS, string][]) {
      out.push({
        personId: input.personId,
        localDate: input.localDate,
        metric,
        agg: 'sum',
        source: target,
        value: seconds[key] / SECONDS_PER_MINUTE,
        // Sessions have no samples underneath them in the coverage sense, the reason
        // derive/exercise.ts gives; and the merged row's minutes came from each workout's primary,
        // which is a session choice, not the hourly win the mix column counts.
        coverage: null,
        sourceMix: null,
        basis,
        derivationVersion: DERIVATION_VERSION,
      })
    }
  }
  return out
}

function boundsFor(tx: DbOrTx, input: {
  personId: string
  localDate: string
  birthDate: string | null
  rows: readonly DailyRow[]
  excluded: ReadonlySet<string>
}): { bounds: ZoneBounds, basis: typeof ZONE_FORMULA_BASIS | null } | null {
  const value = (metric: string) => dayValue(tx, input, metric)
  const ceiling = (zone: string) => value(`heart_rate_zone_${zone}_max_bpm`)
  const ceilings = zoneBoundsOf({
    light: ceiling('light'), moderate: ceiling('moderate'), vigorous: ceiling('vigorous'), peak: ceiling('peak'),
  })
  if (ceilings !== null) return { bounds: ceilings, basis: null }
  const formula = zoneBoundsFromFormula({
    birthDate: input.birthDate,
    localDate: input.localDate,
    restingBpm: value('resting_heart_rate'),
  })
  return formula === null ? null : { bounds: formula, basis: ZONE_FORMULA_BASIS }
}

/**
 * One daily 'last' number, in the order query/workoutDerived.ts's dailyValue reads it - merged,
 * then the provider's own reconciled row, then any other source - so the bounds derived here are
 * the bounds readFillZoneBounds reads back for the same day once this pass has been written.
 *
 * Merged and per-source rows come from this pass in memory, because the `daily` table still holds
 * the previous pass's until deriveDayInto replaces them. Provider rows are the exception: they are
 * ingested, never derived, deriveDayInto never deletes them, and so the table is the only place
 * they are.
 *
 * A metric the person excluded for the day is no value at all. deriveDayInto deletes every row of
 * an excluded metric, provider rows included, so dailyValue finds nothing for it afterwards, and
 * bounds computed from it here would be bounds the read side cannot reproduce.
 */
function dayValue(tx: DbOrTx, input: {
  personId: string
  localDate: string
  rows: readonly DailyRow[]
  excluded: ReadonlySet<string>
}, metric: string): number | null {
  if (input.excluded.has(metric)) return null
  const candidates = input.rows.filter((row) => row.metric === metric && row.agg === 'last' && row.value !== null)
  const merged = candidates.find((row) => row.source === MERGED_SOURCE)
  if (merged) return merged.value
  const provider = tx.select({ value: daily.value }).from(daily).where(and(
    eq(daily.personId, input.personId),
    eq(daily.localDate, input.localDate),
    eq(daily.metric, metric),
    eq(daily.agg, 'last'),
    eq(daily.source, PROVIDER_SOURCE),
  )).get()
  if (provider?.value != null) return provider.value
  return candidates[0]?.value ?? null
}
