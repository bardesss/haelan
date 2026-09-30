import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { seedArchive, localMidnightMs, routedRunLengthTolerance } from '../src/testing/seed.ts'
import {
  rawPayloads, samples, daily, sessions, sessionSegments, sessionRoutes, observations,
} from '../src/db/schema/index.ts'
import { openHaelan } from '../src/instance.ts'
import { PeopleStore } from '../src/store/people.ts'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { MERGED_SOURCE } from '../src/derive/rollup.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { routeSignature, sameRoute } from '../src/api/routeMatch.ts'

const END = Date.parse('2026-03-01T00:00:00Z')

describe('seedArchive', () => {
  it('writes archive payloads and not one derived row', () => {
    const test = createTestDatabase()
    try {
      seedPerson(test.db, 'p1')
      seedArchive({ archive: new RawArchive(test.db), personId: 'p1', days: 7, endMs: END })

      expect(test.db.select().from(rawPayloads).all().length).toBeGreaterThan(0)
      // The whole premise: everything a chart shows is derived by the app from these bodies. A
      // seed that wrote a derived row could draw a chart no real instance could ever produce.
      // All five of the unit's derived tables, not the three the assertion here used to name:
      // observations and session_segments are as much a rebuild's output as samples, daily and
      // sessions are, and a seed that inserted a mood or a sleep stage directly would be exactly
      // the same defect this test exists to catch.
      expect(test.db.select().from(samples).all()).toEqual([])
      expect(test.db.select().from(daily).all()).toEqual([])
      expect(test.db.select().from(sessions).all()).toEqual([])
      expect(test.db.select().from(sessionSegments).all()).toEqual([])
      expect(test.db.select().from(sessionRoutes).all()).toEqual([])
      expect(test.db.select().from(observations).all()).toEqual([])
    } finally { test.cleanup() }
  })

  // Task 7: the demo is built from this generator, and it is public and permanent, so a route
  // reaching it would be a real coordinate published forever rather than a bug fixed on the next
  // capture. Checked rather than assumed - exercisePoint (this file) never writes a `route` key, so
  // mapSessions has nothing to read, but that is a fact about today's generator, not a guarantee
  // this test would notice breaking on its own without asserting it after a real rebuild.
  // openHaelan and runRebuild, not a raw payload check, for the same reason the anchor test above
  // rebuilds rather than inspects: session_routes is tier 2, and a route only exists once the app
  // has derived it, so asserting on the archive alone would prove nothing about what the demo's
  // own workout page could ever draw.
  it('seeds no workout route, even after the app rebuilds tier 2 from what it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-demo-no-route-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 14, endMs: END })
      const report = runRebuild({
        db: instance.db,
        archive: instance.archive,
        peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: END,
      })
      expect(report.failures).toEqual([])
      // At least one real exercise session exists to route through mapSessions at all - otherwise
      // an empty session table would pass this test for the wrong reason.
      expect(instance.db.select().from(sessions).where(eq(sessions.kind, 'exercise')).all().length)
        .toBeGreaterThan(0)
      expect(instance.db.select().from(sessionRoutes).all()).toEqual([])
    } finally { instance.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('gives the same bytes for the same seed, and different ones for a different seed', () => {
    const bodies = (seed: number): string[] => {
      const test = createTestDatabase()
      try {
        seedPerson(test.db, 'p1')
        const archive = new RawArchive(test.db)
        seedArchive({ archive, personId: 'p1', days: 5, endMs: END, seed })
        return test.db.select().from(rawPayloads).all()
          .map((r) => r.bodyHash).sort()
      } finally { test.cleanup() }
    }
    expect(bodies(1)).toEqual(bodies(1))
    expect(bodies(1)).not.toEqual(bodies(2))
  })

  it('covers every derived table once the app rebuilds from it', () => {
    // Named here rather than in the rehearsal because it is the generator's promise, not the
    // migration's: a seed that produced no sleep would let the rehearsal pass while proving
    // nothing about sessions.
    const test = createTestDatabase()
    try {
      seedPerson(test.db, 'p1')
      seedArchive({ archive: new RawArchive(test.db), personId: 'p1', days: 14, endMs: END })
      const types = new Set(test.db.select().from(rawPayloads).all().map((r) => r.dataType))
      for (const id of [
        'steps', 'heart-rate', 'weight', 'sleep', 'exercise',
        'daily-resting-heart-rate', 'daily-heart-rate-variability', 'daily-respiratory-rate',
      ]) {
        expect(types.has(id), id).toBe(true)
      }
    } finally { test.cleanup() }
  })

  it('closes on a completed local day when anchored at localMidnightMs, not a partial one', () => {
    // scripts/seed-demo.mjs anchors endMs with localMidnightMs rather than a bare Date.parse of
    // UTC midnight, exactly so this holds. A UTC-midnight anchor lets the last of this file's
    // UTC-day chunks straddle Amsterdam's own day boundary: the couple of hours past it spill
    // into a new local day nothing after endMs ever fills back in, which is what left the demo's
    // final Activity/Dashboard bar reading at 8.3% coverage - the right-hand edge a screenshot's
    // first glance lands on. Rebuilding through openHaelan and runRebuild here rather than
    // inspecting raw payloads directly, because coverage is a property of the derived `daily`
    // row, not of the archive this file writes.
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-demo-anchor-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 3, endMs })
      const report = runRebuild({
        db: instance.db,
        archive: instance.archive,
        peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: Date.now(),
      })
      expect(report.failures).toEqual([])

      // Read back whichever local day actually turns out to be the latest one with a steps row,
      // rather than asserting on a hardcoded date. A day one UTC-day chunk short of endMs (here,
      // 2026-09-06) is a full day either way this file anchors endMs - two overlapping chunks
      // cover it regardless - so naming that date would pass against the very UTC-midnight anchor
      // this test exists to catch. The day the anchor actually decides is whichever one comes out
      // latest: 2026-09-06 and nothing beyond it when endMs is local midnight, or a second,
      // 2026-09-07 row - the couple of hours spilled past that boundary - when it is not.
      const allRows = instance.db.select().from(daily).where(eq(daily.personId, 'p1')).all()
      const stepsRows = allRows.filter((r) => r.metric === 'steps' && r.agg === 'sum' && r.source === MERGED_SOURCE)
      const lastStepsRow = stepsRows.reduce((latest, row) => (
        latest === null || row.localDate > latest.localDate ? row : latest
      ), null as (typeof stepsRows)[number] | null)
      // 1 means all 24 of that day's local hours carry a sample - a whole day generated, not a
      // couple of hours' spillover from the UTC chunk after it.
      expect(lastStepsRow?.coverage).toBe(1)

      // steps is the reference, not because it is special, but because it is the one metric this
      // suite already trusted before this test existed: it is derived from real per-hour
      // timestamps during the rebuild, never from this file's own civilDateOf, so a bug in
      // civilDateOf has no way to reach it. Anchoring the rest of the check on it, rather than on
      // a second hardcoded date, is what makes this a check of every OTHER metric agreeing with
      // steps rather than two independently-guessed dates agreeing with each other.
      const referenceDate = lastStepsRow!.localDate

      // Every metric this run produced a `daily` row for, steps included, regardless of agg or
      // source: the newest-day regression this test exists to catch (civilDateOf reading a UTC
      // calendar date off an Amsterdam-local-midnight instant, one day early) does not care which
      // aggregate or which source a metric's row carries, only which civil date it landed on.
      // workout_count/workout_minutes are excluded on purpose, not overlooked: deriveExerciseDay
      // writes no row at all for a day with no session (its own comment: "absence is the whole
      // answer"), and this seed's workouts land on a fixed i % 3 === 1 schedule that need not
      // include this run's own last day - a day 3 span here never does. That is ordinary
      // sparseness, not the stamping bug, and asserting it away would make this test's pass
      // depend on `days` and the workout schedule lining up rather than on civilDateOf being
      // correct. The three active_minutes_*_peak overlaps are sparse the same way: a day has them
      // only when a run put minutes into the peak zone, and the run on this span's middle day
      // (WORKOUT_SCHEDULE opens with one) is not on its last.
      const EXCLUDED_SPARSE_METRICS = new Set([
        'workout_count', 'workout_minutes', 'active_minutes_light_peak', 'active_minutes_moderate_peak', 'active_minutes_vigorous_peak',
      ])
      const newestByMetric = new Map<string, string>()
      for (const row of allRows) {
        if (EXCLUDED_SPARSE_METRICS.has(row.metric)) continue
        const seen = newestByMetric.get(row.metric)
        if (seen === undefined || row.localDate > seen) newestByMetric.set(row.metric, row.localDate)
      }
      // Not vacuous: a query that matched nothing (a metric name typo'd out of existence, or a
      // rebuild that silently produced no daily rows at all) would otherwise pass this loop by
      // running zero iterations of it. 20 is comfortably under the ~30 metrics a 3 day run of
      // every data type this generator writes actually produces, so it is a floor against an empty
      // result, not a count this test is pinning.
      expect(newestByMetric.size).toBeGreaterThan(20)
      for (const [metric, newest] of newestByMetric) {
        // This is what the earlier, steps-only pin could not see: resting_heart_rate, daily_hrv,
        // respiratory_rate, floors and total_calories all filed their newest row under
        // referenceDate minus one day, because civilDateOf read dayStart's UTC calendar date
        // instead of its Amsterdam one. Naming the metric in the assertion message is what makes
        // a broken run's failure legible rather than a bare boolean.
        expect(newest, metric).toBe(referenceDate)
      }
    } finally {
      // Handles closed before the directory comes down: an open SQLite handle on Windows turns
      // rmSync's EPERM into the error a failing coverage assertion would otherwise report.
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The demo's night page draws every section only if a seeded night carries what each one reads:
  // the provider's summary (latency, awakenings), the intraday HRV and SpO2 its traces plot, the
  // nightly temperature and breathing rate the morning after names. Asserted through nightPage
  // after a real rebuild, since each of those only exists once the app has derived it.
  it('gives a seeded night everything the night page shows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-night-page-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 21, endMs })
      const report = runRebuild({
        db: instance.db, archive: instance.archive, peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority, overrides: instance.overrides, settings: instance.settings, nowMs: endMs,
      })
      expect(report.failures).toEqual([])
      const q = new PersonQuery(instance.db, 'p1')
      const page = q.nightPage({
        localDate: '2026-09-06', today: '2026-09-07', nowMs: endMs, nameOf: (id) => id,
        sleepTargetMinutes: 480, sleepUseBaseline: true,
      })
      expect(page).not.toBeNull()
      const { figures, traces, morning, night } = page!
      expect(figures.minutesToFallAsleep.value).toBeGreaterThanOrEqual(5)
      expect(figures.minutesToFallAsleep.value).toBeLessThanOrEqual(25)
      expect(figures.awakenings.value).toBeGreaterThanOrEqual(8)
      expect(figures.awakenings.value).toBeLessThanOrEqual(18)
      expect(figures.minutesAfterWakeUp.value).not.toBeNull()
      expect(traces.spo2.stat.lowest!.value).toBeGreaterThanOrEqual(93)
      expect(traces.spo2.stat.highest!.value).toBeLessThanOrEqual(98)
      expect(traces.hrv.stat.lowest!.value).toBeGreaterThanOrEqual(30)
      expect(traces.hrv.stat.highest!.value).toBeLessThanOrEqual(70)
      expect(morning.skinTemperature.value).not.toBeNull()
      expect(morning.breathing.value).not.toBeNull()
      expect(morning.spo2.value).not.toBeNull()
      // Every five minutes through the night, not the hourly day curve alone.
      const perMetric = (metric: string) => q.intradayWindow({ metric, startMs: night.startMs, endMs: night.endMs, points: 100_000 }).points.length
      const expected = Math.floor((night.endMs - night.startMs) / 300_000)
      for (const metric of ['heart_rate', 'hrv', 'spo2']) expect(perMetric(metric), metric).toBeGreaterThanOrEqual(expected - 1)
    } finally {
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The demo's workout page draws every section only if a seeded run carries what each one reads:
  // pace and distance, the automatic kilometre splits, the provider's zone durations and the day's
  // zone ceilings, the running form figures, and heart rate every minute. Asserted through
  // workoutPage after a real rebuild, since each only exists once the app has derived it.
  it('gives a seeded run everything the workout page shows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-workout-page-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 30, endMs })
      const report = runRebuild({
        db: instance.db, archive: instance.archive, peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority, overrides: instance.overrides, settings: instance.settings, nowMs: endMs,
      })
      expect(report.failures).toEqual([])
      const q = new PersonQuery(instance.db, 'p1')
      const run = q.sessions({ kind: 'exercise', from: '2026-01-01', to: '2026-09-07', type: 'RUNNING' }).at(-1)
      expect(run, 'the seed produced no run in thirty days').toBeDefined()
      const page = q.workoutPage({ sessionId: run!.id, today: '2026-09-07', nowMs: endMs })!
      expect(page.hero).toBe('pace')
      expect(page.figures.pace!.value).toBeGreaterThan(270)
      expect(page.figures.pace!.value).toBeLessThan(400)
      expect(page.figures.distance!.value).toBeGreaterThan(3000)
      expect(page.figures.movingTime!.value).toBeLessThanOrEqual(page.figures.elapsed!.value!)
      for (const key of ['calories', 'steps', 'averageHeartRate', 'elevationGain', 'activeZoneMinutes', 'hardZoneMinutes',
        'cardioLoad', 'cadence', 'strideLength', 'groundContact', 'verticalOscillation', 'verticalRatio', 'vo2max'] as const) {
        expect(page.figures[key], key).toBeDefined()
      }
      expect(page.splitTrend).not.toBeNull()
      expect(page.zoneBounds).not.toBeNull()
      expect(page.zoneBounds!.moderateMin).toBeLessThan(page.zoneBounds!.max)
      // Heart rate every minute of the workout, not the hourly day curve alone.
      const minutes = Math.floor((run!.endMs - run!.startMs) / 60_000)
      const points = q.intradayWindow({ metric: 'heart_rate', startMs: run!.startMs, endMs: run!.endMs, points: 100_000 }).points
      expect(points.length).toBeGreaterThanOrEqual(minutes - 1)
      // And a reading each of the three minutes after it, falling, for the heart-rate recovery.
      const endMinute = Math.floor(run!.endMs / 60_000) * 60_000
      const after = q.intradayWindow({ metric: 'heart_rate', startMs: endMinute + 60_000, endMs: endMinute + 4 * 60_000, points: 100_000 }).points
      expect(after.map((p) => p.utcMs)).toEqual([1, 2, 3].map((k) => endMinute + k * 60_000))
      expect(page.heartRateRecovery!.oneMinute.value).toBeGreaterThan(0)
      expect(page.heartRateRecovery!.twoMinutes.value).toBeGreaterThan(page.heartRateRecovery!.oneMinute.value!)
    } finally {
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The demo writes each routed run twice, Google's copy and the phone's, which the app merges on
  // read. Merged into one session, the run's page finds an earlier run as its previous one rather
  // than its own second copy, and it has enough runs before it for a usual range. A real rebuild of
  // three months of every data type, so it gets longer than the default timeout.
  it('merges the routed demo run into one session whose previous run is an earlier one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-routed-run-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 95, endMs, demoRoute: true })
      const report = runRebuild({
        db: instance.db, archive: instance.archive, peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority, overrides: instance.overrides, settings: instance.settings, nowMs: endMs,
      })
      expect(report.failures).toEqual([])
      const q = new PersonQuery(instance.db, 'p1')
      const runs = q.sessions({ kind: 'exercise', from: '2026-01-01', to: '2026-09-07', type: 'RUNNING' })
      const last = runs.at(-1)!
      expect(runs.filter((run) => run.startMs === last.startMs)).toHaveLength(1)
      const page = q.workoutPage({ sessionId: last.id, today: '2026-09-07', nowMs: endMs })!
      expect(page.previous).not.toBeNull()
      expect(page.previous!.sessionId).not.toBe(last.id)
      // Nine runs before it in 90 days, and five walks before the last walk: a real usual range
      // for both, and a full strip for a run.
      const within90 = (list: typeof runs, subject: (typeof runs)[number]) =>
        list.filter((s) => s.startMs < subject.startMs && s.startMs >= subject.startMs - 90 * 86_400_000).length
      expect(within90(runs, last)).toBeGreaterThanOrEqual(9)
      const walks = q.sessions({ kind: 'exercise', from: '2026-01-01', to: '2026-09-07', type: 'WALKING' })
      expect(within90(walks, walks.at(-1)!)).toBeGreaterThanOrEqual(5)
      expect(page.figures.pace!.baseline?.thin).toBe(false)
      expect(page.figures.pace!.strip.every((point) => point.value !== null)).toBe(true)
      // Every run recovers at its own rate, so the recovery's usual has a spread to judge against.
      const recoveryUsual = page.heartRateRecovery!.oneMinute.baseline!
      expect(recoveryUsual.thin).toBe(false)
      expect(recoveryUsual.high - recoveryUsual.low).toBeGreaterThan(2)
    } finally {
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  // The same promise at the level of the payloads, over a span long enough to meet every type and
  // the occasional paused run, so the shapes can be checked for agreeing with themselves.
  it('writes workouts whose figures agree with themselves', () => {
    const puts: Array<{ dataType: string, body: string }> = []
    const archive = { put: (row: { dataType: string, body: string }) => { puts.push(row) } }
    seedArchive({ archive: archive as unknown as RawArchive, personId: 'p1', days: 120, endMs: END, demoRoute: true })
    type Exercise = Record<string, any>
    const exercises = puts.filter((p) => p.dataType === 'exercise')
      .flatMap((p) => (JSON.parse(p.body) as { dataPoints: Array<{ dataSource: { platform: string }, exercise: Exercise }> }).dataPoints)
    const google = exercises.filter((p) => p.dataSource.platform === 'FITBIT').map((p) => p.exercise)
    const seconds = (d: string): number => Number(d.slice(0, -1))
    const types = new Set(google.map((e) => e.exerciseType))
    for (const type of ['RUNNING', 'BIKING', 'WALKING', 'WEIGHTLIFTING', 'SWIMMING_POOL', 'TRAIL_RUN', 'TREADMILL']) expect(types.has(type), type).toBe(true)
    let midPauses = 0
    for (const e of google) {
      const startMs = Date.parse(e.interval.startTime)
      const endMs = Date.parse(e.interval.endTime)
      const elapsed = (endMs - startMs) / 1000
      const active = seconds(e.activeDuration)
      expect(active).toBeLessThanOrEqual(elapsed + 1)
      const m = e.metricsSummary
      expect(m.caloriesKcal, e.exerciseType).toBeGreaterThan(0)
      expect(Number(m.averageHeartRateBeatsPerMinute), e.exerciseType).toBeGreaterThan(60)
      // The real finish sequence closes every workout: PAUSE and STOP at its end.
      const events = e.exerciseEvents as Array<{ eventTime: string, exerciseEventType: string }>
      expect(events.at(-1)!.exerciseEventType).toBe('STOP')
      expect(Date.parse(events.at(-1)!.eventTime)).toBe(endMs)
      const pauses = events.filter((ev) => ev.exerciseEventType === 'PAUSE' && Date.parse(ev.eventTime) < endMs - 120_000)
      midPauses += pauses.length
      if (e.exerciseType === 'WEIGHTLIFTING') {
        expect(m.distanceMillimeters).toBeUndefined()
        continue
      }
      const zones = m.heartRateZoneDurations
      const inZones = ['lightTime', 'moderateTime', 'vigorousTime', 'peakTime'].reduce((sum, k) => sum + seconds(zones[k]), 0)
      expect(inZones).toBeLessThanOrEqual(active + 60)
      if (e.exerciseType === 'SWIMMING_POOL') {
        expect(m.totalSwimLengths * e.exerciseMetadata.poolLengthMillimeters).toBe(m.distanceMillimeters)
        continue
      }
      if (e.exerciseType === 'TREADMILL') {
        // A belt: no fix, no climb, and no pace of the watch's own, so the page works it out.
        expect(e.exerciseMetadata.hasGps).toBe(false)
        expect([m.averagePaceSecondsPerMeter, m.averageSpeedMillimetersPerSecond, m.elevationGainMillimeters]).toEqual([undefined, undefined, undefined])
      } else {
        // Pace and speed are both the distance over the moving time.
        expect(m.averagePaceSecondsPerMeter * m.distanceMillimeters / 1000).toBeCloseTo(active, -1)
        expect(m.averageSpeedMillimetersPerSecond * active).toBeCloseTo(m.distanceMillimeters, -4)
      }
      if (e.exerciseType === 'BIKING') {
        // Once round the loop, under the hour every seeded workout keeps to, a few steps a minute.
        expect(Math.abs(m.distanceMillimeters / 1000 - 21_000)).toBeLessThanOrEqual(151)
        expect(elapsed).toBeLessThan(3600)
        expect(Number(m.steps) / (active / 60)).toBeLessThan(40)
      }
      const splits = e.splits as Array<{ splitType: string, activeDuration: string, metricsSummary: { distanceMillimeters: number } }>
      expect(splits.every((s) => s.splitType === 'DISTANCE')).toBe(true)
      expect(splits.reduce((sum, s) => sum + s.metricsSummary.distanceMillimeters, 0)).toBe(m.distanceMillimeters)
      expect(splits.reduce((sum, s) => sum + seconds(s.activeDuration), 0)).toBe(active)
      if (e.exerciseType === 'RUNNING') {
        expect(m.mobilityMetrics.avgCadenceStepsPerMinute).toBeGreaterThan(150)
        expect(m.runVo2Max).toBeGreaterThan(35)
      }
    }
    expect(midPauses, 'no run in 120 days paused mid-run').toBeGreaterThan(0)
    // Routes ride on the phone's own copy of a run or a ride, never on Google's: on the last run, and
    // on earlier ones only when they are near enough its length to be its route; the rides likewise.
    const routedAll = exercises.filter((p) => p.exercise.route !== undefined)
    expect(routedAll.every((p) => p.dataSource.platform === 'HEALTH_CONNECT')).toBe(true)
    expect(new Set(routedAll.map((p) => p.exercise.exerciseType))).toEqual(new Set(['RUNNING', 'BIKING']))
    const rides = google.filter((e) => e.exerciseType === 'BIKING').sort((a, b) => a.interval.startTime.localeCompare(b.interval.startTime))
    const routedRides = routedAll.filter((p) => p.exercise.exerciseType === 'BIKING').map((p) => p.exercise.interval.startTime as string)
    expect(routedRides).toEqual(rides.slice(-2).map((e) => e.interval.startTime))
    const routed = routedAll.filter((p) => p.exercise.exerciseType === 'RUNNING')
    expect(routed.length).toBeGreaterThan(0)
    expect(google.every((e) => e.route === undefined)).toBe(true)
    const runs = google.filter((e) => e.exerciseType === 'RUNNING').sort((a, b) => a.interval.startTime.localeCompare(b.interval.startTime))
    const routedStarts = routed.map((p) => p.exercise.interval.startTime as string)
    expect(routedStarts).toContain(runs.at(-1)!.interval.startTime)
    const lengthOf = (start: string) => runs.find((e) => e.interval.startTime === start)!.metricsSummary.distanceMillimeters as number
    const lastLength = lengthOf(runs.at(-1)!.interval.startTime)
    const near = (start: string) => Math.abs(lengthOf(start) - lastLength) / 1000 <= routedRunLengthTolerance(lastLength / 1000)
    for (const start of routedStarts) expect(near(start), start).toBe(true)
    // The most recent of them: no run of that length since the oldest routed one goes unrouted.
    const oldest = [...routedStarts].sort()[0]!
    const skipped = runs.map((e) => e.interval.startTime as string)
      .filter((start) => start > oldest && !routedStarts.includes(start) && near(start))
    expect(skipped).toEqual([])
  })

  // The demo's own span, end and clock (scripts/capture-demo.mjs's 371 days, seed-demo.mjs's end and
  // apps/web's DEMO_CLOCK_MS, half a day before it), so this is the run the demo opens: each earlier
  // routed run is the last one's route to routeMatch.ts, and its page draws "Deze route".
  it("routes the demo's runs and rides so the last of each finds the others on its route", () => {
    const puts: Array<{ dataType: string, body: string }> = []
    const archive = { put: (row: { dataType: string, body: string }) => { puts.push(row) } }
    const endMs = localMidnightMs('2026-09-07')
    seedArchive({ archive: archive as unknown as RawArchive, personId: 'p1', days: 371, endMs, demoRoute: true, lastDayUntilMs: endMs - 12 * 3_600_000 })
    const routed = puts.filter((p) => p.dataType === 'exercise')
      .flatMap((p) => (JSON.parse(p.body) as { dataPoints: Array<{ exercise: { exerciseType: string, route?: Array<{ latitude: number, longitude: number }> } }> }).dataPoints)
      .flatMap((p) => (p.exercise.route === undefined ? [] : [p.exercise]))
    const routesOf = (type: string) => routed.filter((e) => e.exerciseType === type).map((e) => e.route!)
    // Three runs and two rides: the demo's routed pages, bounded by the capture's size ceiling.
    expect(routesOf('RUNNING')).toHaveLength(3)
    expect(routesOf('BIKING')).toHaveLength(2)
    // One start for all of them, which is also where each loop closes.
    for (const { route } of routed) {
      expect([route![0], route!.at(-1)].map((p) => [p!.latitude, p!.longitude])).toEqual([[0, 0], [0, 0]])
    }
    for (const type of ['RUNNING', 'BIKING']) {
      const [last, ...earlier] = routesOf(type).map((route) => routeSignature(route)!).reverse()
      for (const signature of earlier) expect(sameRoute(last!, signature), type).toBe(true)
    }
    // A run's loop and a ride's share the start and nothing else.
    expect(sameRoute(routeSignature(routesOf('RUNNING').at(-1)!)!, routeSignature(routesOf('BIKING').at(-1)!)!)).toBe(false)
  }, 60_000)

  // The hourly day curve, the night's readings, a workout's own and the minutes after it are four
  // writers of one heart-rate series, each told to stay out of the others' minutes. Two readings in
  // one minute would be averaged into one stored row, so a recovery minute a night reading shared
  // would read a fall that neither gave. Over the demo's own length, so every morning workout the
  // demo draws is met.
  it('never writes two heart-rate readings into one minute, over the demo\'s year', () => {
    const minutes = new Map<number, number>()
    const archive = {
      put: (row: { dataType: string, body: string }) => {
        if (row.dataType !== 'heart-rate') return
        for (const m of row.body.matchAll(/"physicalTime":"([^"]+)"/g)) {
          const minute = Math.floor(Date.parse(m[1]!) / 60_000)
          minutes.set(minute, (minutes.get(minute) ?? 0) + 1)
        }
      },
    }
    seedArchive({ archive: archive as unknown as RawArchive, personId: 'p1', days: 365, endMs: END, demoRoute: true, phoneWorkout: true })
    expect(minutes.size).toBeGreaterThan(0)
    const doubled = [...minutes].filter(([, n]) => n > 1).map(([minute]) => new Date(minute * 60_000).toISOString())
    expect(doubled).toEqual([])
  }, 60_000)

  // The demo's one phone-only workout: a walk the companion sent with no Google copy, which the
  // workout page fills from the phone's own samples and marks as waiting for Google's figures.
  it('adds one phone-only walk on request, and nothing else', () => {
    type Put = { dataType: string, windowStartMs: number, body: string }
    const run = (phoneWorkout: boolean): Put[] => {
      const puts: Put[] = []
      const archive = { put: (row: Put) => { puts.push({ dataType: row.dataType, windowStartMs: row.windowStartMs, body: row.body }) } }
      seedArchive({ archive: archive as unknown as RawArchive, personId: 'p1', days: 31, endMs: localMidnightMs('2026-09-07'), phoneWorkout })
      return puts
    }
    const without = run(false)
    const withWalk = run(true)
    // Five payloads more: the exercise and its heart rate, steps, distance and energy.
    expect(withWalk.length - without.length).toBe(5)
    const phone = withWalk.filter((p) => p.body.includes('HEALTH_CONNECT'))
    expect(phone.map((p) => p.dataType)).toEqual(['exercise', 'heart-rate', 'steps', 'distance', 'active-energy-burned'])
    // Every other payload is byte for byte what it was: the walk draws on no stream.
    expect(withWalk.filter((p) => !phone.includes(p))).toEqual(without)
    const exercise = JSON.parse(phone[0]!.body).dataPoints[0].exercise
    expect(exercise).not.toHaveProperty('metricsSummary')
    expect(exercise.exerciseType).toBe('WALKING')
    // The most recent day before the last with no scheduled workout (the 5th, over 31 days), 16:20 in Amsterdam.
    expect(exercise.interval.startTime).toBe('2026-09-05T14:20:00.000Z')
    expect(run(true)).toEqual(withWalk)
  })

  it('fills the phone-only walk from its samples after a rebuild, and marks it awaiting Google', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-phone-walk-'))
    const instance = openHaelan(dir)
    try {
      seedPerson(instance.db, 'p1')
      const endMs = localMidnightMs('2026-09-07')
      seedArchive({ archive: instance.archive, personId: 'p1', days: 10, endMs, phoneWorkout: true })
      const report = runRebuild({
        db: instance.db, archive: instance.archive, peopleStore: new PeopleStore(instance.db),
        priority: instance.sourcePriority, overrides: instance.overrides, settings: instance.settings, nowMs: endMs,
      })
      expect(report.failures).toEqual([])
      // Google connected, as the demo person is: the walk's Google copy is then still to come.
      instance.credentials.putRefreshToken({ personId: 'p1', refreshToken: 'not-real', scopes: [], nowMs: endMs })
      const q = new PersonQuery(instance.db, 'p1')
      const [walk, ...others] = q.sessions({ kind: 'exercise', from: '2026-09-05', to: '2026-09-05', fill: true })
      expect(others).toEqual([])
      expect(walk!.attrs).toMatchObject({ awaitingSummary: true, filledFromSamples: true, exerciseType: 'WALKING' })
      const summary = (walk!.attrs as { metricsSummary: Record<string, number> }).metricsSummary
      // 36 minutes of 108 to 116 steps (the formula's own sum), 750 mm each, 5 or 6 kcal.
      expect(summary.steps).toBe(4032)
      expect(summary.distanceMillimeters).toBe(4032 * 750)
      expect(summary.caloriesKcal).toBe(192)
      expect(summary.averageHeartRateBeatsPerMinute).toBeGreaterThan(100)
      expect(q.workoutPage({ sessionId: walk!.id, today: '2026-09-06', nowMs: endMs })!.pending).toBe(true)
    } finally {
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  describe('lastDayUntilMs', () => {
    // A stand-in archive that keeps every put in order, so two runs can be compared put by put.
    interface Put { dataType: string, windowStartMs: number, body: string }
    const run = (input: { days: number, lastDayUntilMs?: number }): Put[] => {
      const puts: Put[] = []
      const archive = { put: (row: Put) => { puts.push({ dataType: row.dataType, windowStartMs: row.windowStartMs, body: row.body }) } }
      seedArchive({ archive: archive as unknown as RawArchive, personId: 'p1', endMs: END, demoRoute: true, ...input })
      return puts
    }
    // The latest instant anywhere in a point: its end for an interval, a night or a workout (its
    // stages and route points sit inside it), its own time for a sample.
    const pointEnds = (put: Put): number[] => {
      const parsed = JSON.parse(put.body) as { dataPoints?: unknown[] }
      return (parsed.dataPoints ?? []).map((point) => {
        const instants = [...JSON.stringify(point).matchAll(/"(?:endTime|physicalTime|time)":"([^"]+)"/g)]
          .map((m) => Date.parse(m[1]!))
        return Math.max(...instants)
      })
    }
    // Five days, so the final day (index 4) is a workout day and the workout's own cut is exercised.
    const DAYS = 5
    const FINAL_DAY_START = END - 86_400_000
    const NOON = END - 12 * 3_600_000

    // The final day's civil date, the key a rollup window carries instead of an instant.
    const FINAL_DATE = { year: 2026, month: 2, day: 28 }
    const ROLLUPS = new Set(['total-calories', 'floors'])
    // A rollup payload's windows, by civil date, each as the payload key's own value object.
    const rollupValues = (put: Put): Map<string, Record<string, unknown>> => {
      const parsed = JSON.parse(put.body) as { rollupDataPoints: Array<Record<string, unknown>> }
      return new Map(parsed.rollupDataPoints.map((point) => {
        const date = (point.civilStartTime as { date: unknown }).date
        const key = Object.keys(point).find((k) => k !== 'civilStartTime' && k !== 'civilEndTime')!
        return [JSON.stringify(date), point[key] as Record<string, unknown>]
      }))
    }

    it('leaves every earlier day byte for byte what it was, since it only filters and scales', () => {
      const whole = run({ days: DAYS })
      const cut = run({ days: DAYS, lastDayUntilMs: NOON })
      expect(cut.length).toBe(whole.length)
      const changed = cut.flatMap((put, k) => (put.body === whole[k]!.body ? [] : [{ put, was: whole[k]! }]))
      expect(changed.length).toBeGreaterThan(0)
      for (const { put, was } of changed) {
        if (!ROLLUPS.has(put.dataType)) {
          expect(put.windowStartMs, put.dataType).toBe(FINAL_DAY_START)
          continue
        }
        // A rollup payload spans several days; only the final day's window may differ.
        const now = rollupValues(put)
        const before = rollupValues(was)
        now.delete(JSON.stringify(FINAL_DATE))
        before.delete(JSON.stringify(FINAL_DATE))
        expect(now, put.dataType).toEqual(before)
      }
    })

    it("scales the final day's whole-day totals by the share of the day that has passed", () => {
      const share = (NOON - FINAL_DAY_START) / 86_400_000
      const finalPuts = (puts: Put[], dataType: string): Put[] =>
        puts.filter((put) => put.dataType === dataType && put.windowStartMs === FINAL_DAY_START)
      const points = (puts: Put[], dataType: string): Array<Record<string, unknown>> =>
        finalPuts(puts, dataType).flatMap((put) => (JSON.parse(put.body) as { dataPoints: Array<Record<string, unknown>> }).dataPoints)
      const byLevel = (puts: Put[]): Record<string, number> => Object.fromEntries(
        (points(puts, 'active-minutes')[0]!.activeMinutes as { activeMinutesByActivityLevel: Array<{ activityLevel: string, activeMinutes: string }> })
          .activeMinutesByActivityLevel.map((l) => [l.activityLevel, Number(l.activeMinutes)]),
      )
      const byZone = (puts: Put[]): Record<string, number> => Object.fromEntries(points(puts, 'active-zone-minutes').map((p) => {
        const z = p.activeZoneMinutes as { heartRateZone: string, activeZoneMinutes: string }
        return [z.heartRateZone, Number(z.activeZoneMinutes)]
      }))
      const rollup = (puts: Put[], dataType: string): Record<string, unknown> => {
        const put = puts.find((p) => p.dataType === dataType && rollupValues(p).has(JSON.stringify(FINAL_DATE)))!
        return rollupValues(put).get(JSON.stringify(FINAL_DATE))!
      }

      const whole = run({ days: DAYS })
      const cut = run({ days: DAYS, lastDayUntilMs: NOON })
      const scaled = (n: number): number => Math.round(n * share)

      // Ambient minutes, scaled. Large enough whole-day figures that a missing scale cannot
      // round its way to the same number.
      expect(byLevel(whole).LIGHT).toBeGreaterThan(2)
      expect(byLevel(cut).LIGHT).toBe(scaled(byLevel(whole).LIGHT!))
      expect(byZone(whole).FAT_BURN).toBeGreaterThan(2)
      expect(byZone(cut).FAT_BURN).toBe(scaled(byZone(whole).FAT_BURN!))
      // A workout's minutes are whole if the workout finished before the cutoff, and zero if not.
      const workoutKept = points(cut, 'exercise').length > 0
      for (const level of ['MODERATE', 'VIGOROUS'] as const) {
        expect(byLevel(cut)[level], level).toBe(workoutKept ? byLevel(whole)[level] : 0)
      }
      for (const zone of ['CARDIO', 'PEAK'] as const) {
        expect(byZone(cut)[zone], zone).toBe(workoutKept ? byZone(whole)[zone] : 0)
      }

      // The two daily rollups, scaled the same way.
      const kcal = (puts: Put[]): number => Number(rollup(puts, 'total-calories').kcalSum)
      expect(kcal(whole)).toBeGreaterThan(2)
      expect(kcal(cut)).toBe(scaled(kcal(whole)))
      const floors = (puts: Put[]): number => Number(rollup(puts, 'floors').countSum)
      expect(floors(cut)).toBe(scaled(floors(whole)))
    })

    it('ends every final-day reading at or before the cutoff, and keeps the ones that did', () => {
      const cut = run({ days: DAYS, lastDayUntilMs: NOON })
      const finalDay = cut.filter((put) => put.windowStartMs === FINAL_DAY_START)
      for (const put of finalDay) {
        for (const end of pointEnds(put)) expect(end, put.dataType).toBeLessThanOrEqual(NOON)
      }
      const count = (dataType: string): number =>
        finalDay.filter((put) => put.dataType === dataType).reduce((n, put) => n + pointEnds(put).length, 0)
      // The morning is still there: twelve whole hours of steps, twelve hourly heart-rate samples
      // (noon's own is at the cutoff, so not before it), and the day's activity minutes, cut short.
      expect(count('steps')).toBe(12)
      expect(count('heart-rate')).toBe(12)
      expect(count('active-minutes')).toBe(1)
      // And the whole-day run really did run past noon, so the cut is not vacuous.
      const whole = run({ days: DAYS }).filter((put) => put.windowStartMs === FINAL_DAY_START)
      expect(Math.max(...whole.flatMap(pointEnds))).toBeGreaterThan(NOON)
    })

    it('refuses a cutoff outside the final day', () => {
      expect(() => run({ days: DAYS, lastDayUntilMs: FINAL_DAY_START })).toThrow(/final day/)
      expect(() => run({ days: DAYS, lastDayUntilMs: END + 1 })).toThrow(/final day/)
      expect(() => run({ days: DAYS, lastDayUntilMs: END })).not.toThrow()
    })
  })
})
