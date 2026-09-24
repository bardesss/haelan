import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, people, sessionRoutes } from '../db/schema/index.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE } from '../derive/rollup.ts'
import { workoutDetail } from '../api/workoutSummary.ts'
import { edwardsLoadFromSeconds, banisterLoad, coefficientFor, ageAt } from '../api/cardioLoad.ts'
import type { CardioLoad } from '../api/cardioLoad.ts'
import { fillSplitHeartRate } from '../api/splitHeartRate.ts'
import type { FilledSplit } from '../api/splitHeartRate.ts'
import { readSessionHeartRateMinutes } from './sessionHeartRate.ts'
import type { WorkoutSession } from './sessions.ts'


/**
 * One workout's cardio load, both models.
 *
 * Computed on read rather than stored, unlike the daily `cardio_load_edwards` row. That is what
 * makes the two new `people` columns free: nothing derived depends on them, so editing a birthday
 * invalidates no row and triggers no rebuild. Moving this into derivation would take on that
 * obligation, and would also have to answer the light-zone floor question `banisterLoad`'s own
 * comment explains cannot be answered for a whole day.
 */
export function readWorkoutCardioLoad(db: DbOrTx, input: {
  personId: string
  session: WorkoutSession
}): CardioLoad | null {
  // readSession deliberately serves sleep rows as well as exercise ones (sessions.ts's own
  // comment), but a cardio load has no meaning for a night: banisterLoad's own comment explains
  // that its unfloored exponential, summed over hours just above resting, comes to roughly 70
  // TRIMP of doing nothing - which is exactly what a sedentary night measures, almost to the
  // point. The session's kind was never the thing wrong here; the number was. Null is the
  // correct cardio load for a night, not a thin one.
  if (input.session.kind !== 'exercise') return null

  const detail = workoutDetail(input.session.attrs)
  // Through the shared helper, not a second inline conversion. workoutComparison.ts scores this
  // same figure against recent workouts, and two copies of `/ 60` are how the number on the tile
  // and the number it is compared against come to round differently.
  const edwards = edwardsLoadFromSeconds(detail.zones)

  const banister = readBanister(db, input)

  // Three nulls is an absent answer, not a thin one, and answering an object for it would leave
  // every call site writing the same "is any of this non-null?" test before it could render
  // anything. Same rule as api/workoutSummary.ts's nullIfAllNull.
  if (edwards === null && banister === null) return null
  return {
    edwards,
    banister: banister?.value ?? null,
    banisterBasis: banister?.basis ?? null,
  }
}

/**
 * A workout's splits and laps with their heart rate filled in from the session's own trace.
 *
 * Lives beside readWorkoutCardioLoad because the two want the same two expensive things - the
 * decoded detail and the unthinned minute series - though each is called separately by every
 * current caller (tier2.ts's session-detail route calls both, `get_workout` calls both), so the
 * window is in fact read twice, and `sessionById`/`workoutDetail` three times over, for one
 * detail request. Measured small enough not to matter yet; sharing a module is what makes it easy
 * to fix in one place if that ever changes, not a claim that it already has been.
 *
 * Laps get the same treatment as splits. No archived payload in this household carries a lap
 * (measured 2026-09-11: zero across 197 sessions, every splitType DISTANCE), so that half is
 * written for the v4 schema rather than on evidence - the same footing the lap table itself
 * already stands on.
 */
export function readWorkoutSplits(db: DbOrTx, input: {
  personId: string
  session: WorkoutSession
}): { autoSplits: FilledSplit[], laps: FilledSplit[] } {
  // Same guard as readWorkoutCardioLoad, and for the same reason: a sleep session's attrs carry no
  // exercise splits to fill, and filling a lap's heart rate from a night's trace would be an
  // answer to a question nobody asked of a health record it was never asked about before.
  if (input.session.kind !== 'exercise') return { autoSplits: [], laps: [] }

  const detail = workoutDetail(input.session.attrs)
  // Four workouts in five record neither, so the trace is not read for them at all.
  if (detail.autoSplits.length === 0 && detail.laps.length === 0) {
    return { autoSplits: [], laps: [] }
  }
  const { minutes } = readSessionHeartRateMinutes(db, {
    personId: input.personId,
    startMs: input.session.startMs,
    endMs: input.session.endMs,
    sessionSourceId: input.session.sourceId,
  })
  return {
    autoSplits: fillSplitHeartRate(detail.autoSplits, minutes),
    laps: fillSplitHeartRate(detail.laps, minutes),
  }
}

export interface RoutePoint {
  atMs: number
  latitude: number
  longitude: number
  altitudeMetres: number | null
  horizontalAccuracyMetres: number | null
  verticalAccuracyMetres: number | null
}

/**
 * A workout's GPS route, oldest point first.
 *
 * No personId in the input, unlike readWorkoutCardioLoad and readWorkoutSplits beside it: those
 * two cross into `daily` and the heart rate trace, tables keyed on person, while `session_routes`
 * is keyed on nothing but the session id, and the session handed in was already read scoped to a
 * person by whoever called sessionById. A second scope here would check nothing a first one had
 * not already checked.
 *
 * Empty for a sleep session and for an exercise session that carries no recorded route - both are
 * the same true answer, a session with nothing to draw, and neither is the caller's job to tell
 * apart from the other. Unlike readWorkoutCardioLoad and readWorkoutSplits, "no route" is not a
 * property of the session's kind the way "no cardio load" is of a night; it only happens to be true
 * for every sleep session too, since sleep never carries one.
 */
