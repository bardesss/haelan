import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DERIVATION_VERSION, insertSample, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

// The phone glance (M9d) parses what /glance, /glance/calendar and /quick-log/day send, and its
// parser tests read these bodies from apps/android's test resources rather than from JSON typed by
// hand. This file is what keeps them honest: it builds each body from a seeded person through the
// real routes and fails when a committed fixture differs from what the server now sends, so the
// Android fixtures cannot drift into a shape production never writes. After a deliberate change to
// a payload, rerun it with UPDATE_ANDROID_FIXTURES=1 to rewrite them, and commit both sides.
//
// The seed is synthetic throughout, round numbers chosen to exercise each field (a strip day above
// its band, an elevated respiratory rate, an unknown event kind), never a household's figures.

const FIXTURES = fileURLToPath(new URL('../../android/app/src/test/resources/glance/', import.meta.url))
const UPDATE = process.env.UPDATE_ANDROID_FIXTURES === '1'

/**
 * Compared as text, not as parsed JSON: a byte changed in the committed file is a drift like any
 * other, and a deep-equal would wave through an edit that happened to parse the same. LF only
 * (.gitattributes pins these files to it), so a Windows checkout compares the same bytes CI does.
 */
function matchesFixture(name: string, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  const path = `${FIXTURES}${name}`
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true })
    writeFileSync(path, text)
    return
  }
  expect(readFileSync(path, 'utf8'), `${name} differs from what the server sends; rerun with UPDATE_ANDROID_FIXTURES=1`).toBe(text)
}

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// 10:00Z is 12:00 in Europe/Amsterdam, every harness person's zone: today is 2026-08-20, half over.
const NOW = Date.parse('2026-08-20T10:00:00Z')
const TODAY = '2026-08-20'
const OFFSET = 120
const WRITE_HEADERS = { origin: 'http://localhost:4235', host: 'localhost:4235' }

function dateBefore(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
}

async function get(h: Harness, token: string, path: string): Promise<unknown> {
  const reply = await h.app.inject({ method: 'GET', url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}` } })
  expect(reply.statusCode, path).toBe(200)
  return reply.json()
}

async function send(h: Harness, token: string, method: 'PUT' | 'POST', path: string, payload: object): Promise<void> {
  const reply = await h.app.inject({
    method, url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}`, ...WRITE_HEADERS }, payload,
  })
  expect(reply.statusCode, path).toBe(200)
}

/**
 * Sixty days of every figure the glance reads, so each has a usual to be judged against; a night
 * for each of the last week with a staged one last night; step samples for today's pace; a few
 * minutes of heart rate today; and a run this morning.
 */
