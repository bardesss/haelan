// A generator of plausible demo data. It writes archive payloads and nothing else - no row in
// `samples`, `daily`, `sessions`, `session_segments` or `observations` is ever inserted directly
// here. Everything a later reader sees in those tables has to come from the app's own rebuild
// replaying the bodies this file writes, the same as a real person's history does. That is what
// makes the result provably reachable by a real instance: a seed that wrote a derived row could
// draw a chart no real household could ever produce.
//
// Shaped, not modelled. Steps rise through the morning and fall after evening, and run lower on
// Sundays. Heart rate troughs overnight and otherwise tracks the step curve, except for the one
// hour a workout lands: that hour's steps and heart rate both spike together, the way a moving
// person's actually do, and the exercise session written for the day names the same window
// rather than a second, disagreeing one. Overnight heart rate is drawn a few beats below the
// day's own resting figure rather than from an unrelated absolute band, since "resting heart
// rate" is by definition close to a night's lowest sustained reading, not routinely ten-plus
// beats above it. Sleep lands in a plausible window with realistic stage proportions and drifts
// by tens of minutes a night, except for the occasional short, restless one - a real span of
// nights is not uniform, and a chart where every bar is the same height reads as generated
// rather than lived. Weight drifts rather than walks - one slow trend held for the whole span,
// not a meander that could wander anywhere. Workouts land a few times a week, on a fixed
// schedule rather than a coin flip, so the exercise type always shows up regardless of which
// seed a caller passes, and the type is always one the Google Health API actually emits: drawn
// from the repository's own drift-checked `EXERCISE_TYPES`, not a private list that could invent
// a value the API has never sent. Distance tracks the same per-hour step curve rather than being
// drawn on its own - each hour's distance is that hour's own step count times a jittered stride
// length, so a workout hour's longer, faster steps carry straight through to a longer distance for
// free, the same way the workout's own hour already lifts steps and heart rate together. Active
// energy burned carries a resting floor under the activity-shaped component on top of it, because
// even the hour someone is asleep a real tracker still reports a small burn, never zero. Active
// minutes and heart-rate-zone minutes both concentrate around the day's own workout rather than
// accruing steadily across it: a light-activity floor from the day's ordinary movement, and the
// moderate/vigorous minutes (and the cardio/peak zone minutes) landing almost entirely inside the
// workout's own span, which is where a real watch would actually see the elevated effort. Floors
// is modest and lumpy - most days a handful, some days a stair-climbing outlier - rather than a
// smooth curve, since a flight of stairs is a discrete event a formula-shaped curve does not
// produce. Recovery's three daily figures each get a different kind of
// noise instead of one formula reused three times: resting heart rate drifts like weight, HRV
// swings around a fixed baseline day to day, and respiratory rate barely moves at all - the same
// spread a real week of each actually has, and the reason the Recovery page (and its Dashboard
// card) draws anything once the app rebuilds from this. Moods is the one categorical type here,
// seeded so `observations` is not empty once the app rebuilds; see the ruling in this unit's plan
// for why `moods` and not one of the reproductive health types. Every payload carries the offset
// Europe/Amsterdam actually had in force at that instant - CET or CEST, never a flat UTC - since
// this app's whole premise is local days and a demo that never disagreed with UTC would be
// demonstrating the one case it does not need to get right. None of this computes anything about
// the body it is shaped after - no metabolic model, no calorie balance, nothing that would make
// a claim about physiology it has no business making. What it does do is agree with itself: a
// workout raises both curves for its own hour, a resting figure sits near the night it is
// resting from, and a bad night is actually short.
//
// Deterministic by construction: mulberry32 streams seeded once from the one seed (the day's
// shared stream, and one each for the night page's and the workout page's readings), each
// consumed in a fixed order, and nothing here ever reaches for Math.random. The same seed
// produces the same bytes today and a year from now, which is the property both this unit's
// rehearsal and the next unit's screenshots depend on.
//
// Floors and total-calories are the two exceptions to every `put` call above: the catalogue gives
// them no `list` filter at all - `filterMember` is null, and `dailyRollUp` is the only action that
// answers a per-day figure for either - so they cannot go through `listRequestParams`, which
// assumes a filter exists to build. `putRollups`, below, mirrors client.ts's own
// `dailyRollUpDataPoints` instead: a `range` requestParams rather than a `filter`, a
// `rollupDataPoints` envelope rather than `dataPoints`, and a window no wider than the type's own
// `rollupRangeCapDays` - a wider one is a request the real API would refuse, and a payload this
// generator wrote for a call no real sync could have made would break the file's own opening
// promise just as surely as a derived row would.

import { randomUUID } from 'node:crypto'
import type { DataType } from '../api/catalogue.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { EXERCISE_TYPES } from '../api/enums.ts'
import { localDateOf } from '../derive/localDay.ts'
import { rollupRangeCapDays } from '../sync/runRollupJob.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { RollupWindow, SleepStage } from './payloads.ts'
import { body, dailyPoint, dailyRollupBody, intervalPoint, nextDay, samplePoint, sleepPoint } from './payloads.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// Arbitrary and fixed, never Date.now(): a caller that never passes a seed still gets the same
// bytes on every run, which is the whole point of writing a PRNG instead of reaching for one.
const DEFAULT_SEED = 20260301

// Five lines, as promised: a small, fast, deterministic generator over 32-bit state. Public
// domain algorithm (Tommy Ettinger), reimplemented here rather than pulled in as a dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const range = (rand: () => number, min: number, max: number): number => min + rand() * (max - min)
const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!

// The daily-summary metrics below (resting heart rate, HRV, respiratory rate, and - via
// floorsWindows/totalCaloriesWindows further down - floors and total calories) key off the civil
// date dailyPoint and putRollups expect, not the millisecond instant the rest of this file passes
// around. `dayStart` sits at Amsterdam local midnight (localMidnightMs's own comment, and every
// day back from it is one more 24-hour chunk), which is a UTC instant late in the *previous* UTC
// day whenever Amsterdam is ahead of UTC - which it always is, CET or CEST, never behind. Reading
// getUTCFullYear/Month/Date straight off that instant, as an earlier version of this function did,
// therefore names the day before the one this chunk was generated for, on every one of these five
// metrics, every day of the span. steps, heart rate and the rest of this file never went through
// this function - the rebuild works their civil date out from the timestamps and offsets each
// payload already carries - which is why the earlier bug was invisible everywhere except these
// five: they are the ones that hand the API a pre-computed date rather than an instant, and the
// only caller of this function. Fixed by asking derive/localDay.ts's own `localDateOf`, the one
// place this codebase already computes a local day boundary, rather than re-approximating it a
// second time with a mistake the first approximation did not have.
const civilDateOf = (ms: number): { year: number, month: number, day: number } => {
  const offsetMinutes = Number(amsterdamOffset(ms).slice(0, -1)) / 60
  const [year, month, day] = localDateOf(ms, offsetMinutes).split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

// The catalogue has grown twice this month, and a wrong id here is a payload nothing maps: the
// rebuild yields zero rows for it and every test in this plan still passes. Resolving through
// dataTypeById rather than passing bare strings to archive.put turns that silent failure into a
// thrown one, at generation time rather than never.
function requireType(id: string): DataType {
  const t = dataTypeById(id)
  if (!t) throw new Error(`seedArchive: '${id}' is not a data type this catalogue knows about`)
  return t
}

// Mirrors buildFilter in api/client.ts closely enough that a payload this file writes is not
// distinguishable, by shape, from one a real fetch archived: same three keys, same filter
// grammar, same page size. Built from the type's own filterRoot/filterMember rather than
// hardcoded per call, so drift between this and the catalogue would show up as a wrong string
// rather than needing six copies kept in sync by hand.
function listRequestParams(t: DataType, startMs: number, endMs: number): Record<string, unknown> {
  const member = `${t.filterRoot}.${t.filterMember}`
  // civil_start_time carries no offset in a real filter; every other member here is an absolute
  // instant. Approximated in UTC since this generator has no person timezone to consult.
  const fmt = t.filterMember === 'interval.civil_start_time'
    ? (ms: number) => new Date(ms).toISOString().slice(0, 19)
    : (ms: number) => new Date(ms).toISOString()
  return { filter: `${member} >= "${fmt(startMs)}" AND ${member} < "${fmt(endMs)}"`, pageSize: 10_000, pageToken: null }
}

// The offset Europe/Amsterdam actually had in force at `ms`: '3600s' (CET) outside daylight
// saving, '7200s' (CEST) inside it. The seeded person's timezone (seedPerson's own default) is
// Europe/Amsterdam, so a payload claiming '0s' regardless of date was demonstrating the one case
// this app's local-day arithmetic does not need - see startOfLocalDay's own comment for why a
// day boundary is never a UTC boundary here. The Netherlands follows the EU-wide rule - clocks
// move at 01:00 UTC on the last Sunday of March and October - so this is arithmetic rather than a
// timezone database, and it changes across the boundary on its own whenever a span crosses one.
function lastSundayUtcMs(year: number, monthIndex0: number): number {
  const lastOfMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0))
  const sunday = lastOfMonth.getUTCDate() - lastOfMonth.getUTCDay()
  return Date.UTC(year, monthIndex0, sunday, 1, 0, 0)
}
function amsterdamOffset(ms: number): string {
  const year = new Date(ms).getUTCFullYear()
  const dstStarts = lastSundayUtcMs(year, 2) // March
  const dstEnds = lastSundayUtcMs(year, 9) // October
  return ms >= dstStarts && ms < dstEnds ? '7200s' : '3600s'
}

