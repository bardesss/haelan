import { describe, it, expect, afterEach } from 'vitest'
import { insertSample, schema } from '@haelan/core'
import { MAX_RANGE_DAYS } from '../src/routes/v1/shared.ts'
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

// Every test in this file reads back 2026-08-22 at Europe/Amsterdam's August offset, +120, which
// is what harness.completeSetup's person carries.
const OFFSET_MINUTES = 120

function seedSource(h: Harness, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

// One minute of heart rate for one source. Only `mean` is set, since none of these tests read
// min or max; a point is still well formed with the other two null.
function seedIntraday(h: Harness, input: {
  sourceId: string
  localHour: number
  minute?: number
  value: number
  metric?: string
}): void {
  seedSource(h, input.sourceId)
  const utcMs = Date.UTC(2026, 7, 22, input.localHour, input.minute ?? 0) - OFFSET_MINUTES * 60_000
  insertSample(h.app.haelan.instance.db, {
    personId: 'p1', sourceId: input.sourceId, metric: input.metric ?? 'heart_rate',
    utcMs, tzOffsetMinutes: OFFSET_MINUTES, agg: 'mean', value: input.value,
  })
}

let workoutCounter = 0
function seedWorkout(h: Harness, input: {
  localDate: string, sourceId?: string, exerciseType?: string, attrs?: unknown,
}): void {
  const sourceId = input.sourceId ?? 'watch'
  seedSource(h, sourceId)
  workoutCounter += 1
  const id = `workout-${workoutCounter}`
  const startMs = Date.parse(`${input.localDate}T09:00:00Z`) - OFFSET_MINUTES * 60_000
  const attrs = input.attrs ?? (input.exerciseType === undefined ? {} : { exerciseType: input.exerciseType })
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: OFFSET_MINUTES, endMs: startMs + 3_600_000, endOffsetMinutes: OFFSET_MINUTES,
    localDate: input.localDate, attrs: JSON.stringify(attrs), rawPayloadId: null,
  }).run()
}

describe('GET /intraday', () => {
  // Two devices in one minute are two points, not one blended reading. M3b-1 made that structural
  // and the route must not undo it by merging on the way out.
  it('returns a point per source, each carrying its sourceId', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedIntraday(harness, { sourceId: 'watch', localHour: 9, value: 60 })
    seedIntraday(harness, { sourceId: 'phone', localHour: 9, value: 61 })

    const points = (await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22')).json().points
    expect(points).toHaveLength(2)
    expect(points.map((p: { sourceId: string }) => p.sourceId).sort()).toEqual(['phone', 'watch'])
  })

  it('filters to one source when asked', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedIntraday(harness, { sourceId: 'watch', localHour: 9, value: 60 })
    seedIntraday(harness, { sourceId: 'phone', localHour: 9, value: 61 })

    const points = (await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22&source=watch')).json().points
    expect(points).toHaveLength(1)
    expect(points[0].sourceId).toBe('watch')
  })

  it('reports the reduction for a day that thinned', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let minute = 0; minute < 600; minute += 1) {
      seedIntraday(harness, { sourceId: 'watch', localHour: 6, minute, value: 60 + (minute % 5) })
    }
    const body = (await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22&points=100')).json()
    expect(body.points.length).toBeLessThanOrEqual(100)
    expect(body.reduction).toMatchObject({ method: 'minmax', from: 600 })
  })
})

