import type { DbOrTx } from '../db/open.ts'
import { INTRADAY_WINDOW_MAX_MS, readIntradayWindow } from './intraday.ts'
import { NO_THINNING, readSessionHeartRateMinutes } from './sessionHeartRate.ts'
import { readWorkoutZoneBounds } from './workoutDerived.ts'
import { sessionRateOf } from './sessions.ts'
import type { WorkoutSession } from './sessions.ts'
import { zoneSecondsFromMinutes } from '../api/cardioLoad.ts'
import { exerciseCategory, rateOf } from '../api/exerciseCategory.ts'
import { getSource } from '../store/sources.ts'
import { hasGoogleGrant } from '../store/credentials.ts'

/**
 * The start of every Health Connect source's externalId: sources.ts's describe() joins the
 * payload's platform first, and the companion's uploads name HEALTH_CONNECT (ingest.ts).
 */
export const PHONE_SOURCE_PREFIX = 'HEALTH_CONNECT:'

/**
 * How long after a phone workout ends its page still promises Google's figures. Google's copy
 * usually lands within hours of the watch syncing, so two days leaves room for a watch that synced
 * late. Past it the promise lapses and the fill stays: a workout Google never receives (one from an
 * app that writes to Health Connect alone, say Strava) would otherwise promise figures forever.
 */
export const PENDING_WINDOW_MS = 48 * 60 * 60 * 1000

/** Whether a merged exercise row has no Google payload behind it: no metricsSummary at all. */
export function isBare(session: WorkoutSession): boolean {
  if (session.kind !== 'exercise') return false
  const attrs = session.attrs
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return false
  const summary = (attrs as Record<string, unknown>).metricsSummary
  return summary === null || summary === undefined
}

/**
 * One read's filler: fillFromSamples for each row it is handed, with what every row asks the same
 * (the person's Google grant, whether a source is a phone) read at most once per read, not once per
 * row. `nowMs` is the reading clock the promise is measured against (PENDING_WINDOW_MS); a read
 * without one promises nothing and still fills.
 */
export function samplesFiller(db: DbOrTx, input: { personId: string, nowMs?: number }): (session: WorkoutSession) => WorkoutSession {
  const { personId, nowMs } = input
  let grant: boolean | undefined
  const phone = new Map<string, boolean>()
  const isPhone = (sourceId: string) => {
    let known = phone.get(sourceId)
    if (known === undefined) {
      known = getSource(db, personId, sourceId)?.externalId.startsWith(PHONE_SOURCE_PREFIX) === true
      phone.set(sourceId, known)
    }
    return known
  }
  // Answers: whether a Google copy of this bare row is still to come. Only a recent phone workout
  // has one, and only for a person whose Google grant stands: an all-Android household syncs no
  // copy at all, so its phone workouts are filled but promise nothing. Cheapest question first.
  const copyToCome = (session: WorkoutSession) => {
    if (nowMs === undefined || nowMs - session.endMs >= PENDING_WINDOW_MS) return false
    if (!isPhone(session.sourceId)) return false
    grant ??= hasGoogleGrant(db, personId)
    return grant
  }
  return (session) => fillOne(db, { personId, session, copyToCome })
}

/**
 * A phone-only workout, filled from its own samples until Google's copy arrives.
 *
 * The companion app sends a workout as its type, its interval and a route (SyncEngine.kt's
 * exercise points), never a metricsSummary, so until the Google Health API copy syncs and merges
 * every figure read off `attrs.metricsSummary` is empty: a treadmill run showed only its elapsed
 * time and the figures read from heart rate samples. The samples the phone sent beside it already
 * hold most of those figures, so the merged read fills them in.
 *
 * **Only on request.** The merged readers call this only for a read that displays its rows
 * (`fill`); history and baseline reads never do, so an estimate never enters a usual, a comparison
 * or a record.
 *
 * **Only a bare row.** A row whose merged attrs carry any metricsSummary has a Google payload
 * behind it and is answered untouched: a Google value always beats a filled one, and filling
 * field by field into Google's summary would mix a device's figures with estimates. This runs
 * after mergeGroup's enrichAttrs, so a phone copy that has merged with its Google copy is never
 * bare.
 *
 * **What is filled, into the provider's own metricsSummary keys**, so every reader of attrs
 * (the list row, the workout page, the glance) picks it up without knowing it was filled:
 * - steps, distance and calories: the `steps`, `distance` and `active_energy` samples over the
 *   workout's interval, summed. From the workout's own source first, else from the one other
 *   source that holds the most readings there, never two summed together: two devices counting
 *   the same steps would count them twice.
 * - average heart rate: the mean of readSessionHeartRateMinutes, the reader the cardio load uses.
 * - zones: those minutes against the day's zone bounds; none without bounds.
 * - pace (on foot) or speed (on a bike): distance over ELAPSED time, since pauses are unknown and
 *   moving time stays null. `filled` names them so the page can word them as elapsed.
 *
 * Edwards load and the hard-zone minutes follow from the zones where they are read.
 *
 * **Marked.** Every bare row from a phone (a Health Connect source: PHONE_SOURCE_PREFIX) of a
 * person with a standing Google grant (hasGoogleGrant), ended less than PENDING_WINDOW_MS before
 * the read's `nowMs`, gets `attrs.awaitingSummary: true`, filled or not (no samples, or a span too
 * long to read), so the page can say the watch's figures are still coming. A bare row from any
 * other source (a Google exercise logged without a summary), from the phone of a person who never
 * connected Google or whose grant was revoked, or older than the window, has no copy on its way
 * and is never marked: it would promise figures forever. A read with no `nowMs` marks nothing. Where
 * something was filled, `attrs.filledFromSamples` is true and `attrs.filled` lists the
 * metricsSummary keys that came from samples, so a figure can say where it came from and records
 * can refuse an estimate (sessionRecords.ts).
 *
 * **Over `[startMs, endMs)`.** A sample is keyed on the start of its interval (a heart rate minute
 * on the minute's start), so one starting at the workout's end belongs to the time after it.
 *
 * **Cost.** About eight reads per bare row (one intraday read per metric, a second for a metric the
 * workout's own source did not record, the heart rate minutes and the zone bounds), and none for a
 * merged one. Every bare row costs that, and an all-Android household's workouts are all bare, so a
 * read fills only rows it displays and bounds them: the list route fills its page alone, and the
 * Activity period only a week's or a month's rows (activityPeriod.ts). The grant and the source are
 * read once per read (samplesFiller).
 */
