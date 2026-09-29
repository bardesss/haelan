import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions, sessionSegments } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { morningSummaryOf, readNightPage } from '../src/query/nightPage.ts'
import type { NightPageInput } from '../src/query/nightPage.ts'

const NIGHT = '2026-09-06'
// Local time is UTC+2 throughout, so a local clock time is two hours ahead of its instant.
const OFFSET = 120

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

const q = () => new PersonQuery(test.db, 'p1')
const input = (localDate: string): NightPageInput => ({
  localDate, today: '2026-09-10', nowMs: Date.parse('2026-09-10T10:00:00Z'), nameOf: (id) => id,
  sleepTargetMinutes: 480, sleepUseBaseline: true,
})

function seedDaily(localDate: string, metric: string, agg: string, value: number) {
  test.db.insert(daily).values({
    personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

/** The instant of a local clock time on a local date, under OFFSET. */
const at = (localDate: string, hhmm: string) => Date.parse(`${localDate}T${hhmm}:00Z`) - OFFSET * 60_000

interface NightValues {
  asleep?: number, deep?: number, light?: number, rem?: number, latency?: number, awakenings?: number
  startLocal?: string, endLocal?: string
  /** The night's segments as [stage, from, to] in minutes after its start; one lowercase 'light' segment when absent. */
  segments?: readonly (readonly [string, number, number])[]
}

/**
 * One main sleep session filed under `localDate`, with one segment so sleepNights assembles it, its
 * attrs in the shape mapSessions stores (the provider's summary untouched, numbers as strings), and
 * a daily row for each figure given. Time asleep defaults to 420 so every seeded night is a night
 * the navigation series can find.
 */
function seedNight(localDate: string, v: NightValues) {
  const id = `night-${localDate}`
  // Bed at 23:00 the evening before unless the night says otherwise; a bedtime after midnight
  // falls on the wake date itself.
  const startMs = v.startLocal === undefined ? at(shiftLocalDate(localDate, -1), '23:00') : at(localDate, v.startLocal)
  const endMs = at(localDate, v.endLocal ?? '07:00')
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({
      type: null, mainSleep: true, stagesStatus: 'SUCCEEDED',
      summary: {
        minutesInSleepPeriod: '480',
        ...(v.latency === undefined ? {} : { minutesToFallAsleep: String(v.latency) }),
        minutesAfterWakeUp: '3',
        stagesSummary: [
          { type: 'LIGHT', minutes: '240', count: '20' },
          ...(v.awakenings === undefined ? [] : [{ type: 'AWAKE', minutes: '30', count: String(v.awakenings) }]),
        ],
      },
    }),
  }).run()
  if (v.segments === undefined) {
    test.db.insert(sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
  } else {
    v.segments.forEach(([stage, from, to], i) => test.db.insert(sessionSegments).values({
      id: `${id}-${i + 1}`, sessionId: id, stage, startMs: startMs + from * 60_000, endMs: startMs + to * 60_000,
    }).run())
  }
  seedDaily(localDate, 'sleep_asleep_minutes', 'sum', v.asleep ?? 420)
  if (v.deep !== undefined) seedDaily(localDate, 'sleep_deep_minutes', 'sum', v.deep)
  if (v.light !== undefined) seedDaily(localDate, 'sleep_light_minutes', 'sum', v.light)
  if (v.rem !== undefined) seedDaily(localDate, 'sleep_rem_minutes', 'sum', v.rem)
}

/** A second sleep session on a night, flagged by the source as not the main sleep, with its own summary. */
function seedNonMainSession(localDate: string, o: { startLocal: string, endLocal: string, latency: number }) {
  const id = `fragment-${localDate}`
  const startMs = at(shiftLocalDate(localDate, -1), o.startLocal)
  const endMs = at(shiftLocalDate(localDate, -1), o.endLocal)
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({ type: null, mainSleep: false, stagesStatus: 'SUCCEEDED', summary: { minutesToFallAsleep: String(o.latency) } }),
  }).run()
  test.db.insert(sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
}

/**
 * `n` consecutive nights ending the night before NIGHT, each numeric value jittered by two minutes
 * either way on alternate nights so every usual range has a spread to judge against.
 */
function seedNights(n: number, v: NightValues) {
  for (let i = 0; i < n; i += 1) {
    const jitter = i % 2 === 0 ? 2 : -2
    const jittered = (x: number | undefined) => (x === undefined ? undefined : x + jitter)
    seedNight(shiftLocalDate(NIGHT, -(n - i)), {
      asleep: jittered(v.asleep), deep: jittered(v.deep), light: jittered(v.light), rem: jittered(v.rem),
      latency: jittered(v.latency), awakenings: jittered(v.awakenings),
    })
  }
}

describe('readNightPage', () => {
  it('is null on a date with no night', () => {
    expect(readNightPage(q(), input(NIGHT))).toBeNull()
  })

  it('judges time asleep and deep sleep against sixty nights of usual, with a seven-night strip', () => {
    seedNights(60, { asleep: 420, deep: 85 })
    seedNight(NIGHT, { asleep: 396, deep: 50 })
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.figures.asleep.standing).toBe('below')
    expect(page.figures.deep.judged).toBe('worse')
    expect(page.figures.asleep.strip).toHaveLength(7)
  })

  it('reads time to fall asleep and times woken from the main sleep session, against the nights before', () => {
    seedNights(60, { latency: 10, awakenings: 12 })
    seedNight(NIGHT, { latency: 45, awakenings: 12 })
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.figures.minutesToFallAsleep).toMatchObject({ value: 45, standing: 'above', judged: 'worse' })
    expect(page.figures.awakenings.standing).toBe('within')
  })

  it('states stage shares of time asleep', () => {
    seedNight(NIGHT, { asleep: 400, deep: 100, light: 200, rem: 100 })
    expect(readNightPage(q(), input(NIGHT))!.stagePercent).toEqual({ deep: 25, light: 50, rem: 25 })
  })

  it('balances the seven nights against the target when the person does not follow the usual', () => {
    // Six nights jittered +2 and -2 in turn cancel out, so the seven strip nights sum to 7 * 450.
    seedNights(6, { asleep: 450 })
    seedNight(NIGHT, { asleep: 450 })
    const page = readNightPage(q(), { ...input(NIGHT), sleepUseBaseline: false, sleepTargetMinutes: 480 })!
    expect(page.balance.zeroLine).toEqual({ minutes: 480, source: 'target' })
    expect(page.balance.total).toBe(-30 * 7)
    expect(page.balance.nights).toEqual([
      { localDate: '2026-08-31', difference: -28 }, { localDate: '2026-09-01', difference: -32 },
      { localDate: '2026-09-02', difference: -28 }, { localDate: '2026-09-03', difference: -32 },
      { localDate: '2026-09-04', difference: -28 }, { localDate: '2026-09-05', difference: -32 },
      { localDate: NIGHT, difference: -30 },
    ])
  })

  it('balances against the usual when the person follows it and it is not thin', () => {
    seedNights(60, { asleep: 420 })
    seedNight(NIGHT, { asleep: 420 })
    const page = readNightPage(q(), { ...input(NIGHT), sleepUseBaseline: true, sleepTargetMinutes: 480 })!
    expect(page.balance.zeroLine.source).toBe('baseline')
    expect(page.balance.zeroLine.minutes).toBeCloseTo(420)
  })

  it('pairs the night with the day before it, and steps to the neighbouring nights', () => {
    seedNight('2026-09-04', {}); seedNight(NIGHT, {}); seedNight('2026-09-08', {})
    seedDaily('2026-09-05', 'steps', 'sum', 11240)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.day.localDate).toBe('2026-09-05')
    expect(page.day.steps.value).toBe(11240)
    expect(page.nav).toEqual({ previous: '2026-09-04', next: '2026-09-08' })
  })

  it('carries the day before\'s active minutes, judged the way up, and the workouts done on it', () => {
    seedNight(NIGHT, {})
    seedDaily('2026-09-05', 'active_minutes_light', 'sum', 30)
    seedDaily('2026-09-05', 'active_minutes_vigorous', 'sum', 25)
    for (const [id, localDate] of [['evening-run', '2026-09-05'], ['next-morning', NIGHT]] as const) {
      const startMs = at(localDate, '07:00')
      test.db.insert(sessions).values({
        id, personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: id,
        startMs, startOffsetMinutes: OFFSET, endMs: startMs + 30 * 60_000, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
        attrs: JSON.stringify({ exerciseType: 'RUNNING' }),
      }).run()
    }
    const { day } = readNightPage(q(), input(NIGHT))!
    // Up, the direction of the three levels it sums: 'active_minutes' is no catalogue id, and read
    // as its own name it would come out neutral and never be judged.
    expect(day.activeMinutes).toMatchObject({ metric: 'active_minutes', value: 55, direction: 'up' })
    expect(day.workouts.map((w) => w.id)).toEqual(['evening-run'])
  })

  it('judges the morning\'s resting heart rate and HRV as page figures, the way the catalogue says is better', () => {
    // Sixty mornings alternating 50 and 52 bpm and 40 and 44 ms, then a morning at 60 and 30: a
    // higher resting heart rate is worse, a lower HRV is worse.
    for (let i = 1; i <= 60; i += 1) {
      seedDaily(shiftLocalDate(NIGHT, -i), 'resting_heart_rate', 'last', i % 2 === 0 ? 50 : 52)
      seedDaily(shiftLocalDate(NIGHT, -i), 'daily_hrv', 'last', i % 2 === 0 ? 40 : 44)
    }
    seedNight(NIGHT, {})
    seedDaily(NIGHT, 'resting_heart_rate', 'last', 60)
    seedDaily(NIGHT, 'daily_hrv', 'last', 30)
    const { morning } = readNightPage(q(), input(NIGHT))!
    expect(morning.restingHeartRate).toMatchObject({ metric: 'resting_heart_rate', value: 60, direction: 'down', standing: 'above', judged: 'worse' })
    expect(morning.restingHeartRate.strip).toHaveLength(7)
    expect(morning.hrv).toMatchObject({ value: 30, direction: 'up', standing: 'below', judged: 'worse' })
  })

  it('carries the morning\'s recovery index beside the night', () => {
    seedNight(NIGHT, {})
    const { recovery } = readNightPage(q(), input(NIGHT))!.morning
    expect(recovery.index).toMatchObject({ metric: 'recovery_index' })
    // The morning after the night, so its strip ends on the night's own date, not the day before.
    expect(recovery.index.strip).toHaveLength(7)
    expect(recovery.index.strip.at(-1)!.localDate).toBe(NIGHT)
  })

  it('pairs a night begun after midnight with the day before its wake date', () => {
    // Which date a night is filed under is ingest's decision (sessions.local_date); this read only pairs it.
    seedNight(NIGHT, { startLocal: '00:30', endLocal: '07:10' })
    seedDaily('2026-09-05', 'steps', 'sum', 9000)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.localDate).toBe(NIGHT)
    expect(page.day.localDate).toBe('2026-09-05')
    expect(page.day.steps.value).toBe(9000)
  })

  it('steps to no next night when the night is today\'s, and to no previous night on the archive\'s first', () => {
    seedNight('2026-09-04', {}); seedNight(NIGHT, {})
    expect(readNightPage(q(), { ...input(NIGHT), today: NIGHT })!.nav).toEqual({ previous: '2026-09-04', next: null })
    expect(readNightPage(q(), input('2026-09-04'))!.nav).toEqual({ previous: null, next: NIGHT })
  })

  it('reads the summary from the main sleep session when a non-main one comes first in the night', () => {
    // 22:00-22:40 then 23:00-07:00: twenty minutes apart, well inside the night gap, so both are
    // one night and the fragment is listed first by start; only the second is the main sleep.
    seedNonMainSession(NIGHT, { startLocal: '22:00', endLocal: '22:40', latency: 99 })
    seedNight(NIGHT, { latency: 12 })
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.night.sessionIds).toEqual([`fragment-${NIGHT}`, `night-${NIGHT}`])
    expect(page.figures.minutesToFallAsleep.value).toBe(12)
  })

  it('reads every other figure from its own metric', () => {
    seedNight(NIGHT, {})
    seedDaily(NIGHT, 'sleep_efficiency', 'last', 91)
    seedDaily(NIGHT, 'sleep_awake_minutes', 'sum', 31)
    seedDaily(NIGHT, 'sleep_in_bed_minutes', 'sum', 470)
    seedDaily(NIGHT, 'sleep_bedtime_minutes', 'last', -45)
    seedDaily(NIGHT, 'sleep_waketime_minutes', 'last', 415)
    seedDaily(NIGHT, 'sleep_nap_count', 'count', 2)
    seedDaily(NIGHT, 'sleep_nap_minutes', 'sum', 35)
    seedDaily(NIGHT, 'sleep_respiratory_rate', 'last', 14.5)
    seedDaily(NIGHT, 'daily_spo2', 'last', 96.5)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.figures).toMatchObject({
      efficiency: { metric: 'sleep_efficiency', value: 91 },
      awake: { metric: 'sleep_awake_minutes', value: 31 },
      inBed: { metric: 'sleep_in_bed_minutes', value: 470 },
      bedtime: { metric: 'sleep_bedtime_minutes', value: -45 },
      waketime: { metric: 'sleep_waketime_minutes', value: 415 },
      napCount: { metric: 'sleep_nap_count', value: 2 },
      napMinutes: { metric: 'sleep_nap_minutes', value: 35 },
      minutesAfterWakeUp: { metric: 'sleep_after_wake_minutes', value: 3 },
    })
    expect(page.morning).toMatchObject({
      breathing: { metric: 'sleep_respiratory_rate', value: 14.5 },
      spo2: { metric: 'daily_spo2', value: 96.5 },
    })
  })

  it('traces heart rate across the night alone', () => {
    seedNight(NIGHT, {})
    const hr = (localDate: string, hhmm: string, bpm: number) => insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(localDate, hhmm), tzOffsetMinutes: OFFSET, value: bpm,
    })
    hr('2026-09-05', '22:00', 40)   // before bed: not part of the night
    hr(NIGHT, '00:00', 60); hr(NIGHT, '03:00', 52); hr(NIGHT, '05:00', 70)
    const { stat } = readNightPage(q(), input(NIGHT))!.traces.heartRate
    expect(stat.mean).toBeCloseTo((60 + 52 + 70) / 3)
    expect(stat.lowest).toEqual({ value: 52, atMs: at(NIGHT, '03:00') })
  })

  it('states skin temperature as a deviation from its usual, and not against a thin one', () => {
    seedNight(NIGHT, {})
    seedDaily(NIGHT, 'sleep_temperature', 'last', 33.5)
    for (let i = 1; i <= 3; i += 1) seedDaily(shiftLocalDate(NIGHT, -i), 'sleep_temperature', 'last', 33)
    const thin = readNightPage(q(), input(NIGHT))!.morning
    expect(thin.skinTemperature.value).toBe(33.5)
    expect(thin.skinTemperatureDeviation).toBeNull()
    // Three nights at 33.0 and fifty-seven alternating 33.1 and 32.9: a usual centred near 33.0.
    for (let i = 4; i <= 60; i += 1) seedDaily(shiftLocalDate(NIGHT, -i), 'sleep_temperature', 'last', i % 2 === 0 ? 33.1 : 32.9)
    const usual = readNightPage(q(), input(NIGHT))!.morning
    expect(usual.skinTemperature.baseline!.thin).toBe(false)
    expect(usual.skinTemperatureDeviation).toBeCloseTo(33.5 - usual.skinTemperature.baseline!.center)
    expect(usual.skinTemperatureDeviation).toBeCloseTo(0.5, 1)
  })

  it('judges how much bedtime moved this week against how much it usually moves', () => {
    // Seventy steady nights (bedtime alternating 30 and 26 minutes before midnight), then this
    // night's bedtime far off: the week ending here spreads far wider than any earlier week did.
    for (let i = 1; i <= 70; i += 1) {
      const date = shiftLocalDate(NIGHT, -i)
      seedDaily(date, 'sleep_asleep_minutes', 'sum', 420)
      seedDaily(date, 'sleep_bedtime_minutes', 'last', i % 2 === 0 ? -30 : -26)
    }
    seedNight(NIGHT, {})
    seedDaily(NIGHT, 'sleep_bedtime_minutes', 'last', 200)
    const week = [-26, -30, -26, -30, -26, -30, 200]
    const mean = week.reduce((a, b) => a + b, 0) / week.length
    const sd = Math.sqrt(week.reduce((a, b) => a + (b - mean) ** 2, 0) / (week.length - 1))
    const figure = readNightPage(q(), input(NIGHT))!.figures.bedtimeVariability
    expect(figure.value).toBeCloseTo(sd)
    expect(figure).toMatchObject({ metric: 'sleep_bedtime_variability', standing: 'above', judged: 'worse' })
    expect(figure.baseline!.thin).toBe(false)
  })

  describe('the heart-rate dip', () => {
    const hr = (localDate: string, bpm: number) => insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(localDate, '03:00'), tzOffsetMinutes: OFFSET, value: bpm,
    })
    /** Twenty nights before NIGHT, each resting at 54 or 56 by turns and lowest at 44: dips of 10/54 and 12/56. */
    function seedHistory() {
      for (let i = 1; i <= 20; i += 1) {
        const date = shiftLocalDate(NIGHT, -i)
        seedNight(date, {})
        hr(date, 44)
        seedDaily(date, 'resting_heart_rate', 'last', i % 2 === 0 ? 54 : 56)
      }
    }

    it('is how far the lowest of the night fell below the resting heart rate, in percent of it, judged against the same on earlier nights', () => {
      seedHistory()
      seedNight(NIGHT, {})
      hr(NIGHT, 40)
      seedDaily(NIGHT, 'resting_heart_rate', 'last', 60)
      const dip = readNightPage(q(), input(NIGHT))!.morning.heartRateDip
      expect(dip).toMatchObject({ metric: 'sleep_heart_rate_dip', unit: 'percent', precision: 0, direction: 'up', standing: 'above', judged: 'better' })
      // (60 - 40) / 60, not / 40.
      expect(dip.value).toBeCloseTo(100 / 3)
      // Halfway between 10/54 and 12/56, each of the resting rate of its own night.
      expect(dip.baseline!.center).toBeCloseTo((1000 / 54 + 1200 / 56) / 2)
      expect(dip.baseline!.thin).toBe(false)
    })

    it('is null without a resting heart rate', () => {
      seedNight(NIGHT, {})
      hr(NIGHT, 40)
      expect(readNightPage(q(), input(NIGHT))!.morning.heartRateDip).toMatchObject({ value: null, standing: null })
    })

    it('is null when the only resting heart rate was recorded the day before', () => {
      seedNight(NIGHT, {})
      hr(NIGHT, 40)
      seedDaily(shiftLocalDate(NIGHT, -1), 'resting_heart_rate', 'last', 60)
      // Tonight is today's night, the one case where the morning figure falls back to the day
      // before while the watch has not synced; the dip does not follow it.
      const page = readNightPage(q(), { ...input(NIGHT), today: NIGHT })!
      expect(page.morning.recovery.restingHeartRate.asOfDate).toBe(shiftLocalDate(NIGHT, -1))
      expect(page.morning.heartRateDip).toMatchObject({ value: null, standing: null })
    })

    it('reads each night of history for heart rate once, shared by the trace and the dip', () => {
      seedHistory()
      seedNight(NIGHT, {})
      const pq = q()
      const read = pq.intradayWindow.bind(pq)
      let heartRateReads = 0
      pq.intradayWindow = (i) => { if (i.metric === 'heart_rate') heartRateReads += 1; return read(i) }
      readNightPage(pq, input(NIGHT))
      expect(heartRateReads).toBe(20 + 1)
    })
  })

  it('times the first deep and REM sleep and counts REM episodes, against the nights before', () => {
    // Twenty nights whose deep sleep came 50 or 54 minutes in by turns, REM at 170 or 174, one episode each.
    for (let i = 1; i <= 20; i += 1) {
      const d = i % 2 === 0 ? 0 : 4
      seedNight(shiftLocalDate(NIGHT, -i), {
        segments: [['AWAKE', 0, 5], ['LIGHT', 5, 55 + d], ['DEEP', 55 + d, 110], ['LIGHT', 110, 175 + d], ['REM', 175 + d, 260], ['LIGHT', 260, 480]],
      })
    }
    // Tonight deep sleep came 90 minutes after falling asleep, REM at 172, in two episodes.
    seedNight(NIGHT, {
      segments: [['AWAKE', 0, 5], ['LIGHT', 5, 95], ['DEEP', 95, 140], ['LIGHT', 140, 177], ['REM', 177, 220], ['LIGHT', 220, 300], ['REM', 300, 340], ['LIGHT', 340, 480]],
    })
    const { stageTiming, night } = readNightPage(q(), input(NIGHT))!
    // The instants the first deep and REM segment began, beside the minutes since falling asleep.
    expect(stageTiming.firstDeepAtMs).toBe(night.startMs + 95 * 60_000)
    expect(stageTiming.firstRemAtMs).toBe(night.startMs + 177 * 60_000)
    expect(stageTiming.firstDeep).toMatchObject({ metric: 'sleep_first_deep_minutes', unit: 'minutes', precision: 0, direction: 'neutral', value: 90, standing: 'above' })
    expect(stageTiming.firstDeep.baseline!.center).toBeCloseTo(52)
    expect(stageTiming.firstRem).toMatchObject({ metric: 'sleep_first_rem_minutes', value: 172, standing: 'within' })
    expect(stageTiming.cycles).toMatchObject({ metric: 'sleep_cycles', unit: 'count', value: 2, standing: 'above' })
  })

  it('leaves stage timing unjudged on a classic night', () => {
    seedNight(NIGHT, { segments: [['ASLEEP', 0, 200], ['RESTLESS', 200, 210], ['ASLEEP', 210, 480]] })
    const { stageTiming } = readNightPage(q(), input(NIGHT))!
    expect([stageTiming.firstDeep.value, stageTiming.firstRem.value, stageTiming.cycles.value]).toEqual([null, null, null])
  })

  it('counts how many of the judged morning figures sat outside their usual', () => {
    // Sixty mornings of steady readings, then a morning with a high resting heart rate and a low
    // HRV and everything else usual; the last twenty nights lowest at 40, so their dips are 12/52
    // and 10/50, and tonight's 20/60. Three outside, of every figure with a usual to stand on.
    const hr = (localDate: string) => insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(localDate, '03:00'), tzOffsetMinutes: OFFSET, value: 40,
    })
    for (let i = 1; i <= 20; i += 1) { seedNight(shiftLocalDate(NIGHT, -i), {}); hr(shiftLocalDate(NIGHT, -i)) }
    for (let i = 1; i <= 60; i += 1) {
      const date = shiftLocalDate(NIGHT, -i)
      const odd = i % 2 === 1
      seedDaily(date, 'resting_heart_rate', 'last', odd ? 52 : 50)
      seedDaily(date, 'daily_hrv', 'last', odd ? 44 : 40)
      seedDaily(date, 'sleep_respiratory_rate', 'last', odd ? 15 : 14)
      seedDaily(date, 'daily_spo2', 'last', odd ? 97 : 96)
    }
    seedNight(NIGHT, {})
    hr(NIGHT)
    seedDaily(NIGHT, 'resting_heart_rate', 'last', 60)
    seedDaily(NIGHT, 'daily_hrv', 'last', 30)
    seedDaily(NIGHT, 'sleep_respiratory_rate', 'last', 14.5)
    seedDaily(NIGHT, 'daily_spo2', 'last', 96.5)
    const page = readNightPage(q(), input(NIGHT))!
    const judged = [page.morning.restingHeartRate, page.morning.hrv, page.morning.breathing,
      page.morning.spo2, page.morning.skinTemperature, page.morning.heartRateDip].filter((f) => f.standing !== null)
    expect(page.morning.heartRateDip.standing).toBe('above')
    expect(judged).toHaveLength(5)
    expect(page.morningSummary).toEqual({ outside: 3, of: 5 })
  })

  it('counts skin temperature among the judged morning figures', () => {
    for (let i = 1; i <= 60; i += 1) seedDaily(shiftLocalDate(NIGHT, -i), 'sleep_temperature', 'last', i % 2 === 0 ? 33.1 : 33.0)
    seedNight(NIGHT, {})
    seedDaily(NIGHT, 'sleep_temperature', 'last', 34.5)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.morning.skinTemperature.standing).toBe('above')
    // Nothing else has a reading, so skin temperature is the only figure there is to count.
    expect(page.morningSummary).toEqual({ outside: 1, of: 1 })
  })
})

describe('morningSummaryOf', () => {
  it('counts only the judged figures, and of those the ones above or below', () => {
    expect(morningSummaryOf([
      { standing: 'above' }, { standing: 'within' }, { standing: null }, { standing: 'below' },
      { standing: 'within' }, { standing: 'within' }, { standing: null },
    ])).toEqual({ outside: 2, of: 5 })
  })
})
