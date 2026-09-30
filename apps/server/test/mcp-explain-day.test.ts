import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { and, eq, gt, lte } from 'drizzle-orm'
import { PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, shiftLocalDate } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { explainTool } from '../src/mcp/tools/explain.ts'
import { insertSession } from './mcp-fixtures.ts'

interface DayEvidence {
  figures: { key: string, standing: string | null }[] | null
  stoppedSources: { sourceId: string, lastReportedDate: string }[] | null
  hrvFilled: boolean | null
  away: string | null
  factor: { value: number | null } | null
  workouts: { sessionId: string }[] | null
  eventIds: string[] | null
}

interface Answer { kind: string, finding: string, stoppedAt: string, walked: string[], evidence: DayEvidence }

const D = '2026-08-20'
const TODAY = '2026-08-22'
const H = 3_600_000
const CLAIM_WORDS = /\b(because|caused?|causes|should|recommend\w*|ready|readiness|risk\w*|advice|diagnos\w*)\b/i

type Metric = 'rhr' | 'hrv' | 'steps' | 'vigorous' | 'asleep' | 'bedtime'

// Each reading's metric, aggregate, centre and wobble. The sine is the fixtures' own, unaligned with
// any week, so every 60-day baseline has a real spread; D and the day before sit at the centre
// unless a test says otherwise, so nothing is away from its usual by accident of the wave.
const READINGS: Record<Metric, { metric: string, agg: string, centre: number, amplitude: number }> = {
  rhr: { metric: 'resting_heart_rate', agg: 'last', centre: 55, amplitude: 2 },
  hrv: { metric: 'daily_hrv', agg: 'last', centre: 50, amplitude: 4 },
  steps: { metric: 'steps', agg: 'sum', centre: 8000, amplitude: 1500 },
  vigorous: { metric: 'active_minutes_vigorous', agg: 'sum', centre: 10, amplitude: 5 },
  asleep: { metric: 'sleep_asleep_minutes', agg: 'sum', centre: 420, amplitude: 20 },
  bedtime: { metric: 'sleep_bedtime_minutes', agg: 'last', centre: 1380, amplitude: 15 },
}

