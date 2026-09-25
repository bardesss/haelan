import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
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

function row(h: Harness, input: { localDate: string, metric: string, value: number }): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: 'p1', localDate: input.localDate, metric: input.metric, agg: 'sum', source: 'merged',
    value: input.value, coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

describe('GET /api/v1/p/:personId/glance/calendar', () => {
  // today is 2026-08-20 throughout (08:00Z is 10:00 in Europe/Amsterdam).
  it('answers a month\'s days with their sleep and steps verdicts', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    // Sixty days of steady baseline ending the day before 08-05, so 08-05's own reading has a real
    // (non-thin) band to be judged against.
    for (let i = 1; i <= 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-04T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      row(harness, { localDate, metric: 'steps', value: 8000 })
      row(harness, { localDate, metric: 'sleep_asleep_minutes', value: 420 })
    }
    // A day that reached its usual steps and slept within its usual range.
    row(harness, { localDate: '2026-08-05', metric: 'steps', value: 8000 })
    row(harness, { localDate: '2026-08-05', metric: 'sleep_asleep_minutes', value: 420 })
    // A day that fell short of its usual steps and slept outside its usual range.
    row(harness, { localDate: '2026-08-06', metric: 'steps', value: 2000 })
    row(harness, { localDate: '2026-08-06', metric: 'sleep_asleep_minutes', value: 100 })

    const body = (await get(harness, token, '/glance/calendar?month=2026-08')).json()
    expect(body.month).toBe('2026-08')
    expect(body.firstDay).not.toBeNull()
    const byDate = new Map(body.days.map((d: { localDate: string }) => [d.localDate, d]))
    expect(byDate.get('2026-08-05')).toMatchObject({ sleep: 'within', steps: 'reached' })
    expect(byDate.get('2026-08-06')).toMatchObject({ sleep: 'outside', steps: 'below' })
  })

  // Task 19a's own rule, replayed for the calendar (M9c spec, "Server and data"): standing has to
  // be recomputed from the rounded numbers the route actually sends, not from core's unrounded
  // ones. sleep_asleep_minutes rounds to whole minutes; sixty days at 419.6 give an unrounded band
  // of [419.6, 419.6], and today's 419.8 sits unrounded-above that high (which would read 'outside'
  // on unrounded numbers) but both round to 420, so the rounded verdict must be 'within'.
  it('recomputes a day\'s verdict from the rounded numbers, not the unrounded ones', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    for (let i = 1; i <= 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-04T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      row(harness, { localDate, metric: 'sleep_asleep_minutes', value: 419.6 })
    }
    row(harness, { localDate: '2026-08-05', metric: 'sleep_asleep_minutes', value: 419.8 })

    const body = (await get(harness, token, '/glance/calendar?month=2026-08')).json()
    const day = body.days.find((d: { localDate: string }) => d.localDate === '2026-08-05')
    expect(day.sleep).toBe('within')
  })

  it('refuses a malformed month', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const reply = await get(harness, token, '/glance/calendar?month=2026-8')
    expect(reply.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ error: { kind: 'config' } })
  })

  it('refuses a month after the current one', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const reply = await get(harness, token, '/glance/calendar?month=2026-09')
    expect(reply.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ error: { kind: 'config' } })
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    row(harness, { localDate: '2026-08-05', metric: 'steps', value: 8000 })
    const first = await get(harness, token, '/glance/calendar?month=2026-08')
    expect(first.statusCode).toBe(200)
    const again = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/glance/calendar?month=2026-08',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': first.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)
  })
})
