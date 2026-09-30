import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, seedPerson, insertSamples, seedOverride } from '../src/testing/fixtures.ts'
import type { TestDatabase, InsertSampleInput } from '../src/testing/fixtures.ts'
import { credentials, daily, sessions, sessionSegments, sourcePriority, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { sampleTarget } from '../src/derive/targetKey.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readIntradayWindow } from '../src/query/intraday.ts'
import { workoutDetail, workoutSummary } from '../src/api/workoutSummary.ts'
import { sessionForRecords } from '../src/api/sessionRecords.ts'
import { zoneSecondsFromMinutes } from '../src/api/cardioLoad.ts'
import { readWorkoutPage } from '../src/query/workoutPage.ts'
import { readActivityPeriod } from '../src/query/activityPeriod.ts'
import { contextFor, readDay } from '../src/query/glance.ts'
import { readNightPage } from '../src/query/nightPage.ts'

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
  // The phone's externalId as describe() builds it for a companion upload (ingest.ts), Google's as
  // it builds one for a watch: only the first is a phone source.
  const externalIds: Record<string, string> = {
    google: 'FITBIT:Pixel Watch 3', phone: 'HEALTH_CONNECT:com.haelan.android', scale: 'HEALTH_CONNECT:com.scale.app',
  }
  for (const id of ['google', 'phone', 'scale']) {
    t.db.insert(sources).values({ id, personId: 'p1', externalId: externalIds[id]!, displayName: id, kind: 'app', createdAtMs: 0 }).run()
  }
  t.db.insert(sourcePriority).values([
    { personId: 'p1', metric: 'exercise', sourceId: 'google', rank: 0 },
    { personId: 'p1', metric: 'exercise', sourceId: 'phone', rank: 1 },
  ]).run()
  // A Google grant, as the connect flow leaves one: the household whose phone workouts have a
  // Google copy on its way. Never decrypted here, so the token need not be sealed.
  t.db.insert(credentials).values({
    personId: 'p1', refreshTokenEncrypted: 'sealed', grantedScopes: '', obtainedAtMs: 0, revokedAtMs: null,
  }).run()
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

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    const summary = workoutSummary(run.attrs)
    expect(summary.steps).toBe(4500)
    expect(summary.distanceMeters).toBe(5100)
    expect(summary.caloriesKcal).toBe(300)
    expect(summary.averageHeartRateBpm).toBe(123)
    // Pace over elapsed time: 1,800 s over 5.1 km.
    expect(summary.paceSecondsPerKm).toBeCloseTo(1800 / 5.1, 6)
    expect(workoutDetail(run.attrs).zones).toEqual({ lightSeconds: 600, moderateSeconds: 600, vigorousSeconds: 600, peakSeconds: 0 })
    // Moving time stays unknown: pauses are.
    expect(workoutDetail(run.attrs).activeDurationSeconds).toBeNull()
    expect(q().cardioLoad({ sessionId: 'phone-run', fill: true })!.edwards).toBe(60)
    expect(run.attrs).toMatchObject({ filledFromSamples: true, awaitingSummary: true })
    expect([...(run.attrs as { filled: string[] }).filled].sort()).toEqual([
      'averageHeartRateBeatsPerMinute', 'averagePaceSecondsPerMeter', 'caloriesKcal', 'distanceMillimeters',
      'heartRateZoneDurations', 'steps',
    ])
    // The list row's rate is read again off the filled attrs.
    expect(run.rate).toEqual({ key: 'pace', unit: 'seconds_per_km', value: 353, fromElapsed: true })

    // The list answers the same filled row.
    const [listed] = q().sessions({ kind: 'exercise', from: DATE, to: DATE, fill: true })
    expect(listed).toEqual(run)
  })

  it('fills a ride\'s speed rather than a pace', () => {
    insertSession({ id: 'phone-ride', sourceId: 'phone', attrs: attrsOf({ exerciseType: 'BIKING' }) })
    seedSamples()
    const ride = q().sessionById({ sessionId: 'phone-ride', fill: true })!
    expect((ride.attrs as { metricsSummary: Record<string, unknown> }).metricsSummary.averageSpeedMillimetersPerSecond).toBeCloseTo(5_100_000 / 1800, 6)
    expect(workoutSummary(ride.attrs).paceSecondsPerKm).toBeNull()
    expect(ride.rate).toEqual({ key: 'speed', unit: 'meters_per_second', value: 2.83, fromElapsed: true })
  })

  it('keeps the Google copy\'s values once the two have merged, and marks nothing', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })
    seedSamples()
    seedZoneCeilings(DATE)

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(run.id).toBe('google-run')
    const summary = workoutSummary(run.attrs)
    expect(summary.steps).toBe(3900)
    expect(summary.distanceMeters).toBe(4000)
    expect(summary.averageHeartRateBpm).toBe(151)
    expect(workoutDetail(run.attrs).zones).toEqual({ lightSeconds: 300, moderateSeconds: 900, vigorousSeconds: null, peakSeconds: null })
    expect(run.attrs).not.toHaveProperty('filledFromSamples')
    expect(run.attrs).not.toHaveProperty('filled')
    expect(run.attrs).not.toHaveProperty('awaitingSummary')
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

    const [run] = q().sessions({ kind: 'exercise', from: DATE, to: DATE, fill: true })
    expect(run!.id).toBe('phone-run')
    expect(workoutSummary(run!.attrs).steps).toBe(3900)
    expect(run!.attrs).not.toHaveProperty('filledFromSamples')
    expect(run!.attrs).not.toHaveProperty('awaitingSummary')
  })

  it('leaves the zones unknown on a day without zone ceilings, and still fills the rest', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(workoutDetail(run.attrs).zones).toBeNull()
    expect(workoutSummary(run.attrs).averageHeartRateBpm).toBe(123)
    expect((run.attrs as { filled: string[] }).filled).not.toContain('heartRateZoneDurations')
  })

  it('marks a bare run with no samples at all as awaiting its summary, and as nothing filled', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(run.attrs).toEqual({ ...PHONE_TREADMILL, awaitingSummary: true })
  })

  // A Google exercise can arrive without a summary (one logged by hand, say); no copy of it is on
  // its way, so it never promises figures, though its samples still fill what they can.
  it('never marks a bare row from a source that is not a phone as awaiting its summary', () => {
    insertSession({ id: 'google-log', sourceId: 'google', attrs: PHONE_TREADMILL })
    const bare = q().sessionById({ sessionId: 'google-log', fill: true })!
    expect(bare.attrs).toEqual(PHONE_TREADMILL)
    seedSamples('google')
    const filled = q().sessionById({ sessionId: 'google-log', fill: true })!
    expect(filled.attrs).toMatchObject({ filledFromSamples: true })
    expect(filled.attrs).not.toHaveProperty('awaitingSummary')
  })

  // An all-Android household syncs no Google copy, so a phone workout's figures are never
  // coming: its samples still fill it, and it promises nothing.
  it('never marks a phone workout awaiting its summary for a person with no Google grant', () => {
    t.db.delete(credentials).run()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    expect(q().sessionById({ sessionId: 'phone-run', fill: true })!.attrs).toEqual(PHONE_TREADMILL)
    seedSamples()
    const filled = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(filled.attrs).toMatchObject({ filledFromSamples: true })
    expect(workoutSummary(filled.attrs).steps).toBe(4500)
    expect(filled.attrs).not.toHaveProperty('awaitingSummary')
  })

  it('never marks it for a person whose Google grant was revoked', () => {
    t.db.update(credentials).set({ revokedAtMs: 1 }).run()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    expect(q().sessionById({ sessionId: 'phone-run', fill: true })!.attrs).toEqual(PHONE_TREADMILL)
  })

  it('counts nothing that starts at the end of the workout: the window is [start, end)', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    insertSamples(t.db, [
      { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: END, tzOffsetMinutes: 120, value: 999 },
      ...(['min', 'mean', 'max'] as const).map((agg) => ({ personId: 'p1', sourceId: 'phone', metric: 'heart_rate', utcMs: END, tzOffsetMinutes: 120, agg, value: 190 })),
    ])
    const summary = workoutSummary(q().sessionById({ sessionId: 'phone-run', fill: true })!.attrs)
    expect(summary.steps).toBe(4500)
    expect(summary.averageHeartRateBpm).toBe(123)
  })

  it('fills nothing, and puts no pace on, a zero-length row', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL, endMs: START })
    seedSamples()
    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(workoutSummary(run.attrs).paceSecondsPerKm).toBeNull()
    expect(run.rate).toBeNull()
    expect(run.attrs).toEqual({ ...PHONE_TREADMILL, awaitingSummary: true })
  })

  it('reads nothing for a row longer than the intraday window, and still marks it', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL, endMs: START + 49 * 60 * MINUTE, localDate: '2026-09-22' })
    seedSamples()
    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(run.attrs).toEqual({ ...PHONE_TREADMILL, awaitingSummary: true })
    expect(vi.mocked(readIntradayWindow)).not.toHaveBeenCalled()
  })

  it('sums one other source when the run\'s own source recorded nothing, never two added together', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples('google')
    // A second device with fewer readings over the same run: summed with the first, the steps would double.
    insertSamples(t.db, [{ personId: 'p1', sourceId: 'scale', metric: 'steps', utcMs: START, tzOffsetMinutes: 120, value: 50 }])

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(workoutSummary(run.attrs).steps).toBe(4500)
  })

  it('reads the run\'s own source first, over another source with more readings', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples('google')
    insertSamples(t.db, [{ personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: START, tzOffsetMinutes: 120, value: 50 }])

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(workoutSummary(run.attrs).steps).toBe(50)
  })

  it('leaves out a reading the person excluded', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    seedOverride(t.db, { personId: 'p1', scope: 'sample', targetKey: sampleTarget({ source: 'phone', metric: 'steps', utcMs: START + 5 * MINUTE }) })

    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
    expect(workoutSummary(run.attrs).steps).toBe(4350)
  })

  it('never lets a filled distance or climb set a record', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    const run = q().sessionById({ sessionId: 'phone-run', fill: true })!
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

    const list = q().sessions({ kind: 'exercise', from: '2026-09-01', to: DATE, fill: true })
    expect(list).toHaveLength(10)
    expect(list.filter((w) => (w.attrs as { filledFromSamples?: boolean }).filledFromSamples === true).map((w) => w.id)).toEqual(['phone-run'])
    // Steps, distance, energy and heart rate: one read each, all for the bare row.
    const calls = vi.mocked(readIntradayWindow).mock.calls
    expect(calls.map(([, input]) => input.metric).sort()).toEqual(['active_energy', 'distance', 'heart_rate', 'steps'])
    expect(calls.every(([, input]) => input.startMs === START && input.endMs === END - 1)).toBe(true)
  })
})