describe('explain, kind day', () => {
  let test: TestDatabase
  let q: PersonQuery

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'UTC' })
    for (const id of ['watch', 'phone']) {
      test.db.insert(schema.sources).values({ id, personId: 'robin', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
    }
    q = new PersonQuery(test.db, 'robin')
  })
  afterEach(() => test.cleanup())

  function daily(localDate: string, metric: string, agg: string, value: number, source = 'merged', sourceMix: string | null = null): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate, metric, agg, source, value, coverage: 1, sourceMix, derivationVersion: DERIVATION_VERSION,
    }).run()
  }

  /**
   * `days` days of every reading ending on D, the night of D filed under it. `on` sets a reading on
   * D, `yesterday` on the day before, and `without` leaves a reading out of D itself.
   */
  function seed(o: { days?: number, on?: Partial<Record<Metric, number>>, yesterday?: Partial<Record<Metric, number>>, without?: Metric[] } = {}): void {
    const days = o.days ?? 70
    for (let i = 0; i < days; i += 1) {
      const date = shiftLocalDate(D, -(days - 1 - i))
      for (const [name, r] of Object.entries(READINGS) as [Metric, typeof READINGS[Metric]][]) {
        if (date === D && o.without?.includes(name)) continue
        const pinned = date === D ? o.on?.[name] ?? r.centre : date === shiftLocalDate(D, -1) ? o.yesterday?.[name] ?? r.centre : null
        daily(date, r.metric, r.agg, pinned ?? r.centre + r.amplitude * Math.sin(i * 0.37))
      }
    }
    const bed = Date.parse(`${shiftLocalDate(D, -1)}T23:00:00Z`)
    insertSession(test.db, 'night', 'robin', 'watch', 'sleep', bed, bed + 7 * H, D)
  }

  function explain(): Answer {
    const raw = explainTool.run(q, { kind: 'day', localDate: D, today: TODAY }) as Omit<Answer, 'evidence'> & {
      evidence: { empty: unknown, recovery: unknown, workout: unknown, day: DayEvidence }
    }
    expect(raw.kind).toBe('day')
    expect([raw.evidence.empty, raw.evidence.recovery, raw.evidence.workout]).toEqual([null, null, null])
    expect(raw.finding).not.toMatch(CLAIM_WORDS)
    expect(raw.walked.at(-1)).toBe(raw.stoppedAt)
    return { ...raw, evidence: raw.evidence.day }
  }

  it('refuses a day that is not over, and needs today', () => {
    seed()
    expect(() => explainTool.run(q, { kind: 'day', localDate: TODAY, today: TODAY })).toThrow(/only a finished day is explained/)
    expect(() => explainTool.run(q, { kind: 'day', localDate: D })).toThrow(/kind 'day' needs today/)
    expect(() => explainTool.run(q, { kind: 'recovery', localDate: D, today: TODAY })).toThrow(/kind 'recovery' takes no today/)
  })

  it('stops at dayEmpty when nothing arrived that day', () => {
    seed()
    const answer = explainTool.run(q, { kind: 'day', localDate: shiftLocalDate(D, 1), today: TODAY }) as unknown as Answer
    expect(answer.stoppedAt).toBe('dayEmpty')
    expect(answer.walked).toEqual(['dayEmpty'])
  })

  it('stops at sourceStopped when a source feeding the day had stopped before it', () => {
    // As glance.test.ts seeds a dead watch: device rows and a merged mix naming it for a month,
    // then only the phone; and a metric the phone never reports, so the watch did not simply move.
    // And no resting heart rate on D itself: a stopped source is most often why a value is missing,
    // so the gate reads every figure's sources, not only those with a value.
    seed({ without: ['rhr'] })
    const mix = (...ids: string[]) => JSON.stringify(ids.map((source) => ({ source, share: 1 / ids.length })))
    const lastWatch = shiftLocalDate(D, -21)
    for (let i = 0; i < 30; i += 1) {
      const date = shiftLocalDate(D, -50 + i)
      daily(date, 'resting_heart_rate', 'last', 55, 'watch')
      daily(date, 'spo2', 'mean', 97, 'watch')
    }
    // The phone reports every day through today, so it is the one source still going.
    for (let date = shiftLocalDate(D, -50); date <= TODAY; date = shiftLocalDate(date, 1)) {
      daily(date, 'resting_heart_rate', 'last', 55, 'phone')
    }
    const merged = and(eq(schema.daily.source, 'merged'), eq(schema.daily.metric, 'resting_heart_rate'))
    test.db.update(schema.daily).set({ sourceMix: mix('watch', 'phone') }).where(and(merged, lte(schema.daily.localDate, lastWatch))).run()
    test.db.update(schema.daily).set({ sourceMix: mix('phone') }).where(and(merged, gt(schema.daily.localDate, lastWatch))).run()
    const answer = explain()
    expect(answer.stoppedAt).toBe('sourceStopped')
    expect(answer.walked).not.toContain('nothingAway')
    expect(answer.evidence.stoppedSources).toEqual([{ sourceId: 'watch', lastReportedDate: shiftLocalDate(D, -21) }])
  })

  it('does not stop on a source that stopped after the day', () => {
    // The watch reported through D itself and has been quiet since, so it is stale as of a much
    // later today; that says nothing about D, whose readings it fed.
    seed({ on: { rhr: 65 } })
    const later = shiftLocalDate(D, 40)
    for (let date = shiftLocalDate(D, -50); date <= later; date = shiftLocalDate(date, 1)) {
      if (date <= D) {
        daily(date, 'resting_heart_rate', 'last', 55, 'watch')
        daily(date, 'spo2', 'mean', 97, 'watch')
      }
      daily(date, 'resting_heart_rate', 'last', 55, 'phone')
    }
    // The merged rows name the watch through D, as derivation writes them, so the figure does see it.
    const mix = (...ids: string[]) => JSON.stringify(ids.map((source) => ({ source, share: 1 / ids.length })))
    const merged = and(eq(schema.daily.source, 'merged'), eq(schema.daily.metric, 'resting_heart_rate'))
    test.db.update(schema.daily).set({ sourceMix: mix('watch', 'phone') }).where(merged).run()
    const answer = explainTool.run(q, { kind: 'day', localDate: D, today: later }) as unknown as { stoppedAt: string, evidence: { day: DayEvidence } }
    const evidence = answer.evidence.day
    // The watch is stale as of `later`, which the fixture has to be for this to say anything; as of
    // D it was still reporting, and D is the day the glance judges staleness as of.
    expect(q.sourceActivity({ today: later }).find((a) => a.sourceId === 'watch')?.status).toBe('stale')
    expect(evidence.stoppedSources).toEqual([])
    expect(answer.stoppedAt).not.toBe('sourceStopped')
  })

  it('stops at hrvFilled before reading anything away from its usual', () => {
    seed({ on: { rhr: 65 }, without: ['hrv'] })
    daily(D, 'hrv', 'mean', 48)
    const answer = explain()
    expect(answer.stoppedAt).toBe('hrvFilled')
    expect(answer.evidence.hrvFilled).toBe(true)
    expect(answer.walked).not.toContain('nothingAway')
    expect(answer.evidence.away).toBeNull()
  })

  it('stops at thinBaselines when no reading has the history to judge', () => {
    seed({ days: 4, on: { rhr: 65 } })
    const answer = explain()
    expect(answer.stoppedAt).toBe('thinBaselines')
    expect(answer.finding).toContain('A thin baseline is low confidence, not evidence of nothing.')
  })

  it('stops at nothingAway when every reading sits within its usual', () => {
    seed()
    const answer = explain()
    expect(answer.stoppedAt).toBe('nothingAway')
    expect(answer.walked).toEqual(['dayEmpty', 'sourceStopped', 'hrvFilled', 'thinBaselines', 'nothingAway'])
    expect(answer.evidence.figures?.every((f) => f.standing === 'within')).toBe(true)
  })

  it('reports the night before beside a higher resting heart rate, before its bedtime', () => {
    // The bedtime is late too, so lateBedtime would answer; the fixed order looks at the night first.
    seed({ on: { rhr: 65, asleep: 300, bedtime: 1500 } })
    const answer = explain()
    expect(answer.evidence.away).toBe('restingHeartRate')
    expect(answer.stoppedAt).toBe('shortNight')
    expect(answer.walked).not.toContain('lateBedtime')
    expect(answer.finding).toMatch(/^Resting heart rate on 2026-08-20 was 65 bpm, above its usual \d+ bpm to \d+ bpm\. The night filed under that morning was 5h00 asleep, below its usual 6h\d\d asleep to 7h\d\d asleep\. The two are reported side by side as an association, not as the reason for it\.$/)
  })

  it('reports a late bedtime when the night itself was not short', () => {
    seed({ on: { rhr: 65, bedtime: 1500 } })
    const answer = explain()
    expect(answer.stoppedAt).toBe('lateBedtime')
    expect(answer.finding).toContain('Bedtime that night was 01:00, later than its usual')
  })

  it('reports the day before\'s vigorous minutes, before a logged event', () => {
    seed({ on: { rhr: 65 }, yesterday: { vigorous: 60 } })
    test.db.insert(schema.events).values({
      id: 'e1', personId: 'robin', kind: 'illness', localDate: D, startedAtMs: Date.parse(`${D}T08:00:00Z`),
      startedAtOffsetMinutes: 0, endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, createdAtMs: 0, updatedAtMs: 0,
    } as typeof schema.events.$inferInsert).run()
    const answer = explain()
    expect(answer.stoppedAt).toBe('heavyYesterday')
    expect(answer.walked).not.toContain('loggedEvent')
    expect(answer.evidence.factor?.value).toBe(60)
  })

  it('names a logged event without its free text', () => {
    seed({ on: { rhr: 65 } })
    test.db.insert(schema.events).values({
      id: 'e1', personId: 'robin', kind: 'illness-sentinel', localDate: D, startedAtMs: Date.parse(`${D}T08:00:00Z`),
      startedAtOffsetMinutes: 0, endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: 'note-sentinel', createdAtMs: 0, updatedAtMs: 0,
    } as typeof schema.events.$inferInsert).run()
    // And one the day before, which counts too: an evening's event is beside the next morning.
    test.db.insert(schema.events).values({
      id: 'e0', personId: 'robin', kind: 'illness-sentinel', localDate: shiftLocalDate(D, -1), startedAtMs: Date.parse(`${D}T08:00:00Z`) - 24 * H,
      startedAtOffsetMinutes: 0, endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, createdAtMs: 0, updatedAtMs: 0,
    } as typeof schema.events.$inferInsert).run()
    const answer = explain()
    expect(answer.stoppedAt).toBe('loggedEvent')
    expect([...answer.evidence.eventIds!].sort()).toEqual(['e0', 'e1'])
    expect(answer.finding).not.toMatch(/sentinel|illness/)
  })

  it('ends at noLivedFactor, naming what it looked at', () => {
    seed({ on: { rhr: 65 } })
    const answer = explain()
    expect(answer.stoppedAt).toBe('noLivedFactor')
    expect(answer.walked.slice(5)).toEqual(['shortNight', 'lateBedtime', 'heavyYesterday', 'loggedEvent', 'noLivedFactor'])
    expect(answer.finding).toContain('None of the night before, its bedtime, the day before\'s vigorous minutes or a logged event was away from its usual or on record.')
  })

  it('looks at no lived factor beside a reading on its other side', () => {
    // A short night is there, but beside a lower resting heart rate it is not looked at.
    seed({ on: { rhr: 45, asleep: 300 } })
    const answer = explain()
    expect(answer.evidence.away).toBe('restingHeartRate')
    expect(answer.stoppedAt).toBe('noLivedFactor')
    expect(answer.walked).not.toContain('shortNight')
    expect(answer.finding).toContain('No lived factor is looked at beside a reading on this side of its usual.')
  })

  it('looks for the away reading in the fixed order, the body readings before the night', () => {
    seed({ on: { hrv: 30, asleep: 300 } })
    const answer = explain()
    expect(answer.evidence.away).toBe('hrv')
    expect(answer.stoppedAt).toBe('shortNight')
  })

  it('reports a workout beside more steps than usual', () => {
    seed({ on: { steps: 20000 } })
    const start = Date.parse(`${D}T07:00:00Z`)
    insertSession(test.db, 'run', 'robin', 'watch', 'exercise', start, start + H, D, { exerciseType: 'RUNNING' })
    const answer = explain()
    expect(answer.evidence.away).toBe('steps')
    expect(answer.stoppedAt).toBe('workoutThatDay')
    expect(answer.finding).toContain('A workout (running) was recorded that day.')
  })
})
