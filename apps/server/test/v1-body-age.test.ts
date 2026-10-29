import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import type { BodyAgeRead } from '@haelan/core'
import { roundBodyAge } from '../src/routes/v1/bodyAge.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The harness clock reads 2026-02-02 in Europe/Amsterdam, so these January days have all happened.
function seedBodyAge(h: Harness, personId: string, vo2: number): void {
  const { db } = h.app.haelan.instance
  db.update(schema.people).set({ birthDate: '1990-01-01', sex: 'male' }).where(eq(schema.people.id, personId)).run()
  const row = (localDate: string, metric: string, value: number) => db.insert(schema.daily).values({
    personId, localDate, metric, agg: 'last', source: 'merged', value, coverage: null, sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
  }).run()
  row('2026-01-20', 'daily_vo2_max', vo2)
  for (let day = 10; day <= 25; day += 1) row(`2026-01-${day}`, 'resting_heart_rate', 55.456)
}

describe('GET /p/:personId/body-age', () => {
  it('answers the current body age, the months and the method, rounded', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    seedBodyAge(harness, 'p1', 44.44)

    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/body-age', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as BodyAgeRead
    expect(body.current).toMatchObject({ enough: true, endDate: '2026-01-25' })
    expect(body.months.map((m) => m.month)).toEqual(['2026-01'])
    expect(body.method.windowDays).toBe(30)

    const current = body.current as Extract<BodyAgeRead['current'], { enough: true }>
    const vo2 = current.factors.find((f) => f.key === 'vo2Max')!
    const resting = current.factors.find((f) => f.key === 'restingHeartRate')!
    expect(vo2.value).toBe(44.4)
    expect(resting.value).toBe(55)
    // Every age and gap is a tenth, as printed.
    for (const n of [current.bodyAge, current.calendarAge, current.gap]) expect(n).toBe(Math.round(n * 10) / 10)
  })

  it('answers a repeat with If-None-Match as 304', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    seedBodyAge(harness, 'p1', 44.44)
    const headers = { authorization: `Bearer ${token}` }

    const first = await harness.app.inject({ method: 'GET', url: '/api/v1/p/p1/body-age', headers })
    const etag = first.headers.etag as string
    expect(etag).toBeTruthy()
    const second = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/body-age', headers: { ...headers, 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
  })

  it('answers an empty history for a person with no scored day', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/body-age', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ current: null, previous: null, months: [], pace: null, youngest: null })
  })
})

describe('roundBodyAge', () => {
  it('rounds the pace to hundredths and the months to tenths, and leaves the method alone', () => {
    const month = { month: '2026-01', endDate: '2026-01-25', bodyAge: 33.456, calendarAge: 36.04, gap: -2.584 }
    const method = { windowDays: 30 } as BodyAgeRead['method']
    const rounded = roundBodyAge({ current: null, previous: null, months: [month], pace: 0.98765, youngest: month, method })
    expect(rounded.pace).toBe(0.99)
    expect(rounded.months[0]).toMatchObject({ bodyAge: 33.5, calendarAge: 36, gap: -2.6 })
    expect(rounded.youngest).toEqual(rounded.months[0])
    expect(rounded.method).toBe(method)
  })

  it('never sends a negative zero', () => {
    const month = { month: '2026-01', endDate: '2026-01-25', bodyAge: 36, calendarAge: 36, gap: -0.04 }
    const rounded = roundBodyAge({ current: null, previous: null, months: [month], pace: null, youngest: month, method: {} as BodyAgeRead['method'] })
    expect(Object.is(rounded.months[0]!.gap, 0)).toBe(true)
  })
})
