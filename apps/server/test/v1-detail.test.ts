import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, insertSample, schema, shiftLocalDate } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

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
  db.insert(schema.sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
  seedDaily(h, localDate, 'sleep_asleep_minutes', 'sum', asleep)
}

/** One exercise session in the attrs shape mapSessions stores, as the core workout-page test seeds one; pace in seconds per km. */
function seedRun(h: Harness, input: { id: string, sourceId: string, localDate: string, pace: number, personId?: string }): void {
  const startMs = at(input.localDate, '07:00')
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id: input.id, personId: input.personId ?? 'p1', sourceId: input.sourceId, kind: 'exercise', externalId: input.id,
    startMs, startOffsetMinutes: OFFSET, endMs: startMs + 30 * 60_000, endOffsetMinutes: OFFSET,
    localDate: input.localDate, rawPayloadId: null,
    attrs: JSON.stringify({
      type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
      splitSummaries: null, exerciseEvents: null, displayName: null, notes: null, routeConsentRequired: null,
      exerciseMetadata: { hasGps: false }, exerciseType: 'RUNNING',
      metricsSummary: { averagePaceSecondsPerMeter: input.pace / 1000 }, splits: null, activeDuration: null,
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