// The Amsterdam local-midnight instant that opens civil date `dateStr` (YYYY-MM-DD), in UTC
// milliseconds - exported for scripts/seed-demo.mjs to anchor a span's exclusive end on. An
// anchor at UTC midnight instead lets the last day this file generates, which is one UTC-day
// chunk wide, straddle a local-day boundary: the couple of hours (one outside CEST) on the far
// side of that boundary land in a new local day that nothing generated after endMs ever fills
// back in, so it reads as the demo's own final day and reads nearly empty. Anchoring here instead
// means the last chunk's own local day is the one that closes exactly on endMs, so there is
// nothing left on the far side of it to spill into.
export function localMidnightMs(dateStr: string): number {
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`)
  const offsetSeconds = Number(amsterdamOffset(utcMidnight).slice(0, -1))
  return utcMidnight - offsetSeconds * 1000
}

// Rises from nothing at 6am to a midday peak and back to nothing by 10pm. Reused for the heart
// rate curve below so the two stay visibly related without either being derived from the other.
const stepCurve = (hour: number): number => Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI))

// A curated slice of the API's 182 real exercise types (packages/core/src/api/enums.ts,
// drift-checked against the live discovery document), not a private list of this file's own -
// that private list is what let `CYCLING`, a value the API has never sent, sit here unnoticed
// under a name that shadowed the checked constant. Every value below also has a real translation
// in apps/web's SEEDED_EXERCISE_TYPES, so a session this generator writes always has something to
// call itself on the Dutch screenshots the next unit takes rather than falling back to raw
// English. Checked against EXERCISE_TYPES rather than copied outright: a value the API retires
// should stop a seed with a thrown error instead of quietly writing a string nothing can ever map.
//
// Checked inside `requireExerciseTypes` rather than at module scope, and that distinction is not
// style. This module is re-exported from the package root, which the server imports at boot - a
// module-scope check would turn a retired exercise type into an instance that will not start,
// which is demo-data drift stopping somebody's dashboard. `requireType` above is a function for
// the same reason; this used to be the one that was not.
const SEED_EXERCISE_TYPES = ['RUNNING', 'BIKING', 'WALKING', 'WEIGHTLIFTING', 'SWIMMING_POOL'] as const

// The order the workout days take their type in, round and round. A pick over the five types gave
// a run one workout in five, too few for the demo's workout page to find a usual range for a run
// (WORKOUT_BAND_MIN wants five earlier sessions of the type in 90 days), so nearly every figure on
// it read "not enough history". Four runs and two walks in every nine workouts give a run nine or
// more runs before it in any 90 days, a full ten-point strip, and a walk five or more; every type
// still shows up in any 27 days.
const WORKOUT_SCHEDULE: readonly (typeof SEED_EXERCISE_TYPES)[number][] = [
  'RUNNING', 'WALKING', 'RUNNING', 'BIKING', 'RUNNING', 'WALKING', 'RUNNING', 'WEIGHTLIFTING', 'SWIMMING_POOL',
]

function requireExerciseTypes(): readonly string[] {
  for (const type of SEED_EXERCISE_TYPES) {
    if (!EXERCISE_TYPES.includes(type)) {
      throw new Error(`seedArchive: '${type}' is no longer an exercise type this catalogue knows about`)
    }
  }
  return SEED_EXERCISE_TYPES
}

const MOOD_LABELS = ['CALM', 'CONTENT', 'ENERGETIC', 'TIRED', 'STRESSED', 'HAPPY', 'ANXIOUS'] as const

// One night's sleep stage timeline, tiled to fill the interval exactly. The pattern is a
// plausible cycle, not a measured one - jittered per night so no two look identical, then
// renormalised so the shares still sum to the whole night regardless of the jitter.
const STAGE_PATTERN: ReadonlyArray<{ stage: string, share: number }> = [
  { stage: 'LIGHT', share: 0.22 },
  { stage: 'DEEP', share: 0.18 },
  { stage: 'LIGHT', share: 0.12 },
  { stage: 'REM', share: 0.28 },
  { stage: 'AWAKE', share: 0.05 },
  { stage: 'LIGHT', share: 0.15 },
]

function stagesFor(rand: () => number, startMs: number, endMs: number, restless: boolean): SleepStage[] {
  const shares = STAGE_PATTERN.map((s) => {
    // A restless night widens only the AWAKE slice's own jitter, so a bad night reads as more
    // time lying awake inside the usual shape rather than a different pattern altogether. Every
    // stage still draws exactly one range() call regardless, so this never changes how many
    // draws a night costs - only what the draw for AWAKE is allowed to reach.
    const jitterMax = restless && s.stage === 'AWAKE' ? 3.2 : 1.2
    return s.share * range(rand, 0.8, jitterMax)
  })
  const total = shares.reduce((a, b) => a + b, 0)
  const stages: SleepStage[] = []
  let cursor = startMs
  shares.forEach((share, i) => {
    // The last segment closes on endMs exactly rather than on an accumulated fraction, so
    // floating point drift across five additions never leaves a sliver of the night uncovered.
    const segEnd = i === shares.length - 1 ? endMs : cursor + (endMs - startMs) * (share / total)
    stages.push({
      type: STAGE_PATTERN[i]!.stage,
      startTime: new Date(cursor).toISOString(),
      endTime: new Date(segEnd).toISOString(),
    })
    cursor = segEnd
  })
  return stages
}

// exercise has no valuePath of its own - target: 'sessions', same as sleep - so it needs its own
// small builder rather than intervalPoint, which nests a numeric leaf that exercise does not
// carry. Shaped the same way sleepPoint shapes a night: name, dataSource, interval.
function exercisePoint(o: {
  name: string, startTime: string, endTime: string, utcOffset?: string, exerciseType: string,
  route?: ReadonlyArray<Record<string, unknown>>,
  /** The provider's own fields beside the interval (metricsSummary, splits, events...). */
  detail?: Readonly<Record<string, unknown>>,
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '0s'
  // A route rides on a companion dataSource, never a Fitbit one. The Google Health API has no
  // route field to send at all (mapSessions.ts's own comment on `route`, and task-3-report.md's
  // reading of the real Health Connect client), so a point carrying one has to wear the same
  // dataSource shape a phone sync actually sends (SyncEngine.kt's dataSourceOf) - platform
  // HEALTH_CONNECT, an application package, no recordingMethod claimed the real sync does not
  // send either. Anything else would show a demo workout doing something no real provider can.
  const dataSource = o.route
    ? { platform: 'HEALTH_CONNECT', application: { packageName: 'com.haelan.android' }, device: { displayName: 'Phone' } }
    : { platform: 'FITBIT', recordingMethod: 'DERIVED' }
  return {
    name: o.name,
    dataSource,
    exercise: {
      interval: { startTime: o.startTime, startUtcOffset: offset, endTime: o.endTime, endUtcOffset: offset },
      exerciseType: o.exerciseType,
      ...o.detail,
      ...(o.route ? { route: o.route } : {}),
    },
  }
}

// Seeds the workout page's own stream (see workoutRand in seedArchive), for the same reason as
// NIGHT_STREAM below: the workouts' figures, their minute-by-minute heart rate and the day's zone
// ceilings are added without moving a single draw on `rand`.
const WORKOUT_STREAM = 0x776f726b
// Seeds the stream the minutes after each workout draw from (see recoveryFor), so adding them
// moved no draw on the workout stream either, and no figure a workout already had.
const RECOVERY_STREAM = 0x72656376
// The minutes of heart rate written after each workout's end, for the page's heart-rate recovery.
const RECOVERY_MINUTES = 3

/**
 * Heart rate for the minutes after a workout: one reading a minute from the minute after the end's
 * own minute (the one the workout's trace ends on), falling from the workout's last reading
 * towards resting. How quickly it falls is drawn per workout, so the recovery figures have a usual
 * with some spread to judge against. Always three draws plus one, kept or not, so the stream never
 * depends on which workouts a cutoff keeps.
 */
function recoveryFor(rr: () => number, o: { endMs: number, lastBpm: number, restingBpm: number }): Array<{ atMs: number, bpm: number }> {
  const endMinuteMs = Math.floor(o.endMs / 60_000) * 60_000
  const rate = range(rr, 0.18, 0.38)
  return Array.from({ length: RECOVERY_MINUTES }, (_, k) => {
    const bpm = o.restingBpm + (o.lastBpm - o.restingBpm) * Math.exp(-rate * (k + 1)) + range(rr, -1.5, 1.5)
    return { atMs: endMinuteMs + (k + 1) * 60_000, bpm: Math.round(bpm) }
  })
}

// How many runs carry a route, when the caller asked for routes at all: the last run and the most
// recent earlier ones of nearly its length (ROUTED_RUN_LENGTH_TOLERANCE), so the last run's page
// finds them as the same route and draws "Deze route". Bounded
// by the demo capture's size ceiling (scripts/capture-demo.mjs's MAX_CAPTURE_BYTES): a route costs
// the capture some 30 KB for each routed run whose page the demo mounts, measured 2026-09-29.
const ROUTED_RUNS = 3
// How close in length an earlier run must be to the last to share its loop. Two circles through one
// start put their quarter points Δr·√2 apart, so at 5 % of a 10 km loop that is some 110 m, inside
// routeMatch.ts's 150 m, where its own 10 % tolerance would put them some 220 m apart.
const ROUTED_RUN_LENGTH_TOLERANCE = 0.05
// A GPS fix every ten seconds of moving time: dense enough that the kilometre marks and the
// height profile read smoothly, coarse enough to stay inside that ceiling.
const ROUTE_STEP_SECONDS = 10
const METERS_PER_DEGREE = 111_320

// The provider's four zone ceilings for a day, and where this file counts light as beginning: the
// provider sends no floor for light (catalogue.ts's daily-heart-rate-zones comment), but a minute
// at a standing heart rate is in no zone, so something has to draw that line. Karvonen fractions
// of the heart rate reserve, so the ceilings move a little with the day's own resting figure.
interface ZoneCeilings { lightFloor: number, light: number, moderate: number, vigorous: number, peak: number }

function zoneCeilingsFor(restingBpm: number, maxBpm: number): ZoneCeilings {
  const at = (share: number): number => Math.round(restingBpm + share * (maxBpm - restingBpm))
  return { lightFloor: at(0.3), light: at(0.5), moderate: at(0.7), vigorous: at(0.85), peak: Math.round(maxBpm) }
}

// daily-heart-rate-zones carries its four zones as an array inside one point (catalogue.ts's
// subDimension), each bound an int64 sent as a string, so it is its own builder rather than a
// dailyPoint. Each zone's floor is the zone below's ceiling, the way the provider sends them.
function heartRateZonesPoint(o: { date: { year: number, month: number, day: number }, ceilings: ZoneCeilings }): Record<string, unknown> {
  const { lightFloor, light, moderate, vigorous, peak } = o.ceilings
  const zone = (heartRateZoneType: string, min: number, max: number) =>
    ({ heartRateZoneType, minBeatsPerMinute: String(min), maxBeatsPerMinute: String(max) })
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    dailyHeartRateZones: {
      date: o.date,
      heartRateZones: [
        zone('LIGHT', lightFloor, light), zone('MODERATE', light, moderate),
        zone('VIGOROUS', moderate, vigorous), zone('PEAK', vigorous, peak),
      ],
    },
  }
}

// Per type: how hard it works the heart, as a share of the heart rate reserve, and how much energy
// a minute of it burns. Invented bands that keep a walk below a ride below a run, nothing more.
const WORKOUT_PROFILES: Readonly<Record<string, { effort: [number, number], kcalPerMinute: [number, number] }>> = {
  RUNNING: { effort: [0.6, 0.78], kcalPerMinute: [10.5, 13] },
  BIKING: { effort: [0.55, 0.72], kcalPerMinute: [8, 10.5] },
  WALKING: { effort: [0.3, 0.45], kcalPerMinute: [4.5, 6] },
  SWIMMING_POOL: { effort: [0.55, 0.7], kcalPerMinute: [8, 10] },
  WEIGHTLIFTING: { effort: [0.35, 0.5], kcalPerMinute: [5, 7] },
}

const POOL_LENGTH_MILLIMETERS = 25_000
const FINISH_MARGIN_MS = 2 * 60_000

interface WorkoutReading {
  /** The exercise payload's own fields beside interval and exerciseType. */
  detail: Record<string, unknown>
  /** One reading a minute through the workout, the start's own minute left to the hourly curve. */
  heartRate: Array<{ atMs: number, bpm: number }>
  /** Moving seconds against metres covered, one entry per split boundary, for a route to follow. */
  progress: Array<{ activeSeconds: number, meters: number }>
  pause: { startMs: number, ms: number } | null
  activeSeconds: number
  elevationMeters: number
}

/**
 * Everything the provider says about one workout, shaped after probe/findings/field-map.md's
 * exercise payload and agreeing with itself the way a real one does: distance is moving time over
 * pace, the splits add up to both, the zone durations are counted off the same minute-by-minute
 * heart rate this file writes for the workout, and the average is that heart rate's own mean.
 *
 * `startBpm` is the hourly day curve's reading at the workout's first minute, which this workout
 * does not rewrite (it is drawn from `rand`); the trace warms up from it rather than jumping away.
 */
function workoutReadingFor(wr: () => number, o: {
  exerciseType: string, startMs: number, endMs: number, offset: string, startBpm: number,
  restingBpm: number, maxBpm: number, ceilings: ZoneCeilings, runIndex: number, vo2Base: number,
}): WorkoutReading {
  const profile = WORKOUT_PROFILES[o.exerciseType]!
  const elapsedMs = o.endMs - o.startMs
  const isRun = o.exerciseType === 'RUNNING'
  const onFoot = isRun || o.exerciseType === 'WALKING'

  // A run now and then stops mid-way (a crossing, a shoelace) for one to three minutes, never
  // near the end, where the finish sequence's own PAUSE already sits.
  const pause = isRun && wr() < 0.3 ? (() => {
    const ms = range(wr, 60, 180) * 1000
    // Clamped as well as drawn early, so the resume is always clear of the finish window.
    const startMs = Math.min(o.startMs + range(wr, 0.3, 0.65) * elapsedMs, o.endMs - FINISH_MARGIN_MS - ms - 60_000)
    return { startMs, ms }
  })() : null
  const activeSeconds = Math.floor((elapsedMs - (pause?.ms ?? 0)) / 1000)
  const inPause = (atMs: number): boolean => pause !== null && atMs >= pause.startMs && atMs < pause.startMs + pause.ms
  // Moving time to wall clock: past the pause, the clock ran on while the workout did not.
  const wallOf = (active: number): number => {
    const atMs = o.startMs + active * 1000
    return pause !== null && atMs > pause.startMs ? atMs + pause.ms : atMs
  }

  // Heart rate warms up from the hourly reading over five minutes towards the workout's effort,
  // drifts up a little as it goes, sags through a pause, and swings with a lift's sets.
  const reserve = o.maxBpm - o.restingBpm
  const target = o.restingBpm + range(wr, ...profile.effort) * reserve
  const heartRate: WorkoutReading['heartRate'] = []
  const minutes = Math.ceil(elapsedMs / 60_000)
  for (let m = 1; m < minutes; m++) {
    const atMs = o.startMs + m * 60_000
    const warm = Math.min(1, m / 5)
    const drift = 0.05 * reserve * (m / minutes)
    const sag = inPause(atMs) ? range(wr, 14, 22) : 0
    const sets = o.exerciseType === 'WEIGHTLIFTING' ? 9 * Math.sin(m * 1.3) : 0
    const bpm = o.startBpm + (target - o.startBpm) * warm + drift - sag + sets + range(wr, -3, 3)
    heartRate.push({ atMs, bpm: Math.round(Math.min(o.maxBpm, bpm)) })
  }
  // The minutes a watch counts: the first one at the hourly reading, and none while paused.
  const counted = [o.startBpm, ...heartRate.filter((r) => !inPause(r.atMs)).map((r) => r.bpm)]
  const averageBpm = Math.round(counted.reduce((sum, bpm) => sum + bpm, 0) / counted.length)
  const caloriesKcal = Math.round(range(wr, ...profile.kcalPerMinute) * elapsedMs / 60_000)

  const events = [
    { at: o.startMs, type: 'START' },
    ...(pause ? [{ at: pause.startMs, type: 'PAUSE' }, { at: pause.startMs + pause.ms, type: 'START' }] : []),
    // The finish sequence a real watch writes: PAUSE and STOP at the same instant.
    { at: o.endMs, type: 'PAUSE' }, { at: o.endMs, type: 'STOP' },
  ].map((e) => ({ eventTime: new Date(e.at).toISOString(), eventUtcOffset: o.offset, exerciseEventType: e.type }))
  const common = {
    activeDuration: `${activeSeconds}s`,
    exerciseEvents: events,
  }

  // A lift is calories and heart rate and nothing else, which is all a wrist can say about one.
  if (o.exerciseType === 'WEIGHTLIFTING') {
    return {
      detail: {
        ...common,
        exerciseMetadata: { hasGps: false },
        metricsSummary: { caloriesKcal, averageHeartRateBeatsPerMinute: String(averageBpm) },
      },
      heartRate, progress: [], pause, activeSeconds, elevationMeters: 0,
    }
  }

  // Zone durations off the same minutes, scaled so they never add up to more than the moving time.
  const zoneCounts = { lightTime: 0, moderateTime: 0, vigorousTime: 0, peakTime: 0 }
  for (const bpm of counted) {
    const c = o.ceilings
    if (bpm >= c.vigorous) zoneCounts.peakTime++
    else if (bpm >= c.moderate) zoneCounts.vigorousTime++
    else if (bpm >= c.light) zoneCounts.moderateTime++
    else if (bpm >= c.lightFloor) zoneCounts.lightTime++
  }
  const secondsPerCount = activeSeconds / counted.length
  const zoneSeconds = Object.fromEntries(Object.entries(zoneCounts).map(([k, n]) => [k, Math.floor(n * secondsPerCount)]))
  const heartRateZoneDurations = Object.fromEntries(Object.entries(zoneSeconds).map(([k, s]) => [k, `${s}s`]))
  const activeZoneMinutes = Math.round((zoneSeconds.moderateTime! + 2 * (zoneSeconds.vigorousTime! + zoneSeconds.peakTime!)) / 60)
  const zoneFigures = {
    caloriesKcal, averageHeartRateBeatsPerMinute: String(averageBpm),
    activeZoneMinutes: String(activeZoneMinutes), heartRateZoneDurations,
  }

  if (o.exerciseType === 'SWIMMING_POOL') {
    const lengths = Math.floor(activeSeconds / range(wr, 36, 48))
    return {
      detail: {
        ...common,
        exerciseMetadata: { hasGps: false, poolLengthMillimeters: POOL_LENGTH_MILLIMETERS },
        metricsSummary: { ...zoneFigures, distanceMillimeters: lengths * POOL_LENGTH_MILLIMETERS, totalSwimLengths: lengths },
      },
      heartRate, progress: [], pause, activeSeconds, elevationMeters: 0,
    }
  }

  // Runs get a little quicker over the span; a ride's pace is its speed turned over.
  const paceSecondsPerKm = isRun ? range(wr, 305, 360) - Math.min(20, o.runIndex * 0.25)
    : onFoot ? range(wr, 600, 720)
      : 3600 / range(wr, 22, 28)
  const distanceMillimeters = Math.round((activeSeconds / paceSecondsPerKm) * 1_000_000)
  const elevationMeters = onFoot ? range(wr, 12, 80) : range(wr, 80, 320)
  const metricsSummary: Record<string, unknown> = {
    ...zoneFigures,
    distanceMillimeters,
    averagePaceSecondsPerMeter: Number((activeSeconds / (distanceMillimeters / 1000)).toFixed(4)),
    averageSpeedMillimetersPerSecond: Number((distanceMillimeters / activeSeconds).toFixed(1)),
    elevationGainMillimeters: Math.round(elevationMeters * 1000),
  }
  const detail: Record<string, unknown> = { ...common, exerciseMetadata: { hasGps: true }, metricsSummary }
  if (!onFoot) {
    return { detail, heartRate, progress: [], pause, activeSeconds, elevationMeters }
  }

  const steps = Math.round((isRun ? range(wr, 160, 176) : range(wr, 106, 120)) * activeSeconds / 60)
  metricsSummary.steps = String(steps)

  // Automatic kilometre splits and the short one a workout ends on. Each kilometre's pace wobbles
  // a couple of percent around a trend across the run, negative (the second half faster) more
  // often than not, then the lot is scaled so the splits add up to the moving time exactly.
  const lengths: number[] = []
  for (let left = distanceMillimeters; left > 0; left -= 1_000_000) lengths.push(Math.min(1_000_000, left))
  const trend = range(wr, -0.06, 0.03)
  const middle = (lengths.length - 1) / 2
  const weights = lengths.map((mm, k) =>
    mm * (1 + trend * (lengths.length > 1 ? (k - middle) / (lengths.length - 1) : 0) + range(wr, -0.025, 0.025)))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const durations = weights.map((w) => Math.round(activeSeconds * (w / weightSum)))
  durations[durations.length - 1] = activeSeconds - durations.slice(0, -1).reduce((a, b) => a + b, 0)
  const progress: WorkoutReading['progress'] = [{ activeSeconds: 0, meters: 0 }]
  detail.splits = lengths.map((mm, k) => {
    const from = progress.at(-1)!
    const to = { activeSeconds: from.activeSeconds + durations[k]!, meters: from.meters + mm / 1000 }
    progress.push(to)
    const endMs = k === lengths.length - 1 ? o.endMs : wallOf(to.activeSeconds)
    return {
      startTime: new Date(wallOf(from.activeSeconds)).toISOString(), startUtcOffset: o.offset,
      endTime: new Date(endMs).toISOString(), endUtcOffset: o.offset,
      splitType: 'DISTANCE',
      activeDuration: `${durations[k]}s`,
      metricsSummary: { distanceMillimeters: mm, averagePaceSecondsPerMeter: Number((durations[k]! / (mm / 1000)).toFixed(4)) },
    }
  })

  if (isRun) {
    const cadence = steps / (activeSeconds / 60)
    const strideMillimeters = Math.round(distanceMillimeters / steps)
    const oscillationMillimeters = Math.round(range(wr, 78, 96))
    metricsSummary.mobilityMetrics = {
      avgCadenceStepsPerMinute: Number(cadence.toFixed(1)),
      avgStrideLengthMillimeters: String(strideMillimeters),
      avgGroundContactTimeDuration: `${range(wr, 0.225, 0.265).toFixed(3)}s`,
      avgVerticalOscillationMillimeters: String(oscillationMillimeters),
      avgVerticalRatio: Number(((oscillationMillimeters / strideMillimeters) * 100).toFixed(1)),
    }
    // Rising slowly across the span, the way a regular runner's estimate does.
    metricsSummary.runVo2Max = Number((o.vo2Base + o.runIndex * 0.05 + range(wr, -0.4, 0.4)).toFixed(1))
  }
  return { detail, heartRate, progress, pause, activeSeconds, elevationMeters }
}

// A demo route, opted into only by scripts/seed-demo.mjs via SeedArchiveInput's `demoRoute` below -
// never by default, which is what packages/core/test/seed.test.ts's "seeds no workout route" pins.
// A perfect circle as long as the run, not a captured trace: real GPS never closes on itself to the
// metre, so this shape could not be mistaken for a run anyone actually took. Every circle starts and
// ends at latitude zero, longitude zero and runs the same way round, its centre west of there by its
// own radius - open ocean off the coast of west Africa, nowhere near this household's Amsterdam
// offset and not a neighbourhood a stranger could place. One start for every routed run, so runs of
// nearly one length are the same route to routeMatch.ts. Built from the run's own splits
// and trigonometry, with no draw from any stream, so a fix sits where the splits say the runner
// was: the page's kilometre marks land on the split boundaries. One hill, as high as the run's
// elevation gain, so the height profile and the figure agree.
function syntheticRoute(o: {
  startMs: number, pause: WorkoutReading['pause'], activeSeconds: number,
  progress: WorkoutReading['progress'], elevationMeters: number,
}): Array<Record<string, unknown>> {
  const total = o.progress.at(-1)!.meters
  const radiusDegrees = total / (2 * Math.PI) / METERS_PER_DEGREE
  const metersAt = (active: number): number => {
    const k = o.progress.findIndex((p) => p.activeSeconds >= active)
    if (k <= 0) return 0
    const a = o.progress[k - 1]!
    const b = o.progress[k]!
    return a.meters + (b.meters - a.meters) * ((active - a.activeSeconds) / (b.activeSeconds - a.activeSeconds))
  }
  const route: Array<Record<string, unknown>> = []
  for (let active = 0; ; active = Math.min(o.activeSeconds, active + ROUTE_STEP_SECONDS)) {
    const angle = (2 * Math.PI * metersAt(active)) / total
    const atMs = o.startMs + active * 1000
    route.push({
      time: new Date(o.pause !== null && atMs > o.pause.startMs ? atMs + o.pause.ms : atMs).toISOString(),
      latitude: Number((radiusDegrees * Math.sin(angle)).toFixed(6)),
      longitude: Number((radiusDegrees * Math.cos(angle) - radiusDegrees).toFixed(6)),
      altitudeMetres: Number((2 + o.elevationMeters * Math.sin(angle / 2) ** 2).toFixed(1)),
    })
    if (active === o.activeSeconds) return route
  }
}

// moods carries an array leaf (moods[]), which samplePoint's value: string | number cannot hold,
// so this is its own tiny builder rather than a reuse of samplePoint. A real entry is logged by
// hand on a phone, not read off a wearable, hence the manual recording method.
function moodPoint(o: { atMs: number, utcOffset?: string, moods: string[] }): Record<string, unknown> {
  return {
    dataSource: { platform: 'IOS', recordingMethod: 'MANUAL_ENTRY' },
    moods: {
      sampleTime: { physicalTime: new Date(o.atMs).toISOString(), utcOffset: o.utcOffset ?? '0s' },
      moods: o.moods,
    },
  }
}

// active-minutes carries its dimension as an array inside one point -
// activeMinutesByActivityLevel[], one element per level - rather than one point per level the way
// active-zone-minutes below does, so this builder takes the whole day's levels at once instead of
// being called once per level.
function activeMinutesPoint(o: {
  startTime: string, endTime: string, utcOffset?: string, minutesByLevel: Readonly<Record<string, number>>,
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '0s'
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    activeMinutes: {
      interval: { startTime: o.startTime, startUtcOffset: offset, endTime: o.endTime, endUtcOffset: offset },
      activeMinutesByActivityLevel: Object.entries(o.minutesByLevel).map(([activityLevel, minutes]) => ({
        activityLevel, activeMinutes: String(minutes),
      })),
    },
  }
}

// active-zone-minutes carries no array - the field map found no interval with more than one zone
// in it - so one point holds exactly one zone, and a day with three zones' worth of minutes is
// three separate points, called once per zone below rather than once per day.
function activeZoneMinutesPoint(o: {
  startTime: string, endTime: string, utcOffset?: string, zone: string, minutes: number,
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '0s'
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    activeZoneMinutes: {
      interval: { startTime: o.startTime, startUtcOffset: offset, endTime: o.endTime, endUtcOffset: offset },
      heartRateZone: o.zone,
      activeZoneMinutes: String(o.minutes),
    },
  }
}

// Seeds the night page's own stream (see nightRand in seedArchive). Any fixed nonzero value would
// do; XORed into the caller's seed, a different seed still gets a different night stream.
const NIGHT_STREAM = 0x6e696768

const FIVE_MINUTES_MS = 300_000

interface NightReading { atMs: number, heartRate: number, hrv: number, spo2: number }

// Every five minutes from bedtime to waking: heart rate a few beats under the day's resting figure,
// the band the hourly overnight samples already use, HRV swinging around the person's own baseline
// inside 30 to 70 ms, SpO2 between 93 and 98 %.
function nightReadingsFor(rand: () => number, night: { startMs: number, endMs: number }, restingHrBpm: number, hrvBaselineMs: number): NightReading[] {
  const readings: NightReading[] = []
  const first = Math.ceil(night.startMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
  for (let atMs = first; atMs < night.endMs; atMs += FIVE_MINUTES_MS) {
    const heartRate = Math.round(range(rand, restingHrBpm - 6, restingHrBpm - 1))
    const hrv = Number(Math.min(70, Math.max(30, hrvBaselineMs + range(rand, -15, 15))).toFixed(1))
    const spo2 = Number(range(rand, 93, 98).toFixed(1))
    readings.push({ atMs, heartRate, hrv, spo2 })
  }
  return readings
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const civilDateStr = (d: { year: number, month: number, day: number }): string =>
  `${d.year}-${pad2(d.month)}-${pad2(d.day)}`

export interface SeedArchiveInput {
  archive: RawArchive
  personId: string
  days: number
  /** Exclusive, like dayWindows' own toMs: the last generated day ends here, never on it. */
  endMs: number
  seed?: number
  /**
   * Task 8, opt-in and false by default: gives the last run in the span, and up to ROUTED_RUNS - 1
   * recent earlier runs of nearly its length, a syntheticRoute (above), each on a companion copy
   * of the run. Off by default so every other
   * caller of this generator - including packages/core/test/seed.test.ts's own "seeds no workout
   * route" - keeps proving what Task 7 proved, that a real route cannot reach the demo through the
   * ordinary capture path.
   * scripts/seed-demo.mjs is the one caller that turns this on, because the demo is the one place
   * a fabricated route belongs on purpose.
   */
  demoRoute?: boolean
  /**
   * Opt-in, and unset by default: every day is generated whole. When set, the final day stops
   * here, the way a real archive's today stops at the moment it was last synced. Every reading on
   * that day that has not finished by this instant is left out: a sample at or after it, and an
   * interval or session ending after it. An hourly interval that straddles it is dropped rather
   * than truncated, because nothing here models a partial hour.
   *
   * The exceptions are the day's whole-day totals, which the day has not reached by this instant
   * but which dropping would take away entirely. Each is scaled by the share of the day that has
   * passed, `Math.round(wholeDay * share)`:
   * - active-minutes and active-zone-minutes, one interval each for the whole day, are also cut to
   *   end here. Only their ambient minutes (LIGHT, FAT_BURN) are scaled; a workout's minutes
   *   (MODERATE, VIGOROUS, CARDIO, PEAK) are kept whole if the workout itself finished before
   *   this instant, and are zero if it did not.
   * - total-calories and floors, the daily rollups. Their window stays the whole civil day, because
   *   that is the only window dailyRollUp answers with: a real rollup fetched mid-day carries the
   *   running total under a whole-day window. So for these two, the amount is the only thing cut.
   *
   * The same rule covers the day's other timed readings: weight's 07:00 sample, the night that
   * ends that morning, a workout, the 20:00 mood. A payload whose every point was cut is still
   * written, empty, the way a sync of an hour with nothing in it would be.
   *
   * Resting heart rate, HRV, respiratory rate, the morning's SpO2 and the night's temperature are
   * left as they are. Each is a once-a-day figure read off the night before, so by midday it already
   * exists in full.
   *
   * Filters and scales only: every value is still drawn from the PRNG exactly as it would be
   * without this option, so no other day in the span changes.
   *
   * scripts/seed-demo.mjs is the one caller, passing the demo's pinned clock (DEMO_CLOCK_MS in
   * apps/web/src/demo/instant.ts) so the captured Dashboard never shows data from its own future.
   * It must fall inside the final day, after that day's start and no later than `endMs`.
   */
  lastDayUntilMs?: number
}

export interface SeedArchiveResult { payloads: number }

export function seedArchive(input: SeedArchiveInput): SeedArchiveResult {
  const exerciseTypes = requireExerciseTypes()
  const STEPS = requireType('steps')
  const HEART_RATE = requireType('heart-rate')
  const WEIGHT = requireType('weight')
  const SLEEP = requireType('sleep')
  const EXERCISE = requireType('exercise')
  const MOODS = requireType('moods')
  const DAILY_RESTING_HR = requireType('daily-resting-heart-rate')
  const DAILY_HRV = requireType('daily-heart-rate-variability')
  const DAILY_RESPIRATORY_RATE = requireType('daily-respiratory-rate')
  const DISTANCE = requireType('distance')
  const ACTIVE_ENERGY_BURNED = requireType('active-energy-burned')
  const ACTIVE_MINUTES = requireType('active-minutes')
  const ACTIVE_ZONE_MINUTES = requireType('active-zone-minutes')
  const TOTAL_CALORIES = requireType('total-calories')
  const FLOORS = requireType('floors')
  const HRV = requireType('heart-rate-variability')
  const SPO2 = requireType('oxygen-saturation')
  const DAILY_SPO2 = requireType('daily-oxygen-saturation')
  const SLEEP_TEMPERATURE = requireType('daily-sleep-temperature-derivations')
  const SLEEP_BREATHING = requireType('respiratory-rate-sleep-summary')
  const HEART_RATE_ZONES = requireType('daily-heart-rate-zones')

  const rand = mulberry32(input.seed ?? DEFAULT_SEED)
  // The night page's readings (the provider's sleep summary, the night's five-minute heart rate,
  // HRV and SpO2, its temperature and breathing rate) draw from a second stream of their own. On
  // `rand` they would shift every draw after the first night, and with it every figure the rest of
  // this file's tests and the demo's screenshots are pinned against; on their own stream they add
  // readings without moving one that was already there. Still one fixed seed, so still the same
  // bytes on every run.
  const nightRand = mulberry32((input.seed ?? DEFAULT_SEED) ^ NIGHT_STREAM)
  // The workout page's readings (every figure the provider files on a workout, its heart rate a
  // minute at a time, the day's zone ceilings) draw from a third stream, for the same reason.
  const workoutRand = mulberry32((input.seed ?? DEFAULT_SEED) ^ WORKOUT_STREAM)
  const recoveryRand = mulberry32((input.seed ?? DEFAULT_SEED) ^ RECOVERY_STREAM)
  // One person, so one heart rate ceiling and one fitness level for the whole span.
  const maxBpm = range(workoutRand, 182, 194)
  const vo2Base = range(workoutRand, 42, 46)
  let payloads = 0

  const until = input.lastDayUntilMs
  if (until !== undefined && !(until > input.endMs - DAY_MS && until <= input.endMs)) {
    throw new Error(`lastDayUntilMs must fall inside the final day (${input.endMs - DAY_MS}, ${input.endMs}], got ${until}`)
  }

  const put = (t: DataType, windowStartMs: number, windowEndMs: number, points: unknown[]): void => {
    input.archive.put({
      personId: input.personId,
      dataType: t.id,
      requestParams: listRequestParams(t, windowStartMs, windowEndMs),
      // One list call per day here, so one episode per call - the same relationship a real
      // client.ts fetch has between fetchEpisodeId and a single, unpaginated page.
      fetchEpisodeId: randomUUID(),
      windowStartMs,
      windowEndMs,
      // Fetched the moment the day closes, which is what a daily sync would do and keeps
      // RawArchive.listFor's fetch-time order matching calendar order across the whole span.
      fetchedAtMs: windowEndMs,
      httpStatus: 200,
      body: body(points),
    })
    payloads++
  }

  // See this file's own header comment on why floors and total-calories cannot go through `put`
  // above. `windows` is every day this call is responsible for, in calendar order; chunked here
  // into spans no wider than the type's own cap, one archive row per chunk, the same shape
  // runRollupJob's own backward walk produces for a real sync - a caller of this function needs to
  // pass only the day-by-day figures, not know the cap exists.
  const putRollups = (t: DataType, windows: readonly RollupWindow[]): void => {
    const capDays = rollupRangeCapDays(t)
    for (let i = 0; i < windows.length; i += capDays) {
      const chunk = windows.slice(i, i + capDays)
      const fromDate = chunk[0]!.date
      // Exclusive, like every other window bound in this file: the day after the chunk's last day.
      const toDate = nextDay(chunk.at(-1)!.date)
      const windowStartMs = Date.parse(`${civilDateStr(fromDate)}T00:00:00Z`)
      const windowEndMs = Date.parse(`${civilDateStr(toDate)}T00:00:00Z`)
      input.archive.put({
        personId: input.personId,
        dataType: t.id,
        requestParams: { range: { start: { date: fromDate }, end: { date: toDate } } },
        fetchEpisodeId: randomUUID(),
        windowStartMs,
        windowEndMs,
        fetchedAtMs: windowEndMs,
        httpStatus: 200,
        body: dailyRollupBody(t.payloadKey, chunk),
      })
      payloads++
    }
  }

  // Every night's boundaries, computed before the day loop below writes anything: night i ends
  // on the morning of day i (the same convention mapSessions' localDateOfEnd reads back out),
  // and nothing else in this function needs to know a night's shape ahead of its own day.
  const nights = Array.from({ length: input.days }, (_, i) => {
    const dayStart = input.endMs - (input.days - i) * DAY_MS
    const wakeOffsetMs = range(rand, 6 * HOUR_MS, 8 * HOUR_MS)
    // Roughly one night in seven runs short and restless instead of the usual span - spec's "the
    // occasional short night". Decided once per night, here, so the shorter duration below and
    // stagesFor's wider AWAKE share (further down) both read the same event rather than two dice
    // that could disagree about which night was the bad one.
    const restless = rand() < 0.15
    const durationMs = restless
      ? range(rand, 4 * HOUR_MS, 5.5 * HOUR_MS)
      : range(rand, 6.5 * HOUR_MS, 8.5 * HOUR_MS) // tens of minutes of night-to-night variation
    const endMs = dayStart + wakeOffsetMs
    return { startMs: endMs - durationMs, endMs, restless }
  })

  // One slow trend for the whole span, decided once - "drifts" as opposed to a day-by-day walk
  // that could wander off in either direction and back.
  let weightGrams = range(rand, 62_000, 85_000)
  const weightTrendPerDay = range(rand, -25, 15)

  // Recovery's three figures, decided the same way weight's trend is: state fixed once before
  // the loop, not redrawn each morning, so the run reads like one body rather than three
  // independent dice. Resting heart rate gets a trend like weight's because a person's resting
  // rate does drift over a span this long; HRV and respiratory rate do not - HRV swings around a
  // fixed baseline day to day, and respiratory rate barely moves at all, so neither carries a
  // per-day increment forward.
  let restingHrBpm = range(rand, 54, 64)
  const restingHrTrendPerDay = range(rand, -0.06, 0.04)
  const hrvBaselineMs = range(rand, 45, 70)
  const respiratoryRateBpm = range(rand, 13.5, 15.5)

  // A night's temperature sits around one person's own baseline, the way a wrist's skin reading
  // does, and now and then runs warm for a few nights together (a cold coming on, a hot spell)
  // rather than one warm night appearing alone.
  const temperatureBaselineCelsius = range(nightRand, 33.6, 34.6)
  let warmNightsLeft = 0

  // floors and total-calories are collected here rather than put() one day at a time, because
  // putRollups above has to see a whole span at once to chunk it against the type's own cap.
  const floorsWindows: RollupWindow[] = []
  const totalCaloriesWindows: RollupWindow[] = []

  // Every kept run, in order, so the routes (if the caller asked for them) can go on the last few
  // once the loop has seen them all; runIndex is how far into the span a run is, which is what
  // its pace and VO2max improve with.
  let runIndex = 0
  const keptRuns: Array<{ name: string, startMs: number, endMs: number, offset: string, reading: WorkoutReading }> = []

  for (let i = 0; i < input.days; i++) {
    const dayStart = input.endMs - (input.days - i) * DAY_MS
    const dayEnd = dayStart + DAY_MS
    const isSunday = new Date(dayStart).getUTCDay() === 0
    // lastDayUntilMs's cut, on the final day only (see its own comment). Applied to arrays that
    // are already built, never around a draw, so the PRNG sequence stays exactly the same.
    const cutoff = i === input.days - 1 ? until : undefined
    const sampleDone = (atMs: number): boolean => cutoff === undefined || atMs < cutoff
    const intervalDone = (endMs: number): boolean => cutoff === undefined || endMs <= cutoff
    const hourlyDone = <T>(points: T[]): T[] => points.filter((_, h) => intervalDone(dayStart + (h + 1) * HOUR_MS))

    // A few times a week, on a fixed schedule rather than a coin flip: the type has to show up
    // in any span this generator is asked for, not merely on average across many seeds. Decided
    // before the step and heart-rate curves below, which is new: they need to know the workout's
    // hour to show it happening rather than run beside it unaware, the same way a real watch's
    // step count and pulse both move for the minutes someone is actually exercising.
    const workout = i % 3 === 1 ? (() => {
      const hour = pick(rand, [7, 12, 18])
      const startMs = dayStart + hour * HOUR_MS
      const endMs = startMs + range(rand, 25, 55) * 60_000
      // The old pick is still drawn, and thrown away, so every value after it in the day's stream
      // stays what it was; the type is WORKOUT_SCHEDULE's. `drawnRun` remembers the one later draw
      // that depended on the pick (peakMinutes below).
      const drawnRun = pick(rand, exerciseTypes) === 'RUNNING'
      const exerciseType = WORKOUT_SCHEDULE[((i - 1) / 3) % WORKOUT_SCHEDULE.length]!
      return { hour, startMs, endMs, exerciseType, drawnRun }
    })() : null

    // Moved ahead of the heart-rate curve below, which reads this same trend for its overnight
    // baseline: resting heart rate is by definition close to a night's lowest sustained reading,
    // so the two have to be computed from the same number rather than two independent draws that
    // could land anywhere relative to each other.
    restingHrBpm += restingHrTrendPerDay + range(rand, -0.6, 0.6)

    // Kept as its own array rather than folded straight into stepsPoints below, because distance
    // and active energy both read it back a few lines down - distance tracks the step curve
    // rather than being drawn independently, and the cleanest way to track it is to read the same
    // number steps itself just wrote, not to recompute a second curve shaped to agree with it.
    const stepsByHour = Array.from({ length: 24 }, (_, h) => {
      const intensity = stepCurve(h) * (isSunday ? 0.6 : 1) * range(rand, 0.85, 1.15)
      // The workout's own hour gets the steps its minutes actually took, laid on top of the
      // ambient curve, instead of a session the step chart shows no sign of at all.
      const workoutMinutes = workout && workout.hour === h ? (workout.endMs - workout.startMs) / 60_000 : 0
      const workoutSteps = workoutMinutes > 0 ? Math.round(workoutMinutes * range(rand, 120, 160)) : 0
      return Math.round(700 * intensity) + workoutSteps
    })
    const stepsPoints = stepsByHour.map((steps, h) => {
      const hourStart = dayStart + h * HOUR_MS
      return intervalPoint({
        payloadKey: STEPS.payloadKey, valuePath: STEPS.valuePath, value: steps,
        physicalTime: new Date(hourStart).toISOString(),
        endTime: new Date(hourStart + HOUR_MS).toISOString(),
        utcOffset: amsterdamOffset(hourStart),
      })
    })
    put(STEPS, dayStart, dayEnd, hourlyDone(stepsPoints))

    // Distance tracks the step curve - each hour's distance is that hour's own step count times a
    // jittered stride length - rather than being drawn from stepCurve a second, independent time,
    // which is what let an earlier draft show a "run" whose distance chart went flat.
    const distancePoints = stepsByHour.map((steps, h) => {
      const hourStart = dayStart + h * HOUR_MS
      const strideMillimeters = range(rand, 700, 820)
      return intervalPoint({
        payloadKey: DISTANCE.payloadKey, valuePath: DISTANCE.valuePath, value: Math.round(steps * strideMillimeters),
        physicalTime: new Date(hourStart).toISOString(),
        endTime: new Date(hourStart + HOUR_MS).toISOString(),
        utcOffset: amsterdamOffset(hourStart),
      })
    })
    put(DISTANCE, dayStart, dayEnd, hourlyDone(distancePoints))

    // A resting floor under the same activity curve steps and distance already follow: the
    // overnight hours still report a small burn, never zero, and the workout's own hour adds a
    // burst on top the way its hour already spikes the step and heart-rate curves.
    const activeEnergyPoints = Array.from({ length: 24 }, (_, h) => {
      const hourStart = dayStart + h * HOUR_MS
      const overnight = h < 6 || h >= 23
      const restingKcal = overnight ? range(rand, 8, 14) : range(rand, 14, 22)
      const activeKcal = stepCurve(h) * (isSunday ? 0.6 : 1) * range(rand, 20, 45)
      const workoutKcal = workout && workout.hour === h ? range(rand, 150, 350) : 0
      return intervalPoint({
        payloadKey: ACTIVE_ENERGY_BURNED.payloadKey, valuePath: ACTIVE_ENERGY_BURNED.valuePath,
        value: Math.round(restingKcal + activeKcal + workoutKcal),
        physicalTime: new Date(hourStart).toISOString(),
        endTime: new Date(hourStart + HOUR_MS).toISOString(),
        utcOffset: amsterdamOffset(hourStart),
      })
    })
    put(ACTIVE_ENERGY_BURNED, dayStart, dayEnd, hourlyDone(activeEnergyPoints))

    // The workout's first minute is the hourly reading below, which its own trace warms up from.
    let workoutStartBpm = 0
    const hrPoints = Array.from({ length: 24 }, (_, h) => {
      const atMs = dayStart + h * HOUR_MS
      const overnight = h < 6 || h >= 23
      const bpm = workout && workout.hour === h
        // A moving workout, not a stroll: a run or a lift raises the pulse well past the
        // ambient daytime peak, which is what makes "84 bpm on a 51-minute run" a contradiction
        // in the first place.
        // The workout's first minute, though, is before any of that: the reading sits most of the
        // way back towards resting, so the trace warms up from it instead of starting at its
        // highest. Scaled from the same draw, which keeps the day's stream as it was.
        ? restingHrBpm + (range(rand, 128, 168) - restingHrBpm) * 0.3
        : overnight
          // A few beats below the day's own resting figure rather than an unrelated absolute
          // band - see the comment above restingHrBpm's update for why the two must agree.
          ? range(rand, restingHrBpm - 6, restingHrBpm - 1)
          : 60 + stepCurve(h) * range(rand, 15, 25)
      if (workout && workout.hour === h) workoutStartBpm = Math.round(bpm)
      return samplePoint({
        payloadKey: HEART_RATE.payloadKey, valuePath: HEART_RATE.valuePath, value: String(Math.round(bpm)),
        physicalTime: new Date(atMs).toISOString(), utcOffset: amsterdamOffset(atMs),
      })
    })
    put(HEART_RATE, dayStart, dayEnd, hrPoints.filter((_, h) => sampleDone(dayStart + h * HOUR_MS)))

    weightGrams += weightTrendPerDay + range(rand, -80, 80)
    const weightPoints = [samplePoint({
      payloadKey: WEIGHT.payloadKey, valuePath: WEIGHT.valuePath, value: String(Math.round(weightGrams)),
      physicalTime: new Date(dayStart + 7 * HOUR_MS).toISOString(), utcOffset: amsterdamOffset(dayStart + 7 * HOUR_MS),
    })]
    put(WEIGHT, dayStart, dayEnd, sampleDone(dayStart + 7 * HOUR_MS) ? weightPoints : [])

    const civilDate = civilDateOf(dayStart)

    // A bad day nudges that one day's reading up without moving the underlying trend - the
    // point of "the odd bad day" is that it does not carry into tomorrow the way the drift does.
    // Distinct from a night's own restless flag above: this is a day resting heart rate reads
    // high (illness, stress, a hard effort the day before), not a short night specifically.
    const restingHrToday = restingHrBpm + (rand() < 0.12 ? range(rand, 4, 10) : 0)
    put(DAILY_RESTING_HR, dayStart, dayEnd, [dailyPoint({
      payloadKey: DAILY_RESTING_HR.payloadKey, valuePath: DAILY_RESTING_HR.valuePath,
      value: String(Math.round(restingHrToday)), date: civilDate,
    })])

    // The day's heart rate zone ceilings, filed once a day like resting heart rate, and read off the
    // same trend rather than drawn: a workout's zone bands and zone durations both use these.
    const ceilings = zoneCeilingsFor(restingHrBpm, maxBpm)
    put(HEART_RATE_ZONES, dayStart, dayEnd, [heartRateZonesPoint({ date: civilDate, ceilings })])

    const hrvToday = Math.max(15, hrvBaselineMs + range(rand, -18, 18))
    put(DAILY_HRV, dayStart, dayEnd, [dailyPoint({
      payloadKey: DAILY_HRV.payloadKey, valuePath: DAILY_HRV.valuePath,
      value: String(Math.round(hrvToday)), date: civilDate,
    })])

    const respiratoryRateToday = respiratoryRateBpm + range(rand, -0.4, 0.4)
    put(DAILY_RESPIRATORY_RATE, dayStart, dayEnd, [dailyPoint({
      payloadKey: DAILY_RESPIRATORY_RATE.payloadKey, valuePath: DAILY_RESPIRATORY_RATE.valuePath,
      value: respiratoryRateToday.toFixed(1), date: civilDate,
    })])

    // Active minutes and heart-rate-zone minutes both concentrate around the day's own workout
    // rather than accruing steadily through it: a light-activity floor from the day's ordinary
    // movement, and the moderate/vigorous minutes (and the cardio/peak zone minutes) landing
    // almost entirely inside the workout's own span. One point spanning the whole day, the same
    // civil-day grain the daily recovery figures above use, rather than an hourly walk like steps
    // - real per-interval granularity is a detail nothing here has measured, and a coarser body
    // still maps to the one figure a day the page actually charts.
    const workoutMinutesToday = workout ? (workout.endMs - workout.startMs) / 60_000 : 0
    const lightMinutes = Math.round(range(rand, 40, 90) * (isSunday ? 0.7 : 1))
    const moderateMinutes = workout ? Math.round(workoutMinutesToday * range(rand, 0.3, 0.5)) : 0
    const vigorousMinutes = workout ? Math.round(workoutMinutesToday * range(rand, 0.3, 0.5)) : 0
    // lastDayUntilMs's whole-day totals (see its comment): these two types are one interval for
    // the whole day, so dropping the straddler would drop the day's figure. Cut to end at the
    // cutoff instead, the ambient minutes scaled to the share of the day that has passed (soFar,
    // which the two rollups further down use too), and the workout's minutes
    // kept only if the workout itself finished before it.
    const minutesEndMs = cutoff ?? dayEnd
    const dayShare = (minutesEndMs - dayStart) / DAY_MS
    const workoutKept = workout !== null && intervalDone(workout.endMs)
    const soFar = (minutes: number): number => (cutoff === undefined ? minutes : Math.round(minutes * dayShare))
    const ifWorkoutKept = (minutes: number): number => (workoutKept ? minutes : 0)
    put(ACTIVE_MINUTES, dayStart, dayEnd, [activeMinutesPoint({
      startTime: new Date(dayStart).toISOString(), endTime: new Date(minutesEndMs).toISOString(),
      utcOffset: amsterdamOffset(dayStart),
      minutesByLevel: {
        LIGHT: soFar(lightMinutes), MODERATE: ifWorkoutKept(moderateMinutes), VIGOROUS: ifWorkoutKept(vigorousMinutes),
      },
    })])

    const fatBurnMinutes = Math.round(range(rand, 10, 30) * (isSunday ? 0.7 : 1))
    const cardioMinutes = workout ? Math.round(workoutMinutesToday * range(rand, 0.2, 0.4)) : 0
    // A running workout is the one type here that plausibly pushes a heart rate into the top
    // zone; the others (a lift, a swim, a walk) stay out of it, the same distinction the field map
    // found no more than one zone active in a single interval to begin with.
    // Its share is drawn from `rand` on exactly the days the old pick chose a run, so the first
    // stream is unchanged, and from the workout's own stream on any other day.
    const peakShare = workout === null ? 0 : range(workout.drawnRun ? rand : workoutRand, 0.05, 0.15)
    const peakMinutes = workout && workout.exerciseType === 'RUNNING' ? Math.round(workoutMinutesToday * peakShare) : 0
    const minutesByZone: Readonly<Record<string, number>> = {
      FAT_BURN: soFar(fatBurnMinutes), CARDIO: ifWorkoutKept(cardioMinutes), PEAK: ifWorkoutKept(peakMinutes),
    }
    put(ACTIVE_ZONE_MINUTES, dayStart, dayEnd, Object.entries(minutesByZone).map(([zone, minutes]) => (
      activeZoneMinutesPoint({
        startTime: new Date(dayStart).toISOString(), endTime: new Date(minutesEndMs).toISOString(),
        utcOffset: amsterdamOffset(dayStart), zone, minutes,
      })
    )))

    // Total calories carries the same resting-floor-plus-activity shape active energy burned does
    // above, but as one number for the whole day rather than an hourly curve - dailyRollUp answers
    // nothing finer than that. Floors is modest and lumpy: most days a handful, and roughly one day
    // in four a stair-climbing outlier on top, rather than a curve that only ever creeps.
    const restingCaloriesToday = range(rand, 1450, 1650)
    const activeCaloriesToday = range(rand, 200, 500) * (isSunday ? 0.7 : 1)
      + (workout ? range(rand, 200, 450) : 0)
    totalCaloriesWindows.push({
      date: civilDate, value: { kcalSum: soFar(Math.round(restingCaloriesToday + activeCaloriesToday)) },
    })
    const floorsToday = Math.round(range(rand, 0, 6) + (rand() < 0.25 ? range(rand, 6, 16) : 0))
    floorsWindows.push({ date: civilDate, value: { countSum: String(soFar(floorsToday)) } })

    const night = nights[i]!
    const sleepPoints = [sleepPoint({
      name: `users/me/dataTypes/sleep/dataPoints/seed-${i}`,
      startTime: new Date(night.startMs).toISOString(),
      endTime: new Date(night.endMs).toISOString(),
      utcOffset: amsterdamOffset(night.startMs),
      stages: stagesFor(rand, night.startMs, night.endMs, night.restless),
      summary: {
        minutesToFallAsleep: Math.round(range(nightRand, 5, 25)),
        minutesAfterWakeUp: Math.round(range(nightRand, 0, 10)),
        // A restless night wakes more often, inside the same 8 to 18.
        awakenings: Math.round(night.restless ? range(nightRand, 13, 18) : range(nightRand, 8, 14)),
      },
    })]
    put(SLEEP, dayStart, dayEnd, intervalDone(night.endMs) ? sleepPoints : [])

    // The night's own readings, fetched over the night's span rather than the day's: a night
    // straddles midnight, and the day windows above are already one list call each, so a second
    // call over the same day bounds would read, to the rebuild, as a re-fetch replacing the first.
    const nightDone = intervalDone(night.endMs)
    const nightSamples = nightReadingsFor(nightRand, night, restingHrBpm, hrvBaselineMs)
    const nightPut = (t: DataType, points: unknown[]): void => put(t, night.startMs, night.endMs, nightDone ? points : [])
    const nightSample = (t: DataType, atMs: number, value: string | number) => samplePoint({
      payloadKey: t.payloadKey, valuePath: t.valuePath, value,
      physicalTime: new Date(atMs).toISOString(), utcOffset: amsterdamOffset(atMs),
    })
    // The exact hours are left to the hourly day curve, which already has a heart-rate sample there,
    // so no minute ever holds two. So are a morning workout's minutes, when one starts before the
    // night's own end: the workout's readings (below) are the ones a moving body gives, and so are
    // the minutes after it, which recoveryFor writes.
    const duringWorkout = (atMs: number): boolean => workout !== null && atMs >= workout.startMs
      && atMs <= Math.floor(workout.endMs / 60_000) * 60_000 + RECOVERY_MINUTES * 60_000
    nightPut(HEART_RATE, nightSamples.filter((r) => r.atMs % HOUR_MS !== 0 && !duringWorkout(r.atMs))
      .map((r) => nightSample(HEART_RATE, r.atMs, String(r.heartRate))))
    nightPut(HRV, nightSamples.map((r) => nightSample(HRV, r.atMs, r.hrv)))
    nightPut(SPO2, nightSamples.map((r) => nightSample(SPO2, r.atMs, r.spo2)))
    // The provider files a night's breathing rate once, as the night ends.
    nightPut(SLEEP_BREATHING, [nightSample(SLEEP_BREATHING, night.endMs,
      Number((respiratoryRateToday + range(nightRand, -0.3, 0.3)).toFixed(1)))])

    // The morning's once-a-day figures read off the night that just ended, filed under the day it
    // ended on like resting heart rate above: SpO2's is that night's own average.
    const spo2Average = nightSamples.reduce((sum, r) => sum + r.spo2, 0) / nightSamples.length
    put(DAILY_SPO2, dayStart, dayEnd, [dailyPoint({
      payloadKey: DAILY_SPO2.payloadKey, valuePath: DAILY_SPO2.valuePath,
      value: Number(spo2Average.toFixed(1)), date: civilDate,
    })])
    if (warmNightsLeft === 0 && nightRand() < 0.04) warmNightsLeft = 2 + Math.floor(nightRand() * 3)
    const warmth = warmNightsLeft > 0 ? range(nightRand, 0.5, 0.9) : 0
    if (warmNightsLeft > 0) warmNightsLeft--
    put(SLEEP_TEMPERATURE, dayStart, dayEnd, [dailyPoint({
      payloadKey: SLEEP_TEMPERATURE.payloadKey, valuePath: SLEEP_TEMPERATURE.valuePath,
      value: Number((temperatureBaselineCelsius + range(nightRand, -0.4, 0.4) + warmth).toFixed(2)), date: civilDate,
    })])

    if (workout) {
      // Drawn whether or not lastDayUntilMs keeps the workout, so the stream never depends on it.
      const offset = amsterdamOffset(workout.startMs)
      const reading = workoutReadingFor(workoutRand, {
        exerciseType: workout.exerciseType, startMs: workout.startMs, endMs: workout.endMs, offset,
        startBpm: workoutStartBpm, restingBpm: restingHrBpm, maxBpm, ceilings, runIndex, vo2Base,
      })
      if (workout.exerciseType === 'RUNNING') runIndex++
      const after = recoveryFor(recoveryRand, { endMs: workout.endMs, lastBpm: reading.heartRate.at(-1)!.bpm, restingBpm: restingHrBpm })
      if (workoutKept) {
        const name = `users/me/dataTypes/exercise/dataPoints/seed-${i}`
        put(EXERCISE, dayStart, dayEnd, [exercisePoint({
          name,
          startTime: new Date(workout.startMs).toISOString(),
          endTime: new Date(workout.endMs).toISOString(),
          utcOffset: offset,
          exerciseType: workout.exerciseType,
          detail: reading.detail,
        })])
        // Fetched over the workout's own span and the minutes after it, like a night's readings
        // over the night's, so it is not read as a re-fetch of the day's hourly curve. The window's
        // end is exclusive, so it runs a minute past the last reading, and stops at a cutoff that
        // falls inside those minutes, as the readings do.
        const afterKept = after.filter((r) => sampleDone(r.atMs))
        const lastAfterMs = afterKept.at(-1)?.atMs
        const windowEndMs = lastAfterMs === undefined ? workout.endMs : Math.min(lastAfterMs + 60_000, cutoff ?? Infinity)
        put(HEART_RATE, workout.startMs, windowEndMs, [...reading.heartRate, ...afterKept].map((r) => samplePoint({
          payloadKey: HEART_RATE.payloadKey, valuePath: HEART_RATE.valuePath, value: String(r.bpm),
          physicalTime: new Date(r.atMs).toISOString(), utcOffset: amsterdamOffset(r.atMs),
        })))
        if (workout.exerciseType === 'RUNNING') {
          keptRuns.push({ name, startMs: workout.startMs, endMs: workout.endMs, offset, reading })
        }
      }
    }

    const moodPoints = [moodPoint({
      atMs: dayStart + 20 * HOUR_MS, utcOffset: amsterdamOffset(dayStart + 20 * HOUR_MS), moods: [pick(rand, MOOD_LABELS)],
    })]
    put(MOODS, dayStart, dayEnd, sampleDone(dayStart + 20 * HOUR_MS) ? moodPoints : [])
  }

  // A route never rides on Google's copy of a run (exercisePoint's own comment): it reaches a real
  // archive as the phone's copy of the same workout, which the app merges with Google's on read.
  // So each routed run is a second, companion point over the run's own span, carrying the interval,
  // the type and the route and nothing the companion sync does not send.
  // The last run, and the most recent earlier runs of nearly its length: chosen by what the stream
  // already drew, with no draw of their own, so routing changes nothing else the demo holds.
  const lengthOf = (run: (typeof keptRuns)[number]) => run.reading.progress.at(-1)!.meters
  const lastRun = keptRuns.at(-1)
  const routedRuns = !input.demoRoute || lastRun === undefined ? [] : [
    ...keptRuns.slice(0, -1)
      .filter((run) => Math.abs(lengthOf(run) - lengthOf(lastRun)) <= ROUTED_RUN_LENGTH_TOLERANCE * lengthOf(lastRun))
      .slice(-(ROUTED_RUNS - 1)),
    lastRun,
  ]
  if (input.demoRoute) {
    for (const run of routedRuns) {
      put(EXERCISE, run.startMs, run.endMs, [exercisePoint({
        name: `${run.name}-phone`,
        startTime: new Date(run.startMs).toISOString(),
        endTime: new Date(run.endMs).toISOString(),
        utcOffset: run.offset,
        exerciseType: 'RUNNING',
        route: syntheticRoute({ startMs: run.startMs, ...run.reading }),
      })])
    }
  }

  putRollups(TOTAL_CALORIES, totalCaloriesWindows)
  putRollups(FLOORS, floorsWindows)

  return { payloads }
}
