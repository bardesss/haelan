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
// a value the API has never sent. Recovery's three daily figures each get a different kind of
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
// Deterministic by construction: a mulberry32 PRNG seeded once, consumed in a fixed order, and
// nothing here ever reaches for Math.random. The same seed produces the same bytes today and a
// year from now, which is the property both this unit's rehearsal and the next unit's
// screenshots depend on.

import { randomUUID } from 'node:crypto'
import type { DataType } from '../api/catalogue.ts'
import { dataTypeById } from '../api/catalogue.ts'
import { EXERCISE_TYPES } from '../api/enums.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { SleepStage } from './payloads.ts'
import { body, dailyPoint, intervalPoint, samplePoint, sleepPoint } from './payloads.ts'

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

// The three daily-summary metrics below key off the civil date dailyPoint expects, not the
// millisecond instant the rest of this file passes around. Read back with getUTC*, matching the
// UTC approximation listRequestParams already makes for this generator's person-less timezone.
const civilDateOf = (ms: number): { year: number, month: number, day: number } => {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
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

// Rises from nothing at 6am to a midday peak and back to nothing by 10pm. Reused for the heart
// rate curve below so the two stay visibly related without either being derived from the other.
const stepCurve = (hour: number): number => Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI))

// A curated slice of the API's 182 real exercise types (packages/core/src/api/enums.ts,
// drift-checked against the live discovery document), not a private list of this file's own -
// that private list is what let `CYCLING`, a value the API has never sent, sit here unnoticed
// under a name that shadowed the checked constant. Every value below also has a real translation
// in apps/web's SEEDED_EXERCISE_TYPES, so a session this generator writes always has something to
// call itself on the Dutch screenshots the next unit takes rather than falling back to raw
// English. Checked against EXERCISE_TYPES here, at generation time, rather than copied outright:
// a value the API retires stops this file with a thrown error the next time anything seeds,
// instead of quietly seeding a string nothing can ever map again - requireType above does the
// same thing for a data type id, for the same reason.
const SEED_EXERCISE_TYPES = (['RUNNING', 'BIKING', 'WALKING', 'WEIGHTLIFTING', 'SWIMMING_POOL'] as const)
  .map((type) => {
    if (!EXERCISE_TYPES.includes(type)) {
      throw new Error(`seedArchive: '${type}' is no longer an exercise type this catalogue knows about`)
    }
    return type
  })

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
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '0s'
  return {
    name: o.name,
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    exercise: {
      interval: { startTime: o.startTime, startUtcOffset: offset, endTime: o.endTime, endUtcOffset: offset },
      exerciseType: o.exerciseType,
    },
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

export interface SeedArchiveInput {
  archive: RawArchive
  personId: string
  days: number
  /** Exclusive, like dayWindows' own toMs: the last generated day ends here, never on it. */
  endMs: number
  seed?: number
}

export interface SeedArchiveResult { payloads: number }

export function seedArchive(input: SeedArchiveInput): SeedArchiveResult {
  const STEPS = requireType('steps')
  const HEART_RATE = requireType('heart-rate')
  const WEIGHT = requireType('weight')
  const SLEEP = requireType('sleep')
  const EXERCISE = requireType('exercise')
  const MOODS = requireType('moods')
  const DAILY_RESTING_HR = requireType('daily-resting-heart-rate')
  const DAILY_HRV = requireType('daily-heart-rate-variability')
  const DAILY_RESPIRATORY_RATE = requireType('daily-respiratory-rate')

  const rand = mulberry32(input.seed ?? DEFAULT_SEED)
  let payloads = 0

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

  for (let i = 0; i < input.days; i++) {
    const dayStart = input.endMs - (input.days - i) * DAY_MS
    const dayEnd = dayStart + DAY_MS
    const isSunday = new Date(dayStart).getUTCDay() === 0

    // A few times a week, on a fixed schedule rather than a coin flip: the type has to show up
    // in any span this generator is asked for, not merely on average across many seeds. Decided
    // before the step and heart-rate curves below, which is new: they need to know the workout's
    // hour to show it happening rather than run beside it unaware, the same way a real watch's
    // step count and pulse both move for the minutes someone is actually exercising.
    const workout = i % 3 === 1 ? (() => {
      const hour = pick(rand, [7, 12, 18])
      const startMs = dayStart + hour * HOUR_MS
      const endMs = startMs + range(rand, 25, 55) * 60_000
      return { hour, startMs, endMs, exerciseType: pick(rand, SEED_EXERCISE_TYPES) }
    })() : null

    // Moved ahead of the heart-rate curve below, which reads this same trend for its overnight
    // baseline: resting heart rate is by definition close to a night's lowest sustained reading,
    // so the two have to be computed from the same number rather than two independent draws that
    // could land anywhere relative to each other.
    restingHrBpm += restingHrTrendPerDay + range(rand, -0.6, 0.6)

    const stepsPoints = Array.from({ length: 24 }, (_, h) => {
      const hourStart = dayStart + h * HOUR_MS
      const intensity = stepCurve(h) * (isSunday ? 0.6 : 1) * range(rand, 0.85, 1.15)
      // The workout's own hour gets the steps its minutes actually took, laid on top of the
      // ambient curve, instead of a session the step chart shows no sign of at all.
      const workoutMinutes = workout && workout.hour === h ? (workout.endMs - workout.startMs) / 60_000 : 0
      const workoutSteps = workoutMinutes > 0 ? Math.round(workoutMinutes * range(rand, 120, 160)) : 0
      return intervalPoint({
        payloadKey: STEPS.payloadKey, valuePath: STEPS.valuePath, value: Math.round(700 * intensity) + workoutSteps,
        physicalTime: new Date(hourStart).toISOString(),
        endTime: new Date(hourStart + HOUR_MS).toISOString(),
        utcOffset: amsterdamOffset(hourStart),
      })
    })
    put(STEPS, dayStart, dayEnd, stepsPoints)

    const hrPoints = Array.from({ length: 24 }, (_, h) => {
      const atMs = dayStart + h * HOUR_MS
      const overnight = h < 6 || h >= 23
      const bpm = workout && workout.hour === h
        // A moving workout, not a stroll: a run or a lift raises the pulse well past the
        // ambient daytime peak, which is what makes "84 bpm on a 51-minute run" a contradiction
        // in the first place.
        ? range(rand, 128, 168)
        : overnight
          // A few beats below the day's own resting figure rather than an unrelated absolute
          // band - see the comment above restingHrBpm's update for why the two must agree.
          ? range(rand, restingHrBpm - 6, restingHrBpm - 1)
          : 60 + stepCurve(h) * range(rand, 15, 25)
      return samplePoint({
        payloadKey: HEART_RATE.payloadKey, valuePath: HEART_RATE.valuePath, value: String(Math.round(bpm)),
        physicalTime: new Date(atMs).toISOString(), utcOffset: amsterdamOffset(atMs),
      })
    })
    put(HEART_RATE, dayStart, dayEnd, hrPoints)

    weightGrams += weightTrendPerDay + range(rand, -80, 80)
    put(WEIGHT, dayStart, dayEnd, [samplePoint({
      payloadKey: WEIGHT.payloadKey, valuePath: WEIGHT.valuePath, value: String(Math.round(weightGrams)),
      physicalTime: new Date(dayStart + 7 * HOUR_MS).toISOString(), utcOffset: amsterdamOffset(dayStart + 7 * HOUR_MS),
    })])

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

    const night = nights[i]!
    put(SLEEP, dayStart, dayEnd, [sleepPoint({
      name: `users/me/dataTypes/sleep/dataPoints/seed-${i}`,
      startTime: new Date(night.startMs).toISOString(),
      endTime: new Date(night.endMs).toISOString(),
      utcOffset: amsterdamOffset(night.startMs),
      stages: stagesFor(rand, night.startMs, night.endMs, night.restless),
    })])

    if (workout) {
      put(EXERCISE, dayStart, dayEnd, [exercisePoint({
        name: `users/me/dataTypes/exercise/dataPoints/seed-${i}`,
        startTime: new Date(workout.startMs).toISOString(),
        endTime: new Date(workout.endMs).toISOString(),
        utcOffset: amsterdamOffset(workout.startMs),
        exerciseType: workout.exerciseType,
      })])
    }

    put(MOODS, dayStart, dayEnd, [moodPoint({
      atMs: dayStart + 20 * HOUR_MS, utcOffset: amsterdamOffset(dayStart + 20 * HOUR_MS), moods: [pick(rand, MOOD_LABELS)],
    })])
  }

  return { payloads }
}
