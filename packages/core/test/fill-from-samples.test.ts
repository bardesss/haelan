import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, seedPerson, insertSamples, seedOverride } from '../src/testing/fixtures.ts'
import type { TestDatabase, InsertSampleInput } from '../src/testing/fixtures.ts'
import { daily, sessions, sourcePriority, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { sampleTarget } from '../src/derive/targetKey.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readIntradayWindow } from '../src/query/intraday.ts'
import { workoutDetail, workoutSummary } from '../src/api/workoutSummary.ts'
import { sessionForRecords } from '../src/api/sessionRecords.ts'
import { zoneSecondsFromMinutes } from '../src/api/cardioLoad.ts'

// Itself, only watched: the cost test counts the intraday reads a list pays for.
vi.mock('../src/query/intraday.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/intraday.ts')>()
  return { ...actual, readIntradayWindow: vi.fn(actual.readIntradayWindow) }
})

const START = Date.parse('2026-09-20T07:00:00Z')
const MINUTE = 60_000
const END = START + 30 * MINUTE
const DATE = '2026-09-20'

/** The fifteen keys mapSessions writes, null where the payload did not carry the field. */
function attrsOf(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: null, mainSleep: null, stagesStatus: null, summary: null, metricsSummary: null,
    shortAwakenings: null, exerciseType: null, splits: null, splitSummaries: null,
    exerciseEvents: null, activeDuration: null, displayName: null, notes: null,
    exerciseMetadata: null, routeConsentRequired: null,
    ...fields,
  }
}

// What the companion stores for a treadmill run: its type and interval, nothing else.
const PHONE_TREADMILL = attrsOf({ exerciseType: 'TREADMILL' })
const GOOGLE_TREADMILL = attrsOf({
  exerciseType: 'TREADMILL',
  activeDuration: '1740s',
  metricsSummary: {
    caloriesKcal: 412, distanceMillimeters: 4_000_000, averageHeartRateBeatsPerMinute: '151', steps: '3900',
    heartRateZoneDurations: { lightTime: '300s', moderateTime: '900s' },
  },
  exerciseMetadata: { hasGps: false },
})

let t: TestDatabase
beforeEach(() => {
  t = createTestDatabase()
  seedPerson(t.db, 'p1')
  for (const id of ['google', 'phone', 'scale']) {
    t.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'app', createdAtMs: 0 }).run()
  }
  t.db.insert(sourcePriority).values([
    { personId: 'p1', metric: 'exercise', sourceId: 'google', rank: 0 },
    { personId: 'p1', metric: 'exercise', sourceId: 'phone', rank: 1 },
  ]).run()
  vi.mocked(readIntradayWindow).mockClear()
})
afterEach(() => t.cleanup())

const q = () => new PersonQuery(t.db, 'p1')

function insertSession(o: { id: string, sourceId: string, attrs: unknown, startMs?: number, endMs?: number, localDate?: string }) {
  t.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: o.sourceId, kind: 'exercise', externalId: o.id,
    startMs: o.startMs ?? START, startOffsetMinutes: 120, endMs: o.endMs ?? END, endOffsetMinutes: 120,
    localDate: o.localDate ?? DATE, attrs: JSON.stringify(o.attrs), rawPayloadId: null,
  }).run()
}

