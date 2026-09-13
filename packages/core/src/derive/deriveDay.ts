import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, samples, sessions, sessionSegments } from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'
import { rollUpDay, PROVIDER_SOURCE, MERGED_SOURCE } from './rollup.ts'
import type { SampleLike } from './rollup.ts'
import { mergeDay } from './merge.ts'
import type { Priority } from './priority.ts'
import { localDateOf, widenedUtcWindow } from './localDay.ts'
import { applyToDay, applyToSamples, applyToSessions, excludedMetrics } from './overrides.ts'
import type { OverrideLike } from './overrides.ts'
import { deriveSleepDay, mainSleepOf } from './sleep.ts'
import type { SleepSessionLike } from './sleep.ts'
import { mergeSleepDay } from './sleepMerge.ts'
import { deriveExerciseDay } from './exercise.ts'
import type { ExerciseSessionLike } from './exercise.ts'
import { deriveCardioLoadDay } from './cardioLoad.ts'
import { deriveActivityBandsDay, mergeActivityBandsDay } from './activityBands.ts'

export interface DeriveDayInput {
  personId: string
  localDate: string
  priority: Priority
  overrides: OverrideLike[]
  gapMinutes: number
  overlapRatio: number
  nowMs: number
}

/**
 * Replaces one person's derived rows for one local date, through the handle it is given.
 *
 * The transaction belongs to the caller. The queue drain wraps one day at a time so a crash
 * costs one day; a rebuild wraps a whole person so no reader ever sees them half rebuilt. Both
 * need the same arithmetic, and two copies of it would be two answers to what a day means.
 */
