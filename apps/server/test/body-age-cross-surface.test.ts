import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { DERIVATION_VERSION, PersonQuery, schema } from '@haelan/core'
import type { BodyAgeRead } from '@haelan/core'
import { bodyAgeTool } from '../src/mcp/tools/bodyAge.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The MCP tool and the route read the same body age. The tool runs against a PersonQuery exactly
 * as adapter.ts calls it; the route is driven over HTTP, rounded as the browser receives it. If
 * either rounded its own way, or the tool read a different day, these would part on the number.
 */

let h: Harness | null = null
afterEach(async () => { await h?.cleanup(); h = null })

describe('body_age: the MCP tool and the body age route agree', () => {
  it('answers the same body age, gap, pace, factors and day', async () => {
    h = await withServer()
    await h.completeSetup()
    const { db } = h.app.haelan.instance
    db.update(schema.people).set({ birthDate: '1990-01-01', sex: 'female' }).where(eq(schema.people.id, 'p1')).run()
    const row = (localDate: string, metric: string, value: number, agg = 'last') => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: null, sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    }).run()
    row('2026-01-05', 'daily_vo2_max', 36.37)
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-01-${String(day).padStart(2, '0')}`
      row(date, 'resting_heart_rate', 52.3 + (day % 3))
      row(date, 'active_minutes_moderate', 20 + (day % 4), 'sum')
      row(date, 'sleep_bedtime_minutes', 1370 + (day % 5) * 7)
    }
    const token = await h.signIn()

    const mcp = bodyAgeTool.run(new PersonQuery(db, 'p1'), {}) as {
      enough: boolean, asOf: string, bodyAge: number, calendarAge: number, gap: number, pace: number | null,
      carriedBy: string | null, factors: { key: string, value: number | null, years: number }[]
    }
    const response = await h.app.inject({
      method: 'GET', url: '/api/v1/p/p1/body-age', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const page = response.json() as BodyAgeRead
    const current = page.current as Extract<BodyAgeRead['current'], { enough: true }>

    expect(mcp.enough).toBe(true)
    expect(mcp.asOf).toBe('2026-01-28')
    expect(mcp.bodyAge).toBe(current.bodyAge)
    expect(mcp.calendarAge).toBe(current.calendarAge)
    expect(mcp.gap).toBe(current.gap)
    expect(mcp.pace).toBe(page.pace)
    expect(mcp.carriedBy).toBe(current.carriedBy)
    expect(mcp.factors.map((f) => [f.key, f.value, f.years]))
      .toEqual(current.factors.map((f) => [f.key, f.value, f.years]))
  })
})
