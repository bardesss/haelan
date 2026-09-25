import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, insertSample, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /api/v1/p/:personId/glance', () => {
  it('answers the glance for the person\'s own today, in their own zone', async () => {
    harness = await withServer()
    // 23:30 UTC on 19 August is already 20 August in Europe/Amsterdam, every harness person's zone.
    // Set before signIn so the session's own expiry is stamped from the same instant the request
    // below runs at, rather than from the harness's default clock thirty-plus days earlier.
    harness.clock.nowMs = Date.parse('2026-08-19T23:30:00Z')
    const token = await harness.signIn()
    const reply = await get(harness, token, '/glance')
    expect(reply.statusCode).toBe(200)
    const body = reply.json()
    expect(body.today).toBe('2026-08-20')
    expect(body).toHaveProperty('recovery.index')
    expect(body).toHaveProperty('day.steps')
    expect(body).toHaveProperty('week')
    expect(body.week).toEqual({ steps: null, activeMinutes: null, asleep: null })
  })

  // The route rebuilds `day` to round its figures, and a rebuild that named its fields one by one
  // would drop any it did not know about. Today's workouts have nothing to round and must survive.
  it('carries today\'s workouts through, merged across the sources that recorded them', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T10:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    for (const id of ['google', 'phone']) {
      db.insert(schema.sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
    }
    const startMs = Date.parse('2026-08-20T06:00:00Z')
    for (const [id, sourceId] of [['google-run', 'google'], ['phone-run', 'phone']] as const) {
      db.insert(schema.sessions).values({
        id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
        startMs, startOffsetMinutes: 120, endMs: startMs + 30 * 60_000, endOffsetMinutes: 120,
        localDate: '2026-08-20', attrs: JSON.stringify({ exerciseType: 'RUNNING' }), rawPayloadId: null,
      }).run()
    }

    const body = (await get(harness, token, '/glance')).json()
    expect(body.day.workouts.map((w: { id: string, alternateIds: string[] }) => [w.id, w.alternateIds]))
      .toEqual([['google-run', ['phone-run']]])
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag, a minute later', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const first = await get(harness, token, '/glance')
    expect(first.statusCode).toBe(200)
    // A minute on, same day, same rows. Moving the clock is the point: anything time-of-request
    // in the hashed body would change the ETag, and the harness clock otherwise stands still.
    harness.clock.nowMs += 60_000
    const again = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/glance',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': first.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)
  })

  it('rounds every figure to its metric\'s catalogue precision, as /series and /intraday do', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    const row = (metric: string, localDate: string, value: number) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric, agg: 'sum', source: 'merged', value, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    // Sixty days alternating 1000.4 and 2000.9: a centre of 1500.65 and a fractional spread, so
    // the band's three numbers all arrive unrounded unless the route rounds them.
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      row('steps', localDate, i % 2 === 0 ? 1000.4 : 2000.9)
    }
    row('steps', '2026-08-20', 1234.6)
    row('active_minutes_light', '2026-08-20', 12.7)
    insertSample(db, {
      personId: 'p1', sourceId: 'w1', metric: 'heart_rate', utcMs: Date.parse('2026-08-20T07:30:00Z'),
      tzOffsetMinutes: 120, agg: 'mean', value: 64.4,
    })
    const body = (await get(harness, token, '/glance')).json()
    const { steps } = body.day
    expect(steps.value).toBe(1235)
    for (const n of [steps.baseline.center, steps.baseline.low, steps.baseline.high]) expect(Number.isInteger(n)).toBe(true)
    expect(steps.strip.at(-2).value).toBe(1000)
    expect(body.day.activeMinutes.value).toBe(13)
    expect(body.day.heartRate.points[0].mean).toBe(64)
  })

  // roundFigure rebuilds each strip day to round its value; a rebuild that named only `value`
  // would silently drop `standing`. roundGlance also rebuilds `recovery.restingHeartRate` through
  // `roundFigure`, so its own `standing` must survive the same way, not merely by luck of `...figure`.
  it('carries a strip day\'s standing through the route\'s rounding, and the recovery figure\'s own standing', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    const row = (metric: string, agg: string, localDate: string, value: number) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      if (localDate === '2026-08-18') continue
      row('steps', 'sum', localDate, 8000)
      row('resting_heart_rate', 'last', localDate, 55 + (i % 3))
    }
    // A day pushed above the steps band; today's resting heart rate back within its own.
    row('steps', 'sum', '2026-08-18', 20000)
    row('steps', 'sum', '2026-08-20', 8000)
    row('resting_heart_rate', 'last', '2026-08-20', 56)
    const body = (await get(harness, token, '/glance')).json()
    const stepsStrip = body.day.steps.strip as Array<{ localDate: string, standing: string | null }>
    expect(stepsStrip.find((d) => d.localDate === '2026-08-18')?.standing).toBe('above')
    expect(body.recovery.restingHeartRate.standing).toBe('within')
  })

  // Task 19a, item 3: standing is computed in core on unrounded numbers, but the route rounds the
  // band it sends; a value that only clears an unrounded high must not disagree with the rounded
  // band the reader is actually shown once both round to the same whole number.
  it('recomputes standing from the rounded numbers, so a value just above an unrounded high comes back within once both round the same', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    const row = (localDate: string, value: number) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric: 'resting_heart_rate', agg: 'last', source: 'merged', value, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    // Sixty days at 59.6: an unrounded high of 59.6 (spread 0), which rounds to 60. Today's 59.8 is
    // unrounded-above that high, but also rounds to 60 - the standing must follow the rounded pair.
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      row(localDate, 59.6)
    }
    row('2026-08-20', 59.8)
    const body = (await get(harness, token, '/glance')).json()
    expect(body.recovery.restingHeartRate.value).toBe(60)
    expect(body.recovery.restingHeartRate.baseline.high).toBe(60)
    expect(body.recovery.restingHeartRate.standing).toBe('within')
  })

  it('carries a steps pace once today has a step sample, rounded to a whole step', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    // 06:00Z at +02:00 is 08:00 local, before today's 09:00-local cutoff (07:00Z at +02:00), so
    // every baseline day's reading actually reaches the band - at 09:00Z it would land at 11:00
    // local, after the cutoff, and be excluded from every day's sum, leaving a vacuous band of
    // zeros that Number.isInteger passes on even with the route's rounding deleted.
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      insertSample(db, { personId: 'p1', sourceId: 'w1', metric: 'steps', utcMs: Date.parse(`${localDate}T06:00:00Z`), tzOffsetMinutes: 120, value: 1000.4 })
      db.insert(schema.daily).values({
        personId: 'p1', localDate, metric: 'steps', agg: 'sum', source: 'merged', value: 1000.4, coverage: 1, sourceMix: null,
        derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
      }).run()
    }
    insertSample(db, { personId: 'p1', sourceId: 'w1', metric: 'steps', utcMs: Date.parse('2026-08-20T07:00:00Z'), tzOffsetMinutes: 120, value: 500 })
    db.insert(schema.daily).values({
      personId: 'p1', localDate: '2026-08-20', metric: 'steps', agg: 'sum', source: 'merged', value: 500, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    const body = (await get(harness, token, '/glance')).json()
    expect(body.day.stepsPace).not.toBeNull()
    // Every baseline day's own 1000.4 reaches the band unrounded; 1000 is what the route's own
    // rounding at 'steps' precision must produce, not merely "some integer".
    expect(body.day.stepsPace.center).toBe(1000)
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag, once a steps pace is present', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    // 06:00Z at +02:00 is 08:00 local, before today's 09:00-local cutoff, so every baseline day's
    // reading reaches the band. Today's own sample is later, so its pace has something to compare.
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      insertSample(db, { personId: 'p1', sourceId: 'w1', metric: 'steps', utcMs: Date.parse(`${localDate}T06:00:00Z`), tzOffsetMinutes: 120, value: 1000 })
      db.insert(schema.daily).values({
        personId: 'p1', localDate, metric: 'steps', agg: 'sum', source: 'merged', value: 1000, coverage: 1, sourceMix: null,
        derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
      }).run()
    }
    insertSample(db, { personId: 'p1', sourceId: 'w1', metric: 'steps', utcMs: Date.parse('2026-08-20T07:00:00Z'), tzOffsetMinutes: 120, value: 500 })
    db.insert(schema.daily).values({
      personId: 'p1', localDate: '2026-08-20', metric: 'steps', agg: 'sum', source: 'merged', value: 500, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    const first = await get(harness, token, '/glance')
    expect(first.statusCode).toBe(200)
    expect(first.json().day.stepsPace).not.toBeNull()
    harness.clock.nowMs += 60_000
    const again = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/glance',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': first.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)
  })

  it('names a stale source that fed the figure before it went quiet, by the name the person gave it', async () => {
    harness = await withServer()
    // Set before signIn for the same reason the first case does.
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'FITBIT', kind: 'device', createdAtMs: 0 }).run()
    db.insert(schema.sources).values({ id: 'ph', personId: 'p1', externalId: 'ph', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
    harness.app.haelan.instance.sourceAliases.put({ personId: 'p1', sourceId: 'w1', alias: 'My watch', nowMs: harness.clock.nowMs })
    const row = (localDate: string, source: string, sourceMix: string | null) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric: 'steps', agg: 'sum', source, value: 1000, coverage: 1, sourceMix,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    const mix = (...ids: string[]) => JSON.stringify(ids.map((source) => ({ source, share: 1 / ids.length })))
    // The shape derivation writes when a device stops: the watch and the phone both report through
    // July, and each day's merged row names both; from August on only the phone reports, and the
    // merged rows name only it. Nothing in the last week mentions the watch.
    //
    // The watch also measures heart rate and the phone does not. Without that the phone would
    // carry on with everything the watch reported, which is a renamed device rather than a dead
    // one, and no card warns about it (core's sourceActivity.ts, `continuedElsewhere`).
    for (let d = 1; d <= 31; d += 1) {
      const localDate = `2026-07-${String(d).padStart(2, '0')}`
      db.insert(schema.daily).values({
        personId: 'p1', localDate, metric: 'heart_rate', agg: 'mean', source: 'w1', value: 60, coverage: 1, sourceMix: null,
        derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
      }).run()
      row(localDate, 'w1', null)
      row(localDate, 'ph', null)
      row(localDate, 'merged', mix('w1', 'ph'))
    }
    for (let d = 1; d <= 20; d += 1) {
      const localDate = `2026-08-${String(d).padStart(2, '0')}`
      row(localDate, 'ph', null)
      row(localDate, 'merged', mix('ph'))
    }
    const body = (await get(harness, token, '/glance')).json()
    // Exactly the watch: the phone fed the same figure and is still reporting.
    expect(body.day.steps.staleSources).toEqual([expect.objectContaining({ sourceId: 'w1', name: 'My watch' })])
  })
})