describe('GET /sessions', () => {
  // A phone asking for a year of nights should not be handed a year of nights.
  it('caps a list at limit and hands back a cursor', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) seedWorkout(harness, { localDate: `2026-08-0${day}` })

    const body = (await get(harness, token, '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31&limit=2')).json()
    expect(body.items).toHaveLength(2)
    expect(typeof body.cursor).toBe('string')
  })

  it('resumes from a cursor without repeating or skipping a row', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) seedWorkout(harness, { localDate: `2026-08-0${day}` })
    const range = '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31'

    const whole = (await get(harness, token, range)).json().items
    const first = (await get(harness, token, `${range}&limit=2`)).json()
    const second = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(first.cursor)}`)).json()
    const third = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(second.cursor)}`)).json()

    // The union of the pages is the unpaged answer exactly. Asserting page lengths instead would
    // pass against a cursor that skipped a row and against one that repeated it.
    expect([...first.items, ...second.items, ...third.items]).toEqual(whole)
  })

  it('answers 400 for a kind that is not sleep or exercise', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/sessions?kind=Sleep&from=2026-08-01&to=2026-08-31')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // SESSION_KINDS (the schema's own validator) widened to include 'ecg' when the electrocardiogram
  // data type landed, so kind=ecg now passes that check - unlike kind=Sleep above, which the
  // schema itself refuses. This route still has to refuse it on its own: WorkoutSession has no
  // ECG-shaped response designed yet, and a route that let the validated value straight through
  // would silently start serving ECG sessions as workouts the day this test stopped protecting it.
  it('answers 400 for kind=ecg, a session kind the schema allows but this route does not serve', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/sessions?kind=ecg&from=2026-08-01&to=2026-08-31')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('filters to one source when asked', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, { localDate: '2026-08-01', sourceId: 'watch' })
    seedWorkout(harness, { localDate: '2026-08-02', sourceId: 'phone' })

    const body = (await get(harness, token, '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31&source=watch')).json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].sourceId).toBe('watch')
  })

  // source has to narrow before limit and cursor slice the page, not after: a filter applied to
  // an already paginated page would hand back fewer than `limit` rows even though more of that
  // source exist, and a cursor built against the unfiltered list would resume at the wrong row.
  // Interleaving the two sources by date is what would catch either mistake.
  it('pages a source scoped list to the same rows the unpaged source scoped read gives', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 9; day += 1) {
      seedWorkout(harness, {
        localDate: `2026-08-0${day}`, sourceId: day % 2 === 1 ? 'watch' : 'phone',
      })
    }
    const range = '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31&source=watch'

    const whole = (await get(harness, token, range)).json().items
    expect(whole).toHaveLength(5)
    expect(whole.every((s: { sourceId: string }) => s.sourceId === 'watch')).toBe(true)

    const first = (await get(harness, token, `${range}&limit=2`)).json()
    expect(first.items).toHaveLength(2)
    const second = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(first.cursor)}`)).json()
    const third = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(second.cursor)}`)).json()

    expect([...first.items, ...second.items, ...third.items]).toEqual(whole)
  })

  it('filters to one exercise type when asked', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, { localDate: '2026-08-01', exerciseType: 'RUNNING' })
    seedWorkout(harness, { localDate: '2026-08-02', exerciseType: 'BIKING' })

    const body = (await get(harness, token, '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31&type=RUNNING')).json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].localDate).toBe('2026-08-01')
  })

  it('answers 400 for an exercise type not in the catalogue', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31&type=NOT_A_REAL_TYPE')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // The list route is a different question from the detail route directly below it in
  // tier2.ts, and must not grow a per-row cardio load or a per-row filled split: either would
  // open a heart rate trace for every session in the range. Zone durations full enough to answer
  // 100 on the detail route (see v1-session-by-id.test.ts) are seeded here too, so a regression
  // that lifted the detail route's computation into the shared session mapper - rather than
  // adding it only in the detail handler - would still be caught. autoSplits/laps get the same
  // pin as cardioLoad, for the same reason and beside it, rather than in a test of their own.
  it('does not put a cardio load or filled splits on a session in the list', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, {
      localDate: '2026-08-01',
      attrs: {
        exerciseType: 'RUNNING',
        metricsSummary: {
          heartRateZoneDurations: {
            lightTime: '600s', moderateTime: '600s', vigorousTime: '600s', peakTime: '600s',
          },
        },
      },
    })

    const body = (await get(harness, token, '/sessions?kind=exercise&from=2026-08-01&to=2026-08-31')).json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].cardioLoad).toBeUndefined()
    expect(body.items[0].autoSplits).toBeUndefined()
    expect(body.items[0].laps).toBeUndefined()
  })
})

describe('GET /sleep/nights', () => {
  it('returns a night per source, each carrying its sourceId', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'watch')
    seedSource(harness, 'phone')
    const bedtime = Date.UTC(2026, 7, 21, 21, 0)
    for (const sourceId of ['watch', 'phone']) {
      harness.app.haelan.instance.db.insert(schema.sessions).values({
        id: `night-${sourceId}`, personId: 'p1', sourceId, kind: 'sleep', externalId: `night-${sourceId}`,
        startMs: bedtime, startOffsetMinutes: OFFSET_MINUTES, endMs: bedtime + 8 * 3_600_000,
        endOffsetMinutes: OFFSET_MINUTES, localDate: '2026-08-22', attrs: JSON.stringify({ mainSleep: true }),
        rawPayloadId: null,
      }).run()
    }

    const nights = (await get(harness, token, '/sleep/nights?from=2026-08-22&to=2026-08-22')).json().items
    expect(nights).toHaveLength(2)
    expect(nights.map((n: { sourceId: string }) => n.sourceId).sort()).toEqual(['phone', 'watch'])
  })

  it('resumes from a cursor without repeating or skipping a row', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'watch')
    for (let day = 1; day <= 5; day += 1) {
      const localDate = `2026-08-0${day}`
      const bedtime = Date.parse(`${localDate}T21:00:00Z`) - OFFSET_MINUTES * 60_000
      harness.app.haelan.instance.db.insert(schema.sessions).values({
        id: `night-${day}`, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: `night-${day}`,
        startMs: bedtime, startOffsetMinutes: OFFSET_MINUTES, endMs: bedtime + 8 * 3_600_000,
        endOffsetMinutes: OFFSET_MINUTES, localDate, attrs: JSON.stringify({ mainSleep: true }), rawPayloadId: null,
      }).run()
    }
    const range = '/sleep/nights?from=2026-08-01&to=2026-08-31'

    const whole = (await get(harness, token, range)).json().items
    const first = (await get(harness, token, `${range}&limit=2`)).json()
    const second = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(first.cursor)}`)).json()
    const third = (await get(harness, token, `${range}&limit=2&cursor=${encodeURIComponent(second.cursor)}`)).json()

    expect([...first.items, ...second.items, ...third.items]).toEqual(whole)
  })

  it('answers 400 for a range whose end precedes its start', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/sleep/nights?from=2026-08-31&to=2026-08-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // The same ceiling /trend carries, for the same reason: this route reads every session row in
  // range into JS before paginate slices a page out of it, so limit does not bound what the
  // request costs, only what it returns. The message has to name the limit.
  it('answers 400 rather than reading a range wider than the maximum into memory', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/sleep/nights?from=1900-01-01&to=2100-01-01&limit=1')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain(String(MAX_RANGE_DAYS))
  })
})
