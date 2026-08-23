import { afterEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { replayPerson } from '../src/rebuild/replay.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { samples, sessions, sources } from '../src/db/schema/index.ts'
import { samplePoint, sleepPoint, dailyRollupBody, body } from '../src/testing/payloads.ts'

import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase
afterEach(() => { t.cleanup() })
const freshDb = (): TestDatabase['db'] => { t = createTestDatabase(); return t.db }

const listParams = { filter: 'x', pageSize: 1000, pageToken: null }

// Same envelope shape map-samples.test.ts uses for heart-rate: a list response whose points
// carry sampleTime and beatsPerMinute, and an explicit dataSource because the source registry
// derives a source's identity from it.
function pageWithBeats(beats: { atMs: number, bpm: number }[]): string {
  return body(beats.map((b) => samplePoint({
    payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(b.bpm),
    physicalTime: new Date(b.atMs).toISOString(),
    dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
  })))
}

// Same envelope shape map-rollups.test.ts uses for total-calories: rollupDataPoints keyed by
// civil date, with the payload's own value object nested under its payloadKey.
function rollupBody(localDate: string, kcal: number): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number]
  return dailyRollupBody('totalCalories', [{ date: { year, month, day }, value: { kcalSum: kcal } }])
}

// Same envelope shape map-sessions.test.ts uses for sleep: a list response whose one point
// carries an interval and a couple of stages.
function sleepBody(): string {
  return body([sleepPoint({
    startTime: '2026-08-17T21:30:00Z',
    endTime: '2026-08-18T05:15:00Z',
    stages: [
      { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T23:00:00Z' },
      { type: 'DEEP', startTime: '2026-08-17T23:00:00Z', endTime: '2026-08-18T00:30:00Z' },
    ],
  })])
}

describe('replayPerson', () => {
  test('a two page window downsamples once, not once per page', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two readings inside the same minute, split across the two pages of one window, from a
    // data type whose catalogue entry sets downsampleToMinute.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([{ atMs: 60_000, bpm: 60 }]),
    })
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: { ...listParams, pageToken: 'p2' },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 2, httpStatus: 200,
      body: pageWithBeats([{ atMs: 90_000, bpm: 80 }]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    // One minute, one row per aggregate. Replaying page by page would produce two sets.
    const rows = db.select().from(samples).where(eq(samples.personId, 'p1')).all()
    expect(new Set(rows.map((r) => r.utcMs)).size).toBe(1)
    expect(counts.samples).toBe(rows.length)
  })

  test('a rollup payload becomes provider daily rows, not samples', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'total-calories',
      requestParams: { range: { start: {}, end: {} } },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: rollupBody('2026-08-01', 2100),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.providerDaily).toBe(1)
    expect(counts.samples).toBe(0)
  })

  test('a session payload writes its sessions and segments', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: sleepBody(),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.sessions).toBe(1)
    expect(counts.segments).toBeGreaterThan(0)
    expect(db.select().from(sessions).all()).toHaveLength(1)
  })

  test('the source rows are created from the payloads, not assumed', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([{ atMs: 60_000, bpm: 60 }]),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(db.select().from(sources).where(eq(sources.personId, 'p1')).all()).toHaveLength(1)
  })

  test('a payload whose data type left the catalogue is counted, not thrown', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'retired-type', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200, body: '{}',
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.unmappable).toBe(1)
    expect(counts.samples).toBe(0)
  })

  test('the local dates the rows landed on come back', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([{ atMs: Date.parse('2026-08-01T10:00:00Z'), bpm: 60 }]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.localDates).toEqual(['2026-08-01'])
  })
})