// Task 4 (M9c: day navigation): `?day=` asks for a finished day instead of today. today is
// 2026-08-20 throughout (08:00Z is 10:00 in Europe/Amsterdam); steps is seeded every day from
// 2026-08-01 (the first day with data) through 2026-08-19, except 2026-08-10, a deliberate gap
// the 404 case below reads back through `nearest`.
describe('GET /api/v1/p/:personId/glance?day=', () => {
  const FIRST_DAY = '2026-08-01'
  const GAP_DAY = '2026-08-10'

  async function seedDays(h: Harness): Promise<void> {
    const db = h.app.haelan.instance.db
    for (let d = 1; d <= 19; d += 1) {
      const localDate = `2026-08-${String(d).padStart(2, '0')}`
      if (localDate === GAP_DAY) continue
      db.insert(schema.daily).values({
        personId: 'p1', localDate, metric: 'steps', agg: 'sum', source: 'merged', value: 8000, coverage: 1, sourceMix: null,
        derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
      }).run()
    }
  }

  it('answers a past day with data as a finished day, today naming that day', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, '/glance?day=2026-08-18')
    expect(reply.statusCode).toBe(200)
    const body = reply.json()
    expect(body.finished).toBe(true)
    expect(body.today).toBe('2026-08-18')
    expect(body.nav).toEqual({ previous: '2026-08-17', next: '2026-08-19' })
  })

  it('leaves today unfinished when no day is given', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const body = (await get(harness, token, '/glance')).json()
    expect(body.finished).toBe(false)
    expect(body.today).toBe('2026-08-20')
  })

  it('refuses a day in the future', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, '/glance?day=2026-08-21')
    expect(reply.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ error: { kind: 'config' } })
  })

  it('refuses a day before the first day with data', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, `/glance?day=2026-07-31`)
    expect(reply.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ error: { kind: 'config' } })
  })

  it.each(['2026-9-1', 'abc'])('refuses a malformed day %s', async (day) => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, `/glance?day=${day}`)
    expect(reply.statusCode).toBe(400)
  })

  it('answers 404 with the nearest earlier day when the requested day is a gap', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, `/glance?day=${GAP_DAY}`)
    expect(reply.statusCode).toBe(404)
    expect(reply.json()).toEqual({ nearest: '2026-08-09' })
  })

  it('answers 304 to a repeat request for a finished day, carrying the first one\'s ETag', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const first = await get(harness, token, '/glance?day=2026-08-18')
    expect(first.statusCode).toBe(200)
    const again = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/glance?day=2026-08-18',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': first.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)
  })

  it('judges a finished day\'s whole-day steps against the whole-day baseline, with no pace', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const body = (await get(harness, token, '/glance?day=2026-08-18')).json()
    expect(body.day.stepsPace).toBeNull()
    expect(body.day.steps.value).toBe(8000)
    expect(body.day.steps.partial).toBe(false)
  })

  // FIRST_DAY itself always has data (it is defined as the earliest day that does), so this proves
  // the gate compares against it rather than merely refusing everything before today.
  it('allows the first day with data itself', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    await seedDays(harness)
    const reply = await get(harness, token, `/glance?day=${FIRST_DAY}`)
    expect(reply.statusCode).toBe(200)
    expect(reply.json().finished).toBe(true)
  })
})
