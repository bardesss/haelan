import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions, sessionSegments } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readNightPage } from '../src/query/nightPage.ts'
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
  test.db.insert(sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
  seedDaily(localDate, 'sleep_asleep_minutes', 'sum', v.asleep ?? 420)
  if (v.deep !== undefined) seedDaily(localDate, 'sleep_deep_minutes', 'sum', v.deep)
  if (v.light !== undefined) seedDaily(localDate, 'sleep_light_minutes', 'sum', v.light)
  if (v.rem !== undefined) seedDaily(localDate, 'sleep_rem_minutes', 'sum', v.rem)
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
  })

  it('pairs the night with the day before it, and steps to the neighbouring nights', () => {
    seedNight('2026-09-04', {}); seedNight(NIGHT, {}); seedNight('2026-09-08', {})
    seedDaily('2026-09-05', 'steps', 'sum', 11240)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.day.localDate).toBe('2026-09-05')
    expect(page.day.steps.value).toBe(11240)
    expect(page.nav).toEqual({ previous: '2026-09-04', next: '2026-09-08' })
  })

  it('files a night begun after midnight under its wake date, and still pairs it with the day before', () => {
    seedNight(NIGHT, { startLocal: '00:30', endLocal: '07:10' })
    seedDaily('2026-09-05', 'steps', 'sum', 9000)
    const page = readNightPage(q(), input(NIGHT))!
    expect(page.localDate).toBe(NIGHT)
    expect(page.day.localDate).toBe('2026-09-05')
    expect(page.day.steps.value).toBe(9000)
  })
})