export function deriveDayInto(tx: DbOrTx, input: DeriveDayInput): number {
  // A person can carry years of samples, so scanning every row of their history per queued
  // day is not an option: the spec puts sample volume at roughly 3.2 million rows a year.
  // The provider API can report offsets from UTC-12 to UTC+14, so a local day's instants can
  // land up to 14 hours either side of its UTC midnight. Widen the query by that much, then
  // apply the exact per-row filter below: the result is identical to an unbounded scan, only
  // the number of rows read to get there changes.
  const { start: windowStart, end: windowEnd } = widenedUtcWindow(input.localDate)

  // Bound to the caller's transaction, whether that is the queue drain's one-day transaction or a
  // rebuild's whole-person one. Its cache is what keeps the translation below affordable: a day of
  // heart rate is thousands of rows naming a handful of metrics and one or two sources, so this
  // costs a query per distinct name rather than a query per row.
  const keys = new SampleKeys(tx)

  // Translated back to names before anything derives from them. Everything downstream - the
  // rollups, the merge, the priority list, the override keys - is keyed on the metric name and the
  // source id a person actually configured, and pushing refs through it would mean teaching every
  // one of those a database representation none of them has any use for.
  const dayRows: SampleLike[] = tx.select().from(samples).where(and(
    eq(samples.personRef, keys.personRef(input.personId)),
    gte(samples.utcMs, windowStart),
    lte(samples.utcMs, windowEnd),
  )).all()
    .filter((row) => localDateOf(row.utcMs, row.tzOffsetMinutes) === input.localDate)
    .map((row) => keys.sampleText(row))

  const personOverrides = input.overrides
  // Before aggregation, so an excluded reading is absent from the mean rather than removed
  // from it afterwards, and so an hour whose only reading was excluded is not an hour won.
  const kept = applyToSamples(dayRows, personOverrides)

  const derived = rollUpDay({
    personId: input.personId,
    localDate: input.localDate,
    rows: kept,
  })
  const merged = mergeDay({
    personId: input.personId,
    localDate: input.localDate,
    rows: kept,
    priority: input.priority,
  })

  // From the same kept rows as the rollup above: the day's samples are already in memory, filtered
  // to this local date and override applied, so the intersection costs no extra query.
  const bandSources = [...new Set(kept.map((row) => row.sourceId))]
  const perSourceBands = bandSources.flatMap((source) => deriveActivityBandsDay({
    personId: input.personId,
    localDate: input.localDate,
    source,
    rows: kept.filter((row) => row.sourceId === source),
  }))
  const mergedBands = mergeActivityBandsDay({
    personId: input.personId,
    localDate: input.localDate,
    rows: kept,
    priority: input.priority,
  })

  // sessions.local_date is computed at ingest and indexed, so unlike samples this needs no
  // widened window and no per row filter.
  const sleepRows = tx.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.localDate, input.localDate),
    eq(sessions.kind, 'sleep'),
  )).all()

  const sleepSessions: SleepSessionLike[] = applyToSessions(
    sleepRows.map((row) => ({
      id: row.id, sourceId: row.sourceId, kind: row.kind, startMs: row.startMs, endMs: row.endMs,
    })),
    personOverrides,
  ).map((kept) => {
    const row = sleepRows.find((r) => r.id === kept.id)!
    return {
      id: row.id,
      sourceId: row.sourceId,
      startMs: row.startMs,
      startOffsetMinutes: row.startOffsetMinutes,
      endMs: row.endMs,
      endOffsetMinutes: row.endOffsetMinutes,
      mainSleep: mainSleepOf(row.attrs),
    }
  })

  const segments = sleepSessions.length === 0 ? [] : tx.select().from(sessionSegments)
    .where(inArray(sessionSegments.sessionId, sleepSessions.map((s) => s.id))).all()

  const perSourceSleep = [...new Set(sleepSessions.map((s) => s.sourceId))].flatMap((source) =>
    deriveSleepDay({
      personId: input.personId,
      localDate: input.localDate,
      source,
      sessions: sleepSessions.filter((s) => s.sourceId === source),
      segments,
      gapMinutes: input.gapMinutes,
    }))

  const mergedSleep = mergeSleepDay({
    personId: input.personId,
    localDate: input.localDate,
    sessions: sleepSessions,
    segments,
    gapMinutes: input.gapMinutes,
    overlapRatio: input.overlapRatio,
    priority: input.priority,
  })

  const exerciseRows = tx.select().from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.localDate, input.localDate),
    eq(sessions.kind, 'exercise'),
  )).all()

  const exerciseSessions: ExerciseSessionLike[] = applyToSessions(
    exerciseRows.map((row) => ({
      id: row.id, sourceId: row.sourceId, kind: row.kind, startMs: row.startMs, endMs: row.endMs,
    })),
    personOverrides,
  ).map((kept) => {
    const row = exerciseRows.find((r) => r.id === kept.id)!
    return {
      id: row.id,
      sourceId: row.sourceId,
      startMs: row.startMs,
      endMs: row.endMs,
      startOffsetMinutes: row.startOffsetMinutes,
    }
  })

  const perSourceExercise = [...new Set(exerciseSessions.map((s) => s.sourceId))].flatMap((source) =>
    deriveExerciseDay({
      personId: input.personId,
      localDate: input.localDate,
      source,
      sessions: exerciseSessions.filter((s) => s.sourceId === source),
      priority: input.priority,
      overlapRatio: input.overlapRatio,
    }))

  const mergedExercise = deriveExerciseDay({
    personId: input.personId,
    localDate: input.localDate,
    source: MERGED_SOURCE,
    sessions: exerciseSessions,
    priority: input.priority,
    overlapRatio: input.overlapRatio,
  })

  const excluded = excludedMetrics(personOverrides, input.localDate)

  // Computed from the zone rows that survive exclusion, not from the ones before it. A person who
  // threw out a day's zone minutes threw out the load computed from them, and reading the
  // unfiltered list here would leave the load standing on numbers no longer on any chart.
  // applyToDay is a pure filter, so running it twice costs one pass and cannot differ from itself.
  const cardioLoad = deriveCardioLoadDay({
    personId: input.personId,
    localDate: input.localDate,
    rows: applyToDay([...derived, ...merged], excluded),
  })

  const rows = applyToDay(
    [...derived, ...merged, ...perSourceSleep, ...mergedSleep, ...perSourceBands, ...mergedBands,
      ...perSourceExercise, ...mergedExercise, ...cardioLoad],
    excluded,
  )

  // Everything we derive for this day goes, then comes back. Provider rows are excluded
  // because they are ingested rather than derived and nothing here could recompute them.
  tx.delete(daily).where(and(
    eq(daily.personId, input.personId),
    eq(daily.localDate, input.localDate),
    ne(daily.source, PROVIDER_SOURCE),
  )).run()

  // A day_metric exclusion reaches the provider rows too, which the delete above spares.
  // Google's own reconciliation is still a number for the day somebody threw out, and it is
  // rewritten by the next sync of that metric, which requeues the day and lands back here.
  for (const metric of excluded) {
    tx.delete(daily).where(and(
      eq(daily.personId, input.personId),
      eq(daily.localDate, input.localDate),
      eq(daily.metric, metric),
    )).run()
  }

  for (const row of rows) tx.insert(daily).values({ ...row, updatedAtMs: input.nowMs }).run()

  return rows.length
}