function seedZoneCeilings(localDate: string) {
  const ceilings = { light: 113, moderate: 137, vigorous: 162, peak: 187 }
  for (const [zone, value] of Object.entries(ceilings)) {
    t.db.insert(daily).values({
      personId: 'p1', localDate, metric: `heart_rate_zone_${zone}_max_bpm`, agg: 'last', source: 'merged', value,
      coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }
}

/** One reading a minute across the run from `sourceId`: heart rate 10 min light, 10 moderate, 10 vigorous. */
function seedSamples(sourceId = 'phone', startMs = START) {
  const rows: InsertSampleInput[] = []
  const at = (i: number) => startMs + i * MINUTE
  for (let i = 0; i < 30; i += 1) {
    const bpm = i < 10 ? 100 : i < 20 ? 120 : 150
    for (const agg of ['min', 'mean', 'max'] as const) {
      rows.push({ personId: 'p1', sourceId, metric: 'heart_rate', utcMs: at(i), tzOffsetMinutes: 120, agg, value: bpm })
    }
    rows.push({ personId: 'p1', sourceId, metric: 'steps', utcMs: at(i), tzOffsetMinutes: 120, value: 150 })
    rows.push({ personId: 'p1', sourceId, metric: 'distance', utcMs: at(i), tzOffsetMinutes: 120, value: 170_000 })
    rows.push({ personId: 'p1', sourceId, metric: 'active_energy', utcMs: at(i), tzOffsetMinutes: 120, value: 10 })
  }
  // A minute either side of the run: outside its interval, so never counted.
  rows.push({ personId: 'p1', sourceId, metric: 'steps', utcMs: startMs - MINUTE, tzOffsetMinutes: 120, value: 999 })
  rows.push({ personId: 'p1', sourceId, metric: 'steps', utcMs: startMs + 31 * MINUTE, tzOffsetMinutes: 120, value: 999 })
  insertSamples(t.db, rows)
}

describe('zoneSecondsFromMinutes', () => {
  const bounds = { moderateMin: 113, vigorousMin: 137, peakMin: 162, max: 187 }
  it('puts a reading at a zone\'s lower edge in that zone, and one just below it in the zone beneath', () => {
    const minutes = [112, 113, 136, 137, 161, 162, 187, 200].map((bpm) => ({ bpm }))
    expect(zoneSecondsFromMinutes(minutes, bounds)).toEqual({
      lightSeconds: 60, moderateSeconds: 120, vigorousSeconds: 120, peakSeconds: 180,
    })
  })

  it('answers four zeros for no readings', () => {
    expect(zoneSecondsFromMinutes([], bounds)).toEqual({ lightSeconds: 0, moderateSeconds: 0, vigorousSeconds: 0, peakSeconds: 0 })
  })
})

describe('fillFromSamples, through the merged reads', () => {
  it('fills a bare treadmill run from its own samples and marks it', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    seedZoneCeilings(DATE)

    const run = q().sessionById({ sessionId: 'phone-run' })!
    const summary = workoutSummary(run.attrs)
    expect(summary.steps).toBe(4500)
    expect(summary.distanceMeters).toBe(5100)
    expect(summary.caloriesKcal).toBe(300)
    expect(summary.averageHeartRateBpm).toBeCloseTo(123.33, 2)
    // Pace over elapsed time: 1,800 s over 5.1 km.
    expect(summary.paceSecondsPerKm).toBeCloseTo(1800 / 5.1, 6)
    expect(workoutDetail(run.attrs).zones).toEqual({ lightSeconds: 600, moderateSeconds: 600, vigorousSeconds: 600, peakSeconds: 0 })
    // Moving time stays unknown: pauses are.
    expect(workoutDetail(run.attrs).activeDurationSeconds).toBeNull()
    expect(q().cardioLoad({ sessionId: 'phone-run' })!.edwards).toBe(60)
    expect(run.attrs).toMatchObject({ filledFromSamples: true })
    expect([...(run.attrs as { filled: string[] }).filled].sort()).toEqual([
      'averageHeartRateBeatsPerMinute', 'averagePaceSecondsPerMeter', 'caloriesKcal', 'distanceMillimeters',
      'heartRateZoneDurations', 'steps',
    ])
    // The list row's rate is read again off the filled attrs.
    expect(run.rate).toEqual({ key: 'pace', unit: 'seconds_per_km', value: 353 })

    // The list answers the same filled row.
    const [listed] = q().sessions({ kind: 'exercise', from: DATE, to: DATE })
    expect(listed).toEqual(run)
  })

  it('fills a ride\'s speed rather than a pace', () => {
    insertSession({ id: 'phone-ride', sourceId: 'phone', attrs: attrsOf({ exerciseType: 'BIKING' }) })
    seedSamples()
    const ride = q().sessionById({ sessionId: 'phone-ride' })!
    expect((ride.attrs as { metricsSummary: Record<string, unknown> }).metricsSummary.averageSpeedMillimetersPerSecond).toBeCloseTo(5_100_000 / 1800, 6)
    expect(workoutSummary(ride.attrs).paceSecondsPerKm).toBeNull()
    expect(ride.rate).toEqual({ key: 'speed', unit: 'meters_per_second', value: 2.83 })
  })

  it('keeps the Google copy\'s values once the two have merged, and marks nothing', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })
    seedSamples()
    seedZoneCeilings(DATE)

    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(run.id).toBe('google-run')
    const summary = workoutSummary(run.attrs)
    expect(summary.steps).toBe(3900)
    expect(summary.distanceMeters).toBe(4000)
    expect(summary.averageHeartRateBpm).toBe(151)
    expect(workoutDetail(run.attrs).zones).toEqual({ lightSeconds: 300, moderateSeconds: 900, vigorousSeconds: null, peakSeconds: null })
    expect(run.attrs).not.toHaveProperty('filledFromSamples')
    expect(run.attrs).not.toHaveProperty('filled')
  })

  it('keeps the Google copy\'s values when the phone is ranked first', () => {
    t.db.delete(sourcePriority).run()
    t.db.insert(sourcePriority).values([
      { personId: 'p1', metric: 'exercise', sourceId: 'phone', rank: 0 },
      { personId: 'p1', metric: 'exercise', sourceId: 'google', rank: 1 },
    ]).run()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })
    seedSamples()

    const [run] = q().sessions({ kind: 'exercise', from: DATE, to: DATE })
    expect(run!.id).toBe('phone-run')
    expect(workoutSummary(run!.attrs).steps).toBe(3900)
    expect(run!.attrs).not.toHaveProperty('filledFromSamples')
  })

  it('leaves the zones unknown on a day without zone ceilings, and still fills the rest', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()

    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(workoutDetail(run.attrs).zones).toBeNull()
    expect(workoutSummary(run.attrs).averageHeartRateBpm).toBeCloseTo(123.33, 2)
    expect((run.attrs as { filled: string[] }).filled).not.toContain('heartRateZoneDurations')
  })

  it('answers a bare run with no samples at all unfilled and unmarked', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(run.attrs).toEqual(PHONE_TREADMILL)
  })

  it('sums one other source when the run\'s own source recorded nothing, never two added together', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples('google')
    // A second device with fewer readings over the same run: summed with the first, the steps would double.
    insertSamples(t.db, [{ personId: 'p1', sourceId: 'scale', metric: 'steps', utcMs: START, tzOffsetMinutes: 120, value: 50 }])

    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(workoutSummary(run.attrs).steps).toBe(4500)
  })

  it('reads the run\'s own source first, over another source with more readings', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples('google')
    insertSamples(t.db, [{ personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: START, tzOffsetMinutes: 120, value: 50 }])

    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(workoutSummary(run.attrs).steps).toBe(50)
  })

  it('leaves out a reading the person excluded', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    seedOverride(t.db, { personId: 'p1', scope: 'sample', targetKey: sampleTarget({ source: 'phone', metric: 'steps', utcMs: START + 5 * MINUTE }) })

    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(workoutSummary(run.attrs).steps).toBe(4350)
  })

  it('never lets a filled distance or climb set a record', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    const run = q().sessionById({ sessionId: 'phone-run' })!
    expect(workoutSummary(run.attrs).distanceMeters).toBe(5100)
    expect(sessionForRecords(run).distanceMm).toBeNull()

    const climbed = {
      ...run,
      attrs: { ...(run.attrs as object), metricsSummary: { elevationGainMillimeters: 50_000 }, filled: ['elevationGainMillimeters'] },
    }
    expect(sessionForRecords(climbed).elevationGainMeters).toBeNull()
    // The same values, recorded rather than filled, do count.
    const recorded = { ...run, attrs: { ...(run.attrs as object), metricsSummary: { distanceMillimeters: 5_100_000, elevationGainMillimeters: 50_000 }, filled: [] } }
    expect(sessionForRecords(recorded)).toMatchObject({ distanceMm: 5_100_000, elevationGainMeters: 50 })
  })

  it('costs intraday reads for the bare row alone, among many merged ones', () => {
    // Nine earlier runs, each a phone copy merged with its Google copy, one a day before the bare one.
    for (let d = 1; d <= 9; d += 1) {
      const startMs = START - d * 24 * 60 * MINUTE
      const localDate = `2026-09-${String(20 - d).padStart(2, '0')}`
      insertSession({ id: `phone-${d}`, sourceId: 'phone', attrs: PHONE_TREADMILL, startMs, endMs: startMs + 30 * MINUTE, localDate })
      insertSession({ id: `google-${d}`, sourceId: 'google', attrs: GOOGLE_TREADMILL, startMs, endMs: startMs + 30 * MINUTE, localDate })
      seedSamples('phone', startMs)
    }
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()

    const list = q().sessions({ kind: 'exercise', from: '2026-09-01', to: DATE })
    expect(list).toHaveLength(10)
    expect(list.filter((w) => (w.attrs as { filledFromSamples?: boolean }).filledFromSamples === true).map((w) => w.id)).toEqual(['phone-run'])
    // Steps, distance, energy and heart rate: one read each, all for the bare row.
    const calls = vi.mocked(readIntradayWindow).mock.calls
    expect(calls.map(([, input]) => input.metric).sort()).toEqual(['active_energy', 'distance', 'heart_rate', 'steps'])
    expect(calls.every(([, input]) => input.startMs === START && input.endMs === END)).toBe(true)
  })
})