function seed(h: Harness): void {
  const db = h.app.haelan.instance.db
  db.insert(schema.sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
  const daily = (metric: string, agg: string, localDate: string, value: number) => db.insert(schema.daily).values({
    personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()

  for (let i = 0; i <= 60; i += 1) {
    const localDate = dateBefore(i)
    // A night is filed under the morning it ended, so today already has one; steps and active
    // minutes for today are the running day's so far.
    daily('sleep_asleep_minutes', 'sum', localDate, 420 + (i % 3) * 10)
    daily('sleep_efficiency', 'last', localDate, 90 + (i % 3))
    daily('sleep_bedtime_minutes', 'last', localDate, -60 + (i % 4) * 10)
    daily('sleep_waketime_minutes', 'last', localDate, 420 + (i % 3) * 10)
    daily('resting_heart_rate', 'last', localDate, 55 + (i % 3))
    daily('daily_hrv', 'last', localDate, 40 + (i % 5))
    // Today's respiratory rate rises above its usual, so the glance carries the figure at all.
    daily('respiratory_rate', 'last', localDate, i === 0 ? 17 : 14 + (i % 3) * 0.2)
    const steps = i === 0 ? 4000 : i === 3 ? 20000 : 8000 + (i % 5) * 500
    daily('steps', 'sum', localDate, steps)
    daily('active_minutes_light', 'sum', localDate, i === 0 ? 25 : 40 + (i % 4) * 5)
    // 06:00Z is 08:00 local, before today's cutoff, so every baseline day reaches the pace band.
    insertSample(db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: Date.parse(`${localDate}T06:00:00Z`), tzOffsetMinutes: OFFSET, value: i === 0 ? 1200 : 1000 + (i % 3) * 100 })
  }

  for (let i = 0; i < 7; i += 1) {
    const localDate = dateBefore(i)
    const endMs = Date.parse(`${localDate}T05:10:00Z`)
    const id = `night-${localDate}`
    db.insert(schema.sessions).values({
      id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
      startMs: endMs - 7 * 3_600_000 - 30 * 60_000, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET,
      localDate, attrs: JSON.stringify({}), rawPayloadId: null,
    }).run()
    if (i === 0) {
      const start = endMs - 7 * 3_600_000 - 30 * 60_000
      const stages: [string, number][] = [['LIGHT', 40], ['DEEP', 70], ['LIGHT', 90], ['REM', 60], ['AWAKE', 10], ['LIGHT', 100], ['REM', 80]]
      let at = start
      stages.forEach(([stage, minutes], n) => {
        db.insert(schema.sessionSegments).values({ id: `${id}-${n}`, sessionId: id, stage, startMs: at, endMs: at + minutes * 60_000 }).run()
        at += minutes * 60_000
      })
    }
  }

  for (let m = 0; m < 5; m += 1) {
    const utcMs = Date.parse(`${TODAY}T08:00:00Z`) + m * 60_000
    for (const [agg, value] of [['min', 58 + m], ['mean', 62 + m], ['max', 66 + m]] as const) {
      insertSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs, tzOffsetMinutes: OFFSET, agg, value })
    }
  }

  const runStart = Date.parse(`${TODAY}T06:15:00Z`)
  db.insert(schema.sessions).values({
    id: 'run-1', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 'run-1',
    startMs: runStart, startOffsetMinutes: OFFSET, endMs: runStart + 42 * 60_000, endOffsetMinutes: OFFSET,
    localDate: TODAY,
    // The provider's own mix of JSON types (workoutSummary.ts): numbers for calories and distance,
    // a string for the heart rate.
    attrs: JSON.stringify({
      exerciseType: 'RUNNING',
      metricsSummary: {
        caloriesKcal: 412, averageHeartRateBeatsPerMinute: '151', distanceMillimeters: 7_200_000,
        averagePaceSecondsPerMeter: 0.35, elevationGainMillimeters: 42_000,
      },
    }),
    rawPayloadId: null,
  }).run()
}

describe('the Android glance fixtures', () => {
  it('today.json, past-day.json and calendar.json are what the routes send a seeded person', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW
    const token = await harness.signIn()
    seed(harness)
    matchesFixture('today.json', await get(harness, token, '/glance'))
    matchesFixture('past-day.json', await get(harness, token, `/glance?day=${dateBefore(2)}`))
    matchesFixture('calendar.json', await get(harness, token, '/glance/calendar?month=2026-08'))
  })

  it('today-quick-log.json and day-log.json carry the log once quick logging is on', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW
    const token = await harness.signIn()
    seed(harness)
    harness.app.haelan.stores.people.setQuickLogEnabled('p1', true)
    await send(harness, token, 'PUT', `/moods/${TODAY}`, { score: 4 })
    await send(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: TODAY })
    await send(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: TODAY })
    await send(harness, token, 'PUT', `/notes/${TODAY}`, { body: 'Slept with the window open.' })
    // A kind no preset names still counts, under its own spelling (readDayLog's comment).
    await send(harness, token, 'POST', '/quick-log', { kind: 'sauna', day: dateBefore(1) })
    await send(harness, token, 'PUT', `/moods/${dateBefore(1)}`, { score: 2 })
    matchesFixture('today-quick-log.json', await get(harness, token, '/glance'))
    matchesFixture('day-log.json', await get(harness, token, `/quick-log/day/${dateBefore(1)}`))
  })

  it('empty.json is the glance of a person with no data at all', async () => {
    harness = await withServer()
    harness.clock.nowMs = NOW
    const token = await harness.signIn()
    matchesFixture('empty.json', await get(harness, token, '/glance'))
  })
})
