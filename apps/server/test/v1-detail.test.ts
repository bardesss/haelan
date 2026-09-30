import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, insertSample, schema, shiftLocalDate } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { roundWorkoutFigure } from '../src/routes/v1/shared.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

async function get(h: Harness, token: string, path: string, extraHeaders: Record<string, string> = {}) {
  return h.app.inject({ method: 'GET', url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}`, ...extraHeaders } })
}

// 12:00 in Europe/Amsterdam (every harness person's zone), so p1's today is 2026-09-10 throughout.
const NOW_MS = Date.parse('2026-09-10T10:00:00Z')
const NIGHT = '2026-09-06'
// Local time is UTC+2 throughout, so a local clock time is two hours ahead of its instant.
const OFFSET = 120

/** The instant of a local clock time on a local date, under OFFSET. */
const at = (localDate: string, hhmm: string) => Date.parse(`${localDate}T${hhmm}:00Z`) - OFFSET * 60_000

function seedSource(h: Harness, id: string, personId = 'p1'): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id, personId, externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
  }).run()
}

function seedDaily(h: Harness, localDate: string, metric: string, agg: string, value: number): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

/** One main sleep session filed under `localDate`, with one segment so sleepNights assembles it, as the core night-page test seeds one. */
function seedNight(h: Harness, localDate: string, asleep: number): void {
  const id = `night-${localDate}`
  const startMs = at(shiftLocalDate(localDate, -1), '23:00')
  const endMs = at(localDate, '07:00')
  const db = h.app.haelan.instance.db
  db.insert(schema.sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({ type: null, mainSleep: true, stagesStatus: 'SUCCEEDED', summary: { minutesInSleepPeriod: '480' } }),
  }).run()
  db.insert(schema.sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'LIGHT', startMs, endMs }).run()
  seedDaily(h, localDate, 'sleep_asleep_minutes', 'sum', asleep)
}

/** One exercise session in the attrs shape mapSessions stores, as the core workout-page test seeds one; pace in seconds per km. */
function seedRun(h: Harness, input: {
  id: string, sourceId: string, localDate: string, pace: number, personId?: string
  /** One-kilometre automatic splits, each its active seconds. */
  splitSeconds?: number[]
  /** A type other than RUNNING, and any further metricsSummary fields, as the provider stores them. */
  exerciseType?: string, metrics?: Record<string, unknown>, activeDuration?: string
}): void {
  const startMs = at(input.localDate, '07:00')
  const splits = input.splitSeconds?.map((seconds) => ({
    startTime: null, endTime: null, splitType: 'DISTANCE', activeDuration: `${seconds}s`,
    metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: seconds / 1000 },
  })) ?? null
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id: input.id, personId: input.personId ?? 'p1', sourceId: input.sourceId, kind: 'exercise', externalId: input.id,
    startMs, startOffsetMinutes: OFFSET, endMs: startMs + 30 * 60_000, endOffsetMinutes: OFFSET,
    localDate: input.localDate, rawPayloadId: null,
    attrs: JSON.stringify({
      type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
      splitSummaries: null, exerciseEvents: null, displayName: null, notes: null, routeConsentRequired: null,
      exerciseMetadata: { hasGps: false }, exerciseType: input.exerciseType ?? 'RUNNING',
      metricsSummary: { averagePaceSecondsPerMeter: input.pace / 1000, ...input.metrics }, splits, activeDuration: input.activeDuration ?? null,
    }),
  }).run()
}

function putNote(h: Harness, localDate: string, body: string): void {
  h.app.haelan.instance.notes.put({ personId: 'p1', localDate, body, nowMs: h.clock.nowMs })
}

describe('GET /night/:localDate', () => {
  it('answers 404 on a date with no night', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const response = await get(harness, token, `/night/${NIGHT}`)
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('no_such_night')
  })

  it('refuses a date after today, and a malformed one', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    expect((await get(harness, token, '/night/2026-09-11')).statusCode).toBe(400)
    expect((await get(harness, token, '/night/2026-13-40')).statusCode).toBe(400)
  })

  // Sixty nights at 400.4 make a band of 400.4 either way (no spread). Core judges this night's
  // 400.2 below that band, and so worse on an up-is-better metric; on the wire both round to 400,
  // so the page must say within and claim no verdict, or it shows "400, below your usual 400".
  it('serves the night rounded, with the standing recomputed on the rounded numbers, and the day before\'s log', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let i = 1; i <= 60; i += 1) seedDaily(harness, shiftLocalDate(NIGHT, -i), 'sleep_asleep_minutes', 'sum', 400.4)
    seedNight(harness, NIGHT, 400.2)
    seedDaily(harness, NIGHT, 'sleep_deep_minutes', 'sum', 100.3)
    putNote(harness, '2026-09-05', 'late dinner')
    putNote(harness, NIGHT, 'not this one')

    const response = await get(harness, token, `/night/${NIGHT}`)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    const { asleep } = body.figures
    expect(asleep.value).toBe(400)
    expect(asleep.baseline).toMatchObject({ center: 400, low: 400, high: 400, thin: false })
    expect(asleep.standing).toBe('within')
    expect(asleep.judged).toBeNull()
    expect(body.figures.deep.value).toBe(100)
    // 100.3 of 400.2 is 25.06 percent, sent as a whole one.
    expect(body.stagePercent.deep).toBe(25)
    expect(body.balance.zeroLine.minutes).toBe(400)
    for (const n of body.balance.nights as { difference: number | null }[]) {
      if (n.difference !== null) expect(Number.isInteger(n.difference)).toBe(true)
    }
    expect(Number.isInteger(body.balance.total)).toBe(true)
    expect(body.log.note).toBe('late dinner')
    expect(body.sourceId).toBe('watch')
  })

  // Core signs each night against the zero line unrounded: seven nights of 400.4 against a 480
  // target are -79.6 each and -557.2 in all, sent as -80 a night and -557 in total, which the
  // page would show as seven -80s adding up to -557. The total is recomputed from what is sent.
  // Skin temperature the same way: 33.46 against a usual centred on 33.04 is 0.42, sent as 0.4,
  // beside a value sent as 33.5 and a centre sent as 33.0.
  it('sends a balance total and a skin deviation that add up from the numbers it sends beside them', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let i = 1; i <= 6; i += 1) seedDaily(harness, shiftLocalDate(NIGHT, -i), 'sleep_asleep_minutes', 'sum', 400.4)
    seedNight(harness, NIGHT, 400.4)
    for (let i = 1; i <= 60; i += 1) seedDaily(harness, shiftLocalDate(NIGHT, -i), 'sleep_temperature', 'last', i % 2 === 0 ? 33.09 : 32.99)
    seedDaily(harness, NIGHT, 'sleep_temperature', 'last', 33.46)

    const body = (await get(harness, token, `/night/${NIGHT}`)).json()
    expect(body.balance.zeroLine).toEqual({ minutes: 480, source: 'target' })
    const nights = body.balance.nights as { difference: number | null }[]
    expect(nights.map((n) => n.difference)).toEqual(Array(7).fill(-80))
    expect(body.balance.total).toBe(-560)
    const { skinTemperature } = body.morning
    expect(skinTemperature.value).toBe(33.5)
    expect(skinTemperature.baseline.center).toBe(33)
    expect(body.morning.skinTemperatureDeviation).toBe(0.5)
  })

  // Twenty nights whose heart rate falls to 44 under a resting rate of 50, a dip of 12 %, and a
  // night that falls to 44 under 50.17, a dip of 12.3 %. Core judges it above its flat band of 12;
  // on the wire it is 12, so it must read within, and the summary must count it as judged but not
  // as outside.
  it('re-judges the heart-rate dip on the wire, and the morning summary with it', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    const lowest = (localDate: string) => insertSample(harness!.app.haelan.instance.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(localDate, '03:00'), tzOffsetMinutes: OFFSET, value: 44,
    })
    for (let i = 1; i <= 20; i += 1) {
      const date = shiftLocalDate(NIGHT, -i)
      seedNight(harness, date, 400)
      lowest(date)
      seedDaily(harness, date, 'resting_heart_rate', 'last', 50)
    }
    seedNight(harness, NIGHT, 400)
    lowest(NIGHT)
    seedDaily(harness, NIGHT, 'resting_heart_rate', 'last', 50.17)

    const body = (await get(harness, token, `/night/${NIGHT}`)).json()
    expect(body.morning.heartRateDip).toMatchObject({ unit: 'percent', value: 12, standing: 'within', judged: null })
    expect(body.morning.heartRateDip.baseline).toMatchObject({ center: 12, low: 12, high: 12 })
    // Twenty nights are too few for a usual resting rate, so the dip is the one judged figure.
    expect(body.morningSummary).toEqual({ outside: 0, of: 1 })
  })

  // First deep sleep 52.6 minutes after onset is sent as 53, like every other whole-number figure;
  // the instant it began is sent as it is.
  it('sends the stage timing rounded', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedNight(harness, NIGHT, 400)
    const start = at(shiftLocalDate(NIGHT, -1), '23:00')
    harness.app.haelan.instance.db.insert(schema.sessionSegments).values({
      id: 'deep-1', sessionId: `night-${NIGHT}`, stage: 'DEEP', startMs: start + 52.6 * 60_000, endMs: start + 100 * 60_000,
    }).run()

    // First REM 172.6 minutes in. Fourteen nights before it give the first REM and the cycle count
    // each a baseline, whose centres (a mean of counts, a mean of minutes) are fractional.
    harness.app.haelan.instance.db.insert(schema.sessionSegments).values({
      id: 'rem-1', sessionId: `night-${NIGHT}`, stage: 'REM', startMs: start + 172.6 * 60_000, endMs: start + 200 * 60_000,
    }).run()
    for (let i = 1; i <= 14; i += 1) {
      const date = shiftLocalDate(NIGHT, -i)
      seedNight(harness, date, 400)
      const night = at(shiftLocalDate(date, -1), '23:00')
      const episodes = i % 3 === 0 ? 2 : 1
      harness.app.haelan.instance.db.insert(schema.sessionSegments).values({
        id: `deep-${date}`, sessionId: `night-${date}`, stage: 'DEEP', startMs: night + (30 + i * 0.4) * 60_000, endMs: night + 60 * 60_000,
      }).run()
      for (let e = 0; e < episodes; e += 1) {
        harness.app.haelan.instance.db.insert(schema.sessionSegments).values({
          id: `rem-${date}-${e}`, sessionId: `night-${date}`, stage: 'REM',
          startMs: night + (100 + e * 120 + i * 0.4) * 60_000, endMs: night + (110 + e * 120 + i * 0.4) * 60_000,
        }).run()
      }
    }

    const { stageTiming } = (await get(harness, token, `/night/${NIGHT}`)).json()
    expect(stageTiming.firstDeep.value).toBe(53)
    expect(stageTiming.firstDeepAtMs).toBe(start + 52.6 * 60_000)
    expect(stageTiming.firstRem.value).toBe(173)
    expect(stageTiming.firstRemAtMs).toBe(start + 172.6 * 60_000)
    expect(stageTiming.cycles.value).toBe(1)
    for (const key of ['firstDeep', 'firstRem', 'cycles']) {
      expect(stageTiming[key].baseline, key).not.toBeNull()
      expect(Number.isInteger(stageTiming[key].baseline.center), `${key} centre`).toBe(true)
    }
  })

  // Each strip day is judged against its own day's band, and re-judged on the wire as the headline
  // is: the day before sits at 400.2 under a band of 400.4 flat, below it unrounded, and both are
  // 400 as sent, so the dot must say within or it contradicts the numbers beside it.
  it('re-judges a strip day on its rounded value and band', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let i = 2; i <= 70; i += 1) seedDaily(harness, shiftLocalDate(NIGHT, -i), 'sleep_asleep_minutes', 'sum', 400.4)
    seedDaily(harness, shiftLocalDate(NIGHT, -1), 'sleep_asleep_minutes', 'sum', 400.2)
    seedNight(harness, NIGHT, 420)

    const body = (await get(harness, token, `/night/${NIGHT}`)).json()
    const dayBefore = (body.figures.asleep.strip as { localDate: string, value: number, band: { thin: boolean }, standing: string }[])
      .find((d) => d.localDate === shiftLocalDate(NIGHT, -1))!
    expect(dayBefore.value).toBe(400)
    expect(dayBefore.band).toMatchObject({ center: 400, low: 400, high: 400, thin: false })
    expect(dayBefore.standing).toBe('within')
  })

  // The trace figures and the morning's resting heart rate and HRV are page figures like the rest,
  // so they reach the wire judged and rounded rather than as bare numbers.
  it('sends the lowest heart rate and the morning\'s resting heart rate judged, at catalogue precision', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let i = 1; i <= 60; i += 1) seedDaily(harness, shiftLocalDate(NIGHT, -i), 'resting_heart_rate', 'last', i % 2 === 0 ? 50.4 : 52.4)
    seedNight(harness, NIGHT, 420)
    seedDaily(harness, NIGHT, 'resting_heart_rate', 'last', 60.3)
    insertSample(harness.app.haelan.instance.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(NIGHT, '03:00'), tzOffsetMinutes: OFFSET, value: 52.6,
    })

    const body = (await get(harness, token, `/night/${NIGHT}`)).json()
    expect(body.morning.restingHeartRate).toMatchObject({ value: 60, direction: 'down', standing: 'above', judged: 'worse' })
    expect(body.traces.heartRate.lowestFigure).toMatchObject({ metric: 'heart_rate', value: 53, direction: 'down' })
    expect(body.traces.heartRate).not.toHaveProperty('usualLowest')
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedNight(harness, NIGHT, 420)
    const first = await get(harness, token, `/night/${NIGHT}`)
    expect(first.statusCode).toBe(200)
    harness.clock.nowMs += 60_000
    const again = await get(harness, token, `/night/${NIGHT}`, { 'if-none-match': first.headers.etag as string })
    expect(again.statusCode).toBe(304)
  })
})

describe('GET /workout/:sessionId', () => {
  // The route reads through p1's own PersonQuery, so another person's session id is simply not
  // there: a 404 like any unknown id, and nothing of that session (its source) in the body.
  it('answers 404 for another person\'s session, and names nothing of it', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    seedSource(harness, 'wilma-watch-999', 'p2')
    seedRun(harness, { id: 'wilma-run', sourceId: 'wilma-watch-999', localDate: '2026-09-04', pace: 300, personId: 'p2' })
    const response = await get(harness, token, '/workout/wilma-run')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('no_such_session')
    expect(response.body).not.toContain('wilma-watch-999')
  })

  it('answers 404 for an unknown session', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const response = await get(harness, token, '/workout/nothing-here')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('no_such_session')
  })

  // Five earlier runs alternating 310.3 and 320.7 s/km make a band with a fractional centre and
  // spread; 300.4 sits well below it, which on a down-is-better pace is a better run.
  it('serves the judged figures rounded, and the workout day\'s log', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let i = 0; i < 5; i += 1) {
      seedRun(harness, { id: `run-${i}`, sourceId: 'watch', localDate: shiftLocalDate('2026-09-04', -3 * (5 - i)), pace: i % 2 === 0 ? 310.3 : 320.7 })
    }
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 300.4 })
    putNote(harness, '2026-09-04', 'hot out')
    putNote(harness, '2026-09-03', 'not this one')

    const response = await get(harness, token, '/workout/subject')
    expect(response.statusCode).toBe(200)
    const body = response.json()
    const { pace } = body.figures
    expect(pace.value).toBe(300)
    for (const n of [pace.baseline.center, pace.baseline.low, pace.baseline.high]) expect(Number.isInteger(n)).toBe(true)
    expect(pace.standing).toBe('below')
    expect(pace.judged).toBe('better')
    expect((pace.strip as { value: number }[]).map((p) => p.value)).toEqual([310, 321, 310, 321, 310, 300])
    expect(body.previous.values.pace).toBe(310)
    expect(body.log.note).toBe('hot out')
    expect(body.sourceId).toBe('watch')
  })

  // Speed is sent at its figure's two decimals, not whole: 6.543 m/s whole would be 7, a 2 km/h lie.
  it('sends the previous ride\'s speed at the speed figure\'s precision', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedRun(harness, { id: 'before', sourceId: 'watch', localDate: '2026-09-01', pace: 150, exerciseType: 'BIKING', metrics: { averageSpeedMillimetersPerSecond: 6543 } })
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 140, exerciseType: 'BIKING', metrics: { averageSpeedMillimetersPerSecond: 7000 } })
    const body = (await get(harness, token, '/workout/subject')).json()
    expect(body.previous.values.speed).toBe(6.54)
    expect(body.previous.values.pace).toBe(150)
  })

  // 330.4 and 320.2 against 300.1 and 290.3 is 30.1 s/km faster, sent as 30; the ceilings are
  // fractional only to prove they are rounded too.
  it('sends the split trend and the zone bounds as whole numbers', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 310, splitSeconds: [330.4, 320.2, 300.1, 290.3] })
    seedDaily(harness, '2026-09-04', 'heart_rate_zone_light_max_bpm', 'last', 113.4)
    seedDaily(harness, '2026-09-04', 'heart_rate_zone_moderate_max_bpm', 'last', 137)
    seedDaily(harness, '2026-09-04', 'heart_rate_zone_vigorous_max_bpm', 'last', 161.6)
    seedDaily(harness, '2026-09-04', 'heart_rate_zone_peak_max_bpm', 'last', 187)
    const body = (await get(harness, token, '/workout/subject')).json()
    expect(body.splitTrend).toEqual({ secondHalfFasterBySecondsPerKm: 30 })
    expect(body.zoneBounds).toEqual({ moderateMin: 113, vigorousMin: 137, peakMin: 162, max: 187 })
  })

  // Core takes each fall between whole-bpm readings, so every fall is whole, but their usual is
  // not: four earlier runs that fell 20 and one that fell 21 make a usual of 20.2 with a band that
  // ends near 20.65, and core calls the subject's 21 above it, a better recovery. On the wire the
  // band's top is 21, so the page must say within and claim no verdict, or it shows "21, better
  // than your usual 20 - 21".
  it('sends heart-rate recovery rounded, re-judged on the rounded numbers', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    const seedAfter = (localDate: string, bpms: readonly number[]) => bpms.forEach((bpm, i) => {
      for (const agg of ['min', 'mean', 'max'] as const) {
        insertSample(harness!.app.haelan.instance.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at(localDate, '07:29') + i * 60_000, tzOffsetMinutes: OFFSET, agg, value: bpm })
      }
    })
    for (let i = 0; i < 5; i += 1) {
      const localDate = shiftLocalDate('2026-09-04', -3 * (5 - i))
      seedRun(harness, { id: `run-${i}`, sourceId: 'watch', localDate, pace: 310 })
      seedAfter(localDate, [160, 150, i === 4 ? 139 : 140, 128.2])
    }
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 300 })
    seedAfter('2026-09-04', [160, 150, 139, 120.4])
    const { heartRateRecovery } = (await get(harness, token, '/workout/subject')).json()
    expect(heartRateRecovery.oneMinute).toMatchObject({ value: 21, baseline: { center: 20, low: 20, high: 21 }, standing: 'within', judged: null })
    expect(heartRateRecovery.twoMinutes).toMatchObject({ value: 40, baseline: { center: 32 }, standing: 'above', judged: 'better' })
  })

  it('sends the readings a recovery falls between in whole bpm, and none for a minute without one', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 300 })
    // The last full minute, the end's own minute, then only the minute one after it.
    for (const [i, bpm] of [160.4, 150, 139.6].entries()) {
      for (const agg of ['min', 'mean', 'max'] as const) {
        insertSample(harness.app.haelan.instance.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: at('2026-09-04', '07:29') + i * 60_000, tzOffsetMinutes: OFFSET, agg, value: bpm })
      }
    }
    const { heartRateRecovery } = (await get(harness, token, '/workout/subject')).json()
    expect(heartRateRecovery.readings).toEqual({ endBpm: 160, oneMinuteBpm: 140, twoMinutesBpm: null })
  })

  // The night before, its morning's recovery and resting heart rate, each at its own precision.
  it("sends the morning before rounded, the recovery by the glance's rule", async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 300 })
    for (let i = 0; i < 60; i += 1) {
      const localDate = shiftLocalDate('2026-09-04', -i)
      seedDaily(harness, localDate, 'daily_hrv', 'last', 40.37 + (i % 5))
      seedDaily(harness, localDate, 'resting_heart_rate', 'last', 55.4 + (i % 3))
      seedDaily(harness, localDate, 'sleep_bedtime_minutes', 'last', -30)
      if (i > 0) seedDaily(harness, localDate, 'sleep_asleep_minutes', 'sum', 420)
    }
    seedNight(harness, '2026-09-04', 410.4)
    const { before } = (await get(harness, token, '/workout/subject')).json()
    expect(before.night.asleep.value).toBe(410)
    expect(before.restingHeartRate.value).toBe(55)
    expect(before.recovery.restingHeartRate.value).toBe(55)
    expect(Number.isInteger(before.recovery.index.value)).toBe(true)
  })

  // 30 m every 10 s is 333.3 s/km, sent as 333; two rows a minute of 85.3 steps are 170.6, sent as 171.
  it('sends pace in whole seconds per km and cadence in whole steps per minute', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedRun(harness, { id: 'subject', sourceId: 'watch', localDate: '2026-09-04', pace: 300 })
    const startMs = at('2026-09-04', '07:00')
    const db = harness.app.haelan.instance.db
    const metresPerDegree = (6_371_000 * Math.PI) / 180
    db.insert(schema.sessionRoutes).values(Array.from({ length: 19 }, (_, i) => ({
      id: `subject-${i}`, sessionId: 'subject', ordinal: i, atMs: startMs + i * 10_000,
      latitude: 52 + (i * 30) / metresPerDegree, longitude: 5,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }))).run()
    for (let i = 0; i < 10; i += 1) {
      insertSample(db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: startMs + i * 30_000, tzOffsetMinutes: OFFSET, value: 85.3 })
    }
    const { through } = (await get(harness, token, '/workout/subject')).json()
    expect(through.pace.points.map((p: { value: number }) => p.value)).toEqual([333, 333, 333])
    // Every minute is 333.3 give or take a float's last digit, so which one is fastest is noise;
    // what is sent is whole, and one of the three.
    expect(through.pace.fastest.secondsPerKm).toBe(333)
    expect([0, 60, 120]).toContain(through.pace.fastest.elapsedSeconds)
    expect(through.cadence.points.map((p: { value: number }) => p.value)).toEqual([171, 171, 171, 171, 171])
  })

  // Three runs over one straight 6 km course at 3 m/s: the fastest kilometre is 333.33 s, the mile
  // 536.4, the 5 km 1666.67, and the two moving times are fractional; every one is sent whole.
  it('sends the same-route time and pace, the previous time and the efforts in whole seconds and metres', async () => {
    const h = await withServer()
    harness = h
    h.clock.nowMs = NOW_MS
    const token = await h.signIn()
    seedSource(h, 'watch')
    const db = h.app.haelan.instance.db
    const metresPerDegree = (6_371_000 * Math.PI) / 180
    const routed = (id: string, localDate: string, activeDuration: string, pace = 300) => {
      seedRun(h, { id, sourceId: 'watch', localDate, pace, activeDuration })
      const startMs = at(localDate, '07:00')
      db.insert(schema.sessionRoutes).values(Array.from({ length: 21 }, (_, i) => ({
        id: `${id}-${i}`, sessionId: id, ordinal: i, atMs: startMs + i * 100_000,
        latitude: 52 + (i * 300) / metresPerDegree, longitude: 5,
        altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
      }))).run()
    }
    routed('earlier', '2026-09-01', '1800.6s')
    routed('subject', '2026-09-04', '1700.4s', 300.4)
    const body = (await get(h, token, '/workout/subject')).json()
    expect(body.sameRoute.previous.seconds).toBe(1801)
    expect(body.sameRoute.time.value).toBe(1700)
    expect(body.sameRoute.time.strip.map((p: { value: number }) => p.value)).toEqual([1801, 1700])
    expect(body.sameRoute.time.baseline.center).toBe(1801)
    expect(body.efforts.km.seconds).toBe(333)
    expect(body.efforts.mile.seconds).toBe(536)
    expect(body.efforts.fiveK.seconds).toBe(1667)
    for (const key of ['km', 'mile', 'fiveK']) {
      expect(Number.isInteger(body.efforts[key].best.value)).toBe(true)
    }
    // The pace on the route at the pace figure's precision; where each stretch began in whole
    // metres (the mile's first window starts 190.66 m in); the earlier run's efforts, the bests
    // this one set itself against, in whole seconds.
    expect(body.sameRoute.pace.value).toBe(300)
    expect(body.sameRoute.pace.strip.map((p: { value: number }) => p.value)).toEqual([300, 300])
    expect(body.efforts.mile.fromMeters).toBe(191)
    expect(body.efforts.km.fromMeters).toBe(200)
    expect(body.efforts.km.previousBest).toMatchObject({ sessionId: 'earlier', value: 333 })
    expect(body.efforts.mile.previousBest.value).toBe(536)
    // The route the times come from stays on the server.
    expect(JSON.stringify(body)).not.toMatch(/latitude|longitude/)
  })

  // An alternate's id is an old link to a workout another source also recorded; the page answers
  // as the merged workout, the same one the list names, rather than 404ing on it.
  it('answers an alternate id with the merged workout it belongs to', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    for (const id of ['google', 'phone']) seedSource(harness, id)
    seedRun(harness, { id: 'google-run', sourceId: 'google', localDate: '2026-09-04', pace: 300 })
    seedRun(harness, { id: 'phone-run', sourceId: 'phone', localDate: '2026-09-04', pace: 300 })
    const response = await get(harness, token, '/workout/phone-run')
    expect(response.statusCode).toBe(200)
    expect(response.json().sessionId).toBe('google-run')
  })
})

describe('roundWorkoutFigure', () => {
  // A point just past the usual's edge before rounding sits on it after: core called it slower than
  // usual, and the sent pair (320 against a usual up to 320) says within, so the dot is re-judged.
  it('re-judges each strip point against the rounded usual, as it does the figure', () => {
    const baseline = { center: 310, low: 300.2, high: 320.3, thin: false }
    const figure = roundWorkoutFigure({
      key: 'pace', metric: 'pace', value: 320.4, unit: 'seconds_per_km', precision: 0, direction: 'down',
      baseline, standing: 'above', judged: 'worse',
      strip: [
        { sessionId: 'a', localDate: '2026-09-01', value: 330.2, standing: 'above', judged: 'worse' },
        { sessionId: 'b', localDate: '2026-09-04', value: 320.4, standing: 'above', judged: 'worse' },
      ],
    })
    expect(figure.strip.map((p) => [p.value, p.standing, p.judged])).toEqual([[330, 'above', 'worse'], [320, 'within', null]])
  })
})