export function fillFromSamples(db: DbOrTx, input: { personId: string, session: WorkoutSession, nowMs?: number }): WorkoutSession {
  return samplesFiller(db, input)(input.session)
}

function fillOne(db: DbOrTx, input: {
  personId: string, session: WorkoutSession, copyToCome: (session: WorkoutSession) => boolean
}): WorkoutSession {
  const { personId, session } = input
  if (!isBare(session)) return session
  const record = session.attrs as Record<string, unknown>
  const awaiting = input.copyToCome(session) ? { ...record, awaitingSummary: true } : record
  const unfilled = { ...session, attrs: awaiting }
  const { startMs } = session
  // Half open: readIntradayWindow includes its end, so read to the last millisecond before the
  // workout's. A zero-length or reversed row reads an empty window and so fills nothing, which is
  // also what keeps the elapsed-time division below off a zero.
  const endMs = session.endMs - 1
  // The intraday window's own cap: a span longer than any workout is not one to sum samples over.
  if (session.endMs - startMs > INTRADAY_WINDOW_MAX_MS) return unfilled

  const summary: Record<string, unknown> = {}
  const sum = (metric: string) => sumOverSession(db, { personId, metric, startMs, endMs, sourceId: session.sourceId })
  const steps = sum('steps')
  if (steps !== null) summary.steps = steps
  const distance = sum('distance')
  if (distance !== null) summary.distanceMillimeters = distance
  const calories = sum('active_energy')
  if (calories !== null) summary.caloriesKcal = calories

  const { minutes } = readSessionHeartRateMinutes(db, { personId, startMs, endMs, sessionSourceId: session.sourceId })
  if (minutes.length > 0) {
    // Whole bpm, the provider's own shape for it.
    summary.averageHeartRateBeatsPerMinute = Math.round(minutes.reduce((total, m) => total + m.bpm, 0) / minutes.length)
    const bounds = readWorkoutZoneBounds(db, { personId, session })
    if (bounds !== null) {
      const zones = zoneSecondsFromMinutes(minutes, bounds)
      // The provider's own Duration strings, all four: a zero here is a zero, never an unknown.
      summary.heartRateZoneDurations = {
        lightTime: `${zones.lightSeconds}s`, moderateTime: `${zones.moderateSeconds}s`,
        vigorousTime: `${zones.vigorousSeconds}s`, peakTime: `${zones.peakSeconds}s`,
      }
    }
  }

  // Over elapsed time: moving time is unknown without pauses, and stays null.
  const rate = rateOf(exerciseCategory(typeof record.exerciseType === 'string' ? record.exerciseType : null))
  if (distance !== null && distance > 0) {
    const elapsedSeconds = (session.endMs - startMs) / 1000
    if (rate === 'pace') summary.averagePaceSecondsPerMeter = elapsedSeconds / (distance / 1000)
    if (rate === 'speed') summary.averageSpeedMillimetersPerSecond = distance / elapsedSeconds
  }

  const filled = Object.keys(summary)
  if (filled.length === 0) return unfilled
  const filledAttrs = { ...awaiting, metricsSummary: summary, filledFromSamples: true, filled }
  return { ...session, attrs: filledAttrs, rate: sessionRateOf(filledAttrs) }
}

/**
 * A metric's samples summed over a workout's interval, each minute's point being its mean times
 * its readings (the minute's sum, throughOf's cadence rule). Readings the person excluded are
 * dropped. The workout's own source first; else the single other source with the most readings.
 * Null when nothing was recorded.
 */
function sumOverSession(db: DbOrTx, input: {
  personId: string, metric: string, startMs: number, endMs: number, sourceId: string
}): number | null {
  const { personId, metric, startMs, endMs } = input
  const read = (sourceId?: string) => readIntradayWindow(db, {
    personId, metric, startMs, endMs, points: NO_THINNING, sourceId,
  }).points.filter((p) => !p.excluded && p.mean !== null)

  let points = read(input.sourceId)
  if (points.length === 0) {
    const bySource = new Map<string, typeof points>()
    for (const p of read()) bySource.set(p.sourceId, [...(bySource.get(p.sourceId) ?? []), p])
    const readings = (list: typeof points) => list.reduce((n, p) => n + p.n, 0)
    const best = [...bySource.entries()]
      .sort(([a, x], [b, y]) => readings(y) - readings(x) || (a < b ? -1 : a > b ? 1 : 0))[0]
    points = best === undefined ? [] : best[1]
  }
  if (points.length === 0) return null
  return points.reduce((total, p) => total + p.mean! * p.n, 0)
}
