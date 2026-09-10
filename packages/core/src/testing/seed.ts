// A generator of plausible demo data. It writes archive payloads and nothing else - no row in
// `samples`, `daily`, `sessions`, `session_segments` or `observations` is ever inserted directly
// here. Everything a later reader sees in those tables has to come from the app's own rebuild
// replaying the bodies this file writes, the same as a real person's history does. That is what
// makes the result provably reachable by a real instance: a seed that wrote a derived row could
// draw a chart no real household could ever produce.
//
// Shaped, not modelled. Steps rise through the morning and fall after evening, and run lower on
// Sundays. Heart rate troughs overnight and otherwise tracks the step curve. Sleep lands in a
// plausible window with realistic stage proportions and drifts by tens of minutes a night.
// Weight drifts rather than walks - one slow trend held for the whole span, not a meander that
// could wander anywhere. Workouts land a few times a week, on a fixed schedule rather than a
// coin flip, so the exercise type always shows up regardless of which seed a caller passes.
// Recovery's three daily figures each get a different kind of noise instead of one formula
// reused three times: resting heart rate drifts like weight, HRV swings around a fixed baseline
// day to day, and respiratory rate barely moves at all - the same spread a real week of each
// actually has, and the reason the Recovery page (and its Dashboard card) draws anything once
// the app rebuilds from this. Moods is the one categorical type here, seeded so `observations`
// is not empty once the app rebuilds; see the ruling in this unit's plan for why `moods` and not
// one of the reproductive health types. None of this computes anything about the body it is
// shaped after - no metabolic model, no calorie balance, nothing that would make a claim about
// physiology it has no business making.
//
// Deterministic by construction: a mulberry32 PRNG seeded once, consumed in a fixed order, and
// nothing here ever reaches for Math.random. The same seed produces the same bytes today and a
// year from now, which is the property both this unit's rehearsal and the next unit's
// screenshots depend on.

import { randomUUID } from 'node:crypto'
import type { DataType } from '../api/catalogue.ts'
import { dataTypeById } from '../api/catalogue.ts'
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

// Rises from nothing at 6am to a midday peak and back to nothing by 10pm. Reused for the heart
// rate curve below so the two stay visibly related without either being derived from the other.
const stepCurve = (hour: number): number => Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI))

const EXERCISE_TYPES = ['RUNNING', 'CYCLING', 'WALKING', 'STRENGTH_TRAINING', 'SWIMMING'] as const
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

function stagesFor(rand: () => number, startMs: number, endMs: number): SleepStage[] {
  const shares = STAGE_PATTERN.map((s) => s.share * range(rand, 0.8, 1.2))
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
    const durationMs = range(rand, 6.5 * HOUR_MS, 8.5 * HOUR_MS) // tens of minutes of night-to-night variation
    const endMs = dayStart + wakeOffsetMs
    return { startMs: endMs - durationMs, endMs }
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

    const stepsPoints = Array.from({ length: 24 }, (_, h) => {
      const hourStart = dayStart + h * HOUR_MS
      const intensity = stepCurve(h) * (isSunday ? 0.6 : 1) * range(rand, 0.85, 1.15)
      return intervalPoint({
        payloadKey: STEPS.payloadKey, valuePath: STEPS.valuePath, value: Math.round(700 * intensity),
        physicalTime: new Date(hourStart).toISOString(),
        endTime: new Date(hourStart + HOUR_MS).toISOString(),
        utcOffset: '0s',
      })
    })
    put(STEPS, dayStart, dayEnd, stepsPoints)

    const hrPoints = Array.from({ length: 24 }, (_, h) => {
      const atMs = dayStart + h * HOUR_MS
      const overnight = h < 6 || h >= 23
      const bpm = overnight ? range(rand, 50, 58) : 60 + stepCurve(h) * range(rand, 15, 25)
      return samplePoint({
        payloadKey: HEART_RATE.payloadKey, valuePath: HEART_RATE.valuePath, value: String(Math.round(bpm)),
        physicalTime: new Date(atMs).toISOString(), utcOffset: '0s',
      })
    })
    put(HEART_RATE, dayStart, dayEnd, hrPoints)

    weightGrams += weightTrendPerDay + range(rand, -80, 80)
    put(WEIGHT, dayStart, dayEnd, [samplePoint({
      payloadKey: WEIGHT.payloadKey, valuePath: WEIGHT.valuePath, value: String(Math.round(weightGrams)),
      physicalTime: new Date(dayStart + 7 * HOUR_MS).toISOString(), utcOffset: '0s',
    })])

    const civilDate = civilDateOf(dayStart)

    restingHrBpm += restingHrTrendPerDay + range(rand, -0.6, 0.6)
    // A bad night nudges that one day's reading up without moving the underlying trend - the
    // point of "the odd bad night" is that it does not carry into tomorrow the way the drift does.
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
      utcOffset: '0s',
      stages: stagesFor(rand, night.startMs, night.endMs),
    })])

    // A few times a week, on a fixed schedule rather than a coin flip: the type has to show up
    // in any span this generator is asked for, not merely on average across many seeds.
    if (i % 3 === 1) {
      const startMs = dayStart + pick(rand, [7, 12, 18]) * HOUR_MS
      const endMs = startMs + range(rand, 25, 55) * 60_000
      put(EXERCISE, dayStart, dayEnd, [exercisePoint({
        name: `users/me/dataTypes/exercise/dataPoints/seed-${i}`,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        utcOffset: '0s',
        exerciseType: pick(rand, EXERCISE_TYPES),
      })])
    }

    put(MOODS, dayStart, dayEnd, [moodPoint({
      atMs: dayStart + 20 * HOUR_MS, utcOffset: '0s', moods: [pick(rand, MOOD_LABELS)],
    })])
  }

  return { payloads }
}