describe('the fill is opt-in, per read', () => {
  const NOW = Date.parse('2026-09-20T12:00:00Z')
  const filledOf = (w: { attrs: unknown }) => (w.attrs as { filledFromSamples?: boolean }).filledFromSamples === true
  const DAY_MS = 24 * 60 * MINUTE

  /** Six earlier treadmill runs the phone alone recorded, one a day, each with its own samples. */
  function seedBareHistory() {
    for (let d = 1; d <= 6; d += 1) {
      const startMs = START - d * DAY_MS
      insertSession({ id: `old-${d}`, sourceId: 'phone', attrs: PHONE_TREADMILL, startMs, endMs: startMs + 30 * MINUTE, localDate: `2026-09-${String(20 - d).padStart(2, '0')}` })
      seedSamples('phone', startMs)
    }
  }

  it('leaves a bare row as recorded, unmarked and unread, on a read that does not ask', () => {
    seedBareHistory()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()

    const list = q().sessions({ kind: 'exercise', from: '2026-09-01', to: DATE })
    expect(list).toHaveLength(7)
    expect(list.every((w) => JSON.stringify(w.attrs) === JSON.stringify(PHONE_TREADMILL))).toBe(true)
    expect(q().sessionById({ sessionId: 'phone-run' })!.attrs).toEqual(PHONE_TREADMILL)
    expect(vi.mocked(readIntradayWindow)).not.toHaveBeenCalled()
  })

  it('fills the subject of the workout page alone, never a bare run in its history', () => {
    seedBareHistory()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()

    const page = readWorkoutPage(q(), { sessionId: 'phone-run', today: DATE, nowMs: NOW, nameOf: (id) => id })!
    expect(page.figures.distance?.value).toBe(5100)
    const calls = vi.mocked(readIntradayWindow).mock.calls.map(([, input]) => input)
    // Every read is about the subject's own span (its fill, highest heart rate, cadence and recovery), none an earlier run's.
    expect(calls.every((input) => input.startMs >= START - MINUTE)).toBe(true)
    // Distance and energy are read by the fill alone: once, for the subject.
    expect(calls.filter((input) => input.metric === 'distance')).toHaveLength(1)
    expect(calls.filter((input) => input.metric === 'active_energy')).toHaveLength(1)
  })

  it('fills the rows each displaying read lists: the day on the dashboard, on the workout and night pages, and the period', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    // A second workout the same day, later on, so the workout page lists the first beside it.
    const laterMs = START + 4 * 60 * MINUTE
    insertSession({ id: 'phone-later', sourceId: 'phone', attrs: PHONE_TREADMILL, startMs: laterMs, endMs: laterMs + 30 * MINUTE })
    // The night after the run, filed under the next day, whose page shows the day before it.
    const nightStart = START + 16 * 60 * MINUTE
    t.db.insert(sessions).values({
      id: 'night', personId: 'p1', sourceId: 'phone', kind: 'sleep', externalId: 'night',
      startMs: nightStart, startOffsetMinutes: 120, endMs: nightStart + 8 * 60 * MINUTE, endOffsetMinutes: 120, localDate: '2026-09-21', rawPayloadId: null,
      attrs: JSON.stringify({ type: null, mainSleep: true, stagesStatus: 'SUCCEEDED', summary: { minutesInSleepPeriod: '480' } }),
    }).run()
    t.db.insert(sessionSegments).values({ id: 'night-1', sessionId: 'night', stage: 'light', startMs: nightStart, endMs: nightStart + 8 * 60 * MINUTE }).run()
    t.db.insert(daily).values({
      personId: 'p1', localDate: '2026-09-21', metric: 'sleep_asleep_minutes', agg: 'sum', source: 'merged', value: 420,
      coverage: 1, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()

    const run = (list: readonly { id: string, attrs: unknown }[]) => list.find((w) => w.id === 'phone-run')!
    expect(filledOf(run(readDay(contextFor(q(), { today: DATE, nowMs: NOW, nameOf: (id) => id })).workouts))).toBe(true)
    // The workout page fills the day's other workouts, each once the subject is out of the list
    // (the subject is filled once: the test above counts its reads).
    vi.mocked(readIntradayWindow).mockClear()
    const later = readWorkoutPage(q(), { sessionId: 'phone-later', today: DATE, nowMs: NOW, nameOf: (id) => id })!
    expect(filledOf(run(later.day.otherWorkouts))).toBe(true)
    // Energy from the run's own source is read by the fill alone: once for the subject, once for
    // the run beside it, never twice for either.
    const energy = vi.mocked(readIntradayWindow).mock.calls
      .filter(([, input]) => input.metric === 'active_energy' && input.sourceId === 'phone').map(([, input]) => input.startMs)
    expect(energy.sort()).toEqual([START, laterMs])
    expect(filledOf(run(readNightPage(q(), {
      localDate: '2026-09-21', today: '2026-09-21', nowMs: NOW + DAY_MS, nameOf: (id) => id, sleepTargetMinutes: 480, sleepUseBaseline: true,
    })!.day.workouts))).toBe(true)
    const row = readActivityPeriod(q(), { range: 'week', anchor: DATE, today: DATE }).workouts.find((w) => w.id === 'phone-run')!
    expect(row.distanceMeters).toBe(5100)
  })
})

describe('the workout page says what is still coming and what was filled', () => {
  const NOW = Date.parse('2026-09-20T12:00:00Z')
  const DAY_MS = 24 * 60 * MINUTE
  const page = (sessionId: string) => readWorkoutPage(q(), { sessionId, today: DATE, nowMs: NOW, nameOf: (id) => id })!

  /** Six earlier treadmill runs Google summarised, one a day: enough for a rank and a usual. */
  function seedGoogleHistory() {
    for (let d = 1; d <= 6; d += 1) {
      const startMs = START - d * DAY_MS
      insertSession({
        id: `google-old-${d}`, sourceId: 'google', attrs: GOOGLE_TREADMILL,
        startMs, endMs: startMs + 30 * MINUTE, localDate: `2026-09-${String(20 - d).padStart(2, '0')}`,
      })
    }
  }

  it('marks a filled page pending, names each figure the samples gave it, and ranks no estimated pace', () => {
    seedGoogleHistory()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    seedZoneCeilings(DATE)

    const filled = page('phone-run')
    expect(filled.pending).toBe(true)
    expect(filled.hero).toBe('pace')
    expect([...filled.filled].sort()).toEqual([
      'averageHeartRate', 'calories', 'cardioLoad', 'distance', 'hardZoneMinutes', 'pace', 'steps',
    ])
    // Every name is a figure the page sends: a filled field no figure reads is not named.
    expect(filled.filled.every((key) => filled.figures[key] !== undefined)).toBe(true)
    // A pace over elapsed time ranked among paces over moving time compares unlike with unlike.
    expect(filled.rank).toBeNull()
    // The history the page judges by stays as Google recorded it.
    expect(filled.figures.distance!.baseline).toMatchObject({ low: 4000, high: 4000 })
  })

  it('ranks the same run once Google has summarised it, and marks nothing', () => {
    seedGoogleHistory()
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })

    const summarised = page('google-run')
    expect(summarised.pending).toBe(false)
    expect(summarised.filled).toEqual([])
    expect(summarised.rank).not.toBeNull()
  })

  it('is not pending for a phone run merged with its Google copy, opened by either id', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })
    seedSamples()
    for (const id of ['phone-run', 'google-run']) {
      const merged = page(id)
      expect(merged.sessionId).toBe('google-run')
      expect(merged.pending).toBe(false)
      expect(merged.filled).toEqual([])
    }
  })

  it('is not pending for a bare Google exercise, which has no copy on its way', () => {
    insertSession({ id: 'google-log', sourceId: 'google', attrs: PHONE_TREADMILL })
    expect(page('google-log').pending).toBe(false)
  })

  it('marks a bare page with no samples at all pending, with nothing filled', () => {
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    const bare = page('phone-run')
    expect(bare.pending).toBe(true)
    expect(bare.filled).toEqual([])
  })

  it('is not pending for a phone workout of a person with no Google grant, and still names what was filled', () => {
    t.db.delete(credentials).run()
    insertSession({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_TREADMILL })
    seedSamples()
    const androidOnly = page('phone-run')
    expect(androidOnly.pending).toBe(false)
    expect(androidOnly.filled).toContain('steps')
  })

  it('names a ride\'s filled speed, and its list rate says it runs over elapsed time', () => {
    insertSession({ id: 'phone-ride', sourceId: 'phone', attrs: attrsOf({ exerciseType: 'BIKING' }) })
    seedSamples()
    const ride = page('phone-ride')
    expect(ride.hero).toBe('speed')
    expect(ride.filled).toContain('speed')
    expect(q().sessionById({ sessionId: 'phone-ride', fill: true })!.rate).toMatchObject({ key: 'speed', fromElapsed: true })
  })

  it('sends no elapsed flag on a rate the device recorded', () => {
    insertSession({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_TREADMILL })
    expect(q().sessionById({ sessionId: 'google-run', fill: true })!.rate).not.toHaveProperty('fromElapsed')
  })
})