export function readWorkoutRoute(db: DbOrTx, input: {
  session: WorkoutSession
}): RoutePoint[] {
  if (input.session.kind !== 'exercise') return []
  // A merged workout's route is its first member's that has one, in the same best-first order its
  // attrs were filled in (mergedWorkouts.ts): Google never sends a route, so a run the priority
  // list credits to Google still draws the track the phone recorded for it. Whole routes, never
  // points from two members interleaved, for the reason a split list is never merged either.
  //
  // One read for every member rather than one per member, grouped here: a workout has two or three
  // copies at most, but a query per candidate is the shape drizzle-prepares-per-run warned about.
  const order = [input.session.id, ...input.session.alternateIds]
  const rows = db.select({
    sessionId: sessionRoutes.sessionId,
    atMs: sessionRoutes.atMs,
    latitude: sessionRoutes.latitude,
    longitude: sessionRoutes.longitude,
    altitudeMetres: sessionRoutes.altitudeMetres,
    horizontalAccuracyMetres: sessionRoutes.horizontalAccuracyMetres,
    verticalAccuracyMetres: sessionRoutes.verticalAccuracyMetres,
  }).from(sessionRoutes).where(inArray(sessionRoutes.sessionId, order))
    .orderBy(asc(sessionRoutes.ordinal)).all()
  const owner = order.find((id) => rows.some((row) => row.sessionId === id))
  return rows.filter((row) => row.sessionId === owner).map(({ sessionId: _, ...point }) => point)
}

function readBanister(db: DbOrTx, input: { personId: string, session: WorkoutSession }) {
  const person = db.select().from(people).where(eq(people.id, input.personId)).get()
  const birthDate = person?.birthDate ?? null
  const sex = person?.sex ?? null
  // Both, not either. k comes from sex and the HRmax fallback comes from the birthday, and a load
  // computed with one of them defaulted is a number nobody can account for.
  if (birthDate === null || sex === null) return null

  const localDate = input.session.localDate
  const restingBpm = dailyValue(db, input.personId, localDate, 'resting_heart_rate')
  // The day's own resting heart rate, never the nearest one from another day. A person who was not
  // wearing the watch overnight has no resting reading for that day, and borrowing one from a week
  // ago would put a number on this workout that was measured about a different week.
  if (restingBpm === null) return null

  // The ceiling Google computed that day's zones against, so our load and our zone minutes
  // describe the same model of the same person. 220 - age only when the day has no such row.
  const ceiling = dailyValue(db, input.personId, localDate, 'heart_rate_zone_peak_max_bpm')
  const age = ageAt(birthDate, localDate)
  const maxBpm = ceiling ?? (age === null ? null : 220 - age)
  if (maxBpm === null) return null
  const maxBpmSource = ceiling === null ? 'ageFormula' as const : 'providerZoneCeiling' as const

  const { minutes } = readSessionHeartRateMinutes(db, {
    personId: input.personId,
    startMs: input.session.startMs,
    endMs: input.session.endMs,
    sessionSourceId: input.session.sourceId,
  })
  const k = coefficientFor(sex)
  const value = banisterLoad(minutes, { restingBpm, maxBpm, k })
  if (value === null) return null

  return { value, basis: { restingBpm, maxBpm, maxBpmSource, k, minutes: minutes.length } }
}

/**
 * One derived daily number for a person and date.
 *
 * `merged` rather than a device: both metrics read here are one number for the day however many
 * devices reported it, and picking a device would make the load depend on which watch happened to
 * be worn. Falls back to the provider's own reconciled row, which is where a resting heart rate
 * usually lives for a household that has only ever had one device.
 *
 * Filtered on `agg` too, even though `resting_heart_rate` and `heart_rate_zone_peak_max_bpm` both
 * declare `aggs: ['last']` today (derive/metrics.ts) and so cannot yet collide with anything: a
 * metric that gained a second aggregate later would otherwise let this function pick whichever
 * one sqlite happened to return first, silently.
 */
function dailyValue(db: DbOrTx, personId: string, localDate: string, metric: string): number | null {
  const rows = db.select().from(daily).where(and(
    eq(daily.personId, personId),
    eq(daily.localDate, localDate),
    eq(daily.metric, metric),
    eq(daily.agg, 'last'),
  )).all()
  for (const source of [MERGED_SOURCE, PROVIDER_SOURCE]) {
    const row = rows.find((r) => r.source === source && r.value !== null)
    if (row) return row.value
  }
  // Neither the merged row nor the provider's own reconciled row: some other source's row exists
  // instead (a device the priority list has not reconciled, or a household with no `merged`/
  // `provider` convention for this metric at all). Answering the first non-null one sqlite
  // returns is an arbitrary choice among sources, not a wrong one - a single-device household has
  // exactly one row here anyway - but it is a choice, and the two branches above are tried first
  // so it is never reached when a better answer exists.
  const any = rows.find((r) => r.value !== null)
  return any?.value ?? null
}
