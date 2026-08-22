import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { runRollupJob, rollupRangeCapDays } from '../src/sync/runRollupJob.ts'
import { dailyRollupBody } from '../src/testing/payloads.ts'
import { daily } from '../src/db/schema/index.ts'

const DAY_MS = 86_400_000
let test: TestDatabase
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1') })
afterEach(() => test.cleanup())

// Records every range asked for, and answers each with one window on its first day.
function stubClient(asked: Array<{ from: string, to: string }>) {
  const bodies = new Map<string, string>()
  const client = {
    async dailyRollUpDataPoints(input: { fromLocalDate: string, toLocalDate: string }) {
      asked.push({ from: input.fromLocalDate, to: input.toLocalDate })
      const [year, month, day] = input.fromLocalDate.split('-').map(Number) as [number, number, number]
      const id = `raw-${input.fromLocalDate}`
      bodies.set(id, dailyRollupBody('totalCalories', [
        { date: { year, month, day }, value: { kcalSum: 2000 } },
      ]))
      return { payloadId: id }
    },
  }
  const archive = { getBody: (_personId: string, id: string) => bodies.get(id)! }
  return { client, archive }
}

const depsWith = (stub: ReturnType<typeof stubClient>) =>
  ({ db: test.db, client: stub.client, archive: stub.archive, now: () => 0 })

describe('rollup range caps', () => {
  // Measured: INVALID_ROLLUP_QUERY_DURATION carries maxDurationDays in its metadata.
  it('caps total-calories at fourteen days and floors at ninety', () => {
    expect(rollupRangeCapDays(dataTypeById('total-calories')!)).toBe(14)
    expect(rollupRangeCapDays(dataTypeById('floors')!)).toBe(90)
  })
})

describe('runRollupJob', () => {
  it('steps by the cap, contiguously and without overlap, because nothing paginates', async () => {
    const asked: Array<{ from: string, to: string }> = []
    const stub = stubClient(asked)
    await runRollupJob({
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: Date.UTC(2026, 6, 14), toMs: Date.UTC(2026, 7, 23), deps: depsWith(stub),
    })
    expect(asked).toHaveLength(3)
    for (const range of asked) {
      const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS
      expect(days, `${range.from} to ${range.to}`).toBeLessThanOrEqual(14)
      expect(days).toBeGreaterThan(0)
    }
    // Contiguous: each chunk's end is the next one's start, so no day is asked for twice and
    // none is skipped. A gap here is a day that silently never arrives.
    const ordered = [...asked].sort((a, b) => a.from.localeCompare(b.from))
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.from).toBe(ordered[i - 1]!.to)
  })

  it('writes one provider row per window the response carried', async () => {
    const stub = stubClient([])
    await runRollupJob({
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: Date.UTC(2026, 7, 20), toMs: Date.UTC(2026, 7, 23), deps: depsWith(stub),
    })
    const rows = test.db.select().from(daily).where(eq(daily.personId, 'p1')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      metric: 'total_calories', agg: 'sum', source: 'provider', coverage: null,
    })
  })

  it('is idempotent: a second walk over the same range writes no new rows', async () => {
    const stub = stubClient([])
    const input = {
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: Date.UTC(2026, 7, 20), toMs: Date.UTC(2026, 7, 23), deps: depsWith(stub),
    }
    await runRollupJob(input)
    await runRollupJob(input)
    expect(test.db.select().from(daily).where(eq(daily.personId, 'p1')).all()).toHaveLength(1)
  })

  it('takes from the limiter before every chunk, the same as runJob does per window', async () => {
    const stub = stubClient([])
    const takes: number[] = []
    const limiter = { take: async () => { takes.push(takes.length) } }
    const result = await runRollupJob({
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: Date.UTC(2026, 6, 14), toMs: Date.UTC(2026, 7, 23),
      deps: { ...depsWith(stub), limiter },
    })
    expect(takes).toHaveLength(result.chunks)
  })

  it('runs unrated when no limiter is given, since it is optional', async () => {
    const stub = stubClient([])
    await expect(runRollupJob({
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: Date.UTC(2026, 7, 20), toMs: Date.UTC(2026, 7, 23), deps: depsWith(stub),
    })).resolves.toMatchObject({ chunks: 1 })
  })

  // Reproduces the defect a millisecond-based step had: capMs subtracted from an absolute
  // instant crosses Amsterdam's spring forward (2026-03-29) unevenly, so converting back to a
  // civil date could yield a 15 day span for a 14 day cap. Stepping in civil dates instead
  // cannot do this, because a date carries no zone and every day is exactly one day long.
  it('keeps every chunk within the cap across a spring forward transition', async () => {
    const stub = stubClient([])
    const toMs = Date.parse('2026-04-01T00:30:00+02:00')
    const asked: Array<{ from: string, to: string }> = []
    const recordingClient = {
      async dailyRollUpDataPoints(input: { fromLocalDate: string, toLocalDate: string }) {
        asked.push({ from: input.fromLocalDate, to: input.toLocalDate })
        return stub.client.dailyRollUpDataPoints(input)
      },
    }
    await runRollupJob({
      personId: 'p1', dataType: dataTypeById('total-calories')!, timezone: 'Europe/Amsterdam',
      fromMs: toMs - 40 * DAY_MS, toMs, deps: { ...depsWith(stub), client: recordingClient },
    })
    expect(asked.length).toBeGreaterThan(0)
    for (const range of asked) {
      const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS
      expect(days, `${range.from} to ${range.to}`).toBeLessThanOrEqual(14)
    }
  })
})
