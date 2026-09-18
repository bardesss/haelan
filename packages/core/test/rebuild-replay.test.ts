import { afterEach, describe, expect, test } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { replayPerson } from '../src/rebuild/replay.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import { samplePoint, sleepPoint, dailyRollupBody, body } from '../src/testing/payloads.ts'

import { createTestDatabase, readSamples, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { observations } from '../src/db/schema/index.ts'

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

// Same reading catalogue-ecg.test.ts and run-job.test.ts's fan-out test both use, so a failure
// here points at replay's own dispatch rather than at a payload shape unique to this file.
function ecgBody(): string {
  return body([{
    name: 'users/me/dataTypes/electrocardiogram/dataPoints/reading1',
    dataSource: {
      platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED',
      device: { displayName: 'Sense 2', formFactor: 'WATCH' },
    },
    electrocardiogram: {
      interval: {
        startTime: '2026-08-18T09:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-18T09:00:30Z', endUtcOffset: '7200s',
      },
      beatsPerMinuteAvg: '72',
      resultClassification: 'ATRIAL_FIBRILLATION',
      waveformSamples: Array.from({ length: 500 }, (_, i) => i % 40),
      samplingFrequencyHertz: 250,
      millivoltsScalingFactor: 1,
      leadNumber: 1,
      medicalDeviceInfo: { manufacturer: 'Acme', model: 'Watch 9' },
    },
  }])
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

// An exercise point carrying the detail fields M8a's mapper widened `attrs` onto: a name, moving
// time and one automatic split. Written out here rather than through a helper because which
// fields are present is the point of the test that uses it.
function exerciseBody(): string {
  return body([{
    name: 'users/me/dataTypes/exercise/dataPoints/run1',
    dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
    exercise: {
      interval: {
        startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-18T06:30:00Z', endUtcOffset: '7200s',
      },
      exerciseType: 'RUNNING',
      displayName: 'Evening Run',
      activeDuration: '1680s',
      splits: [{
        startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-18T06:06:19Z', endUtcOffset: '7200s',
        activeDuration: '379s', splitType: 'DISTANCE',
        metricsSummary: { distanceMillimeters: 1_000_000 },
      }],
    },
  }])
}

// The mean row for one downsampled minute. Four tests below check a minute's mean and n, and
// spelling the filter out at each one buried what they were actually claiming.
function meanAt(db: TestDatabase['db'], utcMs: number): unknown {
  // Through readSamples rather than a select, so the row comes back with its metric name and
  // aggregate spelled out. A ref-shaped assertion here would keep passing if the aggregate map
  // were reordered underneath it, which is the one thing that map must never survive.
  return readSamples(db, 'p1').find((row) => row.utcMs === utcMs && row.agg === 'mean')
}

describe('replayPerson', () => {
  test('a re-fetch of the same window replays as its own episode, not merged into the first', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two separate fetches of the same window, both single page (pageToken: null), the trailing
    // window re-fetch runSync does on every run. Google revised the minute's reading from 60 bpm
    // to 100 bpm between the two fetches. A sync would call mapWindowSamples once per fetch and
    // let the second upsert win outright: min 100, mean 100, max 100, n 1. Grouping both archived
    // rows into one mapWindowSamples call instead downsamples across both readings at once and
    // leaves min 60, mean 80, max 100, n 2, which is the bug this test pins.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([{ atMs: 60_000, bpm: 60 }]),
    })
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 2, httpStatus: 200,
      body: pageWithBeats([{ atMs: 60_000, bpm: 100 }]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    const rows = readSamples(db, 'p1').filter((row) => row.utcMs === 60_000)
    expect(rows).toHaveLength(4)
    const byAgg = Object.fromEntries(rows.map((r) => [r.agg, r]))
    expect(byAgg.min).toMatchObject({ value: 100, n: 1 })
    expect(byAgg.mean).toMatchObject({ value: 100, n: 1 })
    expect(byAgg.max).toMatchObject({ value: 100, n: 1 })
    // Two episodes both wrote 4 rows each into mapper output, 8 total, but they upserted onto the
    // same 4 slots. counts.samples must report what the table now holds, not what the mappers
    // returned, or a re-fetch (which happens on every sync run) inflates this every single time.
    expect(counts.samples).toBe(4)
  })

  test('replays two windows for one date in the order they were fetched, not the order their bounds sort in', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Day windows are aligned to the person's local day, so a timezone that moves westward gives
    // the same date earlier bounds than it had before. The later fetch then sorts BEFORE the one
    // it corrects under a window-first ordering, and replay lands the older reading last.
    //
    // Fetched first, at the old bounds, saying 60 bpm.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 86_400_000, windowEndMs: 172_800_000, fetchedAtMs: 100, httpStatus: 200,
      body: pageWithBeats([{ atMs: 100_000_000, bpm: 60 }]),
    })
    // Fetched second, after the move, so the same date now starts two hours earlier. This is the
    // reading that corrects the one above, and a replay has to land it last.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 79_200_000, windowEndMs: 165_600_000, fetchedAtMs: 200, httpStatus: 200,
      body: pageWithBeats([{ atMs: 100_000_000, bpm: 100 }]),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    // The correction wins, because it was fetched second. Ordering on window bounds puts it first
    // and leaves 60 standing, which is the reading Google had already replaced. The count row is
    // excluded here: its value is a tally of readings, one in this fixture, not a bpm figure.
    const rows = readSamples(db, 'p1')
    const bpmRows = rows.filter((row) => row.agg !== 'count')
    expect(bpmRows.every((row) => row.value === 100), 'the older reading overwrote the correction').toBe(true)
  })

  test('a two page window downsamples once, not once per page', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two readings inside the same minute, split across the two pages of one window, from a
    // data type whose catalogue entry sets downsampleToMinute. The second page's pageToken is a
    // continuation token, not null, so this stays one fetch episode rather than two.
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
    const rows = readSamples(db, 'p1')
    expect(new Set(rows.map((r) => r.utcMs)).size).toBe(1)
    // A concrete number, not rows.length: counts.samples is measured against the table
    // independently of this query, and comparing it to a number derived from the very same table
    // would pass no matter what either side actually held.
    expect(counts.samples).toBe(4)
    // 60 and 80 downsampled together: mean 70 over both readings, not two independent means.
    // Checking only the row count would also pass a page-by-page replay that happened to produce
    // the same number of rows for the wrong reason.
    const meanRow = rows.find((r) => r.agg === 'mean')
    expect(meanRow).toMatchObject({ value: 70, n: 2 })
  })

  test('the pages of one call are mapped together even when the archive hands them back out of order', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two pages of one call, archived in the same millisecond. listFor orders by fetch time, and
    // when that ties it falls through to the row id, which put() generates at
    // random: nothing stops a continuation page sorting ahead of its own start page. The
    // pageToken inference reads that order as two episodes, the second overwriting the first,
    // where the sync made one call and downsampled both pages at once.
    const first = archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      fetchEpisodeId: 'ep-1', body: pageWithBeats([{ atMs: 60_000, bpm: 60 }]),
    })
    const second = archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: { ...listParams, pageToken: 'p2' },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      fetchEpisodeId: 'ep-1', body: pageWithBeats([{ atMs: 90_000, bpm: 80 }]),
    })
    // Pinned rather than left to the random ids, which would decide this test by coin flip.
    db.run(sql`update raw_payloads set id = 'zzz-start' where id = ${first.id}`)
    db.run(sql`update raw_payloads set id = 'aaa-continuation' where id = ${second.id}`)

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    // 60 and 80 in one minute, downsampled together. Two episodes would leave whichever page
    // replayed last standing alone at n 1.
    expect(meanAt(db, 60_000)).toMatchObject({ value: 70, n: 2 })
  })

  test('a re-fetch whose first page was deduplicated does not blend into the call before it', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // One call of two pages, then a second call over the same window whose first page came back
    // byte identical and so was deduplicated away. Only the second call's changed second page is
    // a new row, and it carries a continuation token, so the pageToken inference has no null to
    // start an episode at and folds the correction into the call it corrects: minute two would
    // come out mean 80 over n 2 rather than the 100 the sync itself left.
    const shared = {
      personId: 'p1', dataType: 'heart-rate', windowStartMs: 0, windowEndMs: 86_400_000,
      httpStatus: 200,
    } as const
    const firstPage = pageWithBeats([{ atMs: 60_000, bpm: 60 }])
    // Fetch times are all distinct, so listFor orders these four calls to put() the one way and
    // never falls through to its random id tiebreak. Sharing a millisecond between two pages of
    // one call would leave their order, and with it whether the inference happens to guess right,
    // to a coin flip on every run.
    archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 1, fetchEpisodeId: 'ep-1',
      body: firstPage,
    })
    archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 2,
      fetchEpisodeId: 'ep-1', body: pageWithBeats([{ atMs: 120_000, bpm: 60 }]),
    })
    const deduplicated = archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 3, fetchEpisodeId: 'ep-2',
      body: firstPage,
    })
    expect(deduplicated.deduplicated).toBe(true)
    archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 4,
      fetchEpisodeId: 'ep-2', body: pageWithBeats([{ atMs: 120_000, bpm: 100 }]),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(meanAt(db, 120_000)).toMatchObject({ value: 100, n: 1 })
  })

  test('a payload archived before the episode id existed still replays through the pageToken inference', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // No fetchEpisodeId anywhere: the shape of every row a live instance archived before this
    // column, which is months of tier 1 truth and the only copy of it. Two pages of one call and
    // then a separate re-fetch, all inferred from pageToken exactly as they are today.
    const shared = {
      personId: 'p1', dataType: 'heart-rate', windowStartMs: 0, windowEndMs: 86_400_000,
      httpStatus: 200,
    } as const
    archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 1,
      body: pageWithBeats([{ atMs: 60_000, bpm: 50 }, { atMs: 120_000, bpm: 60 }]),
    })
    archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 2,
      body: pageWithBeats([{ atMs: 150_000, bpm: 80 }]),
    })
    archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 3,
      body: pageWithBeats([{ atMs: 60_000, bpm: 100 }]),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    // Minute two: both pages of the first call, downsampled together, 60 and 80 to a mean of 70.
    expect(meanAt(db, 120_000)).toMatchObject({ value: 70, n: 2 })
    // Minute one: the re-fetch is its own episode and overwrites the reading it corrects.
    expect(meanAt(db, 60_000)).toMatchObject({ value: 100, n: 1 })
  })

  test('an archive holding both kinds of row replays each by its own rule', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // What every upgraded instance looks like for as long as its oldest windows survive: rows
    // from before the column beside rows from after it, inside one window group. The old pair
    // has to keep grouping by pageToken and the new page by its recorded id, without either rule
    // swallowing the pages of the other. The new call is the deduplicated first page case again,
    // so the inference alone would fold its one surviving page into the call it corrects.
    const shared = {
      personId: 'p1', dataType: 'heart-rate', windowStartMs: 0, windowEndMs: 86_400_000,
      httpStatus: 200,
    } as const
    const firstPage = pageWithBeats([{ atMs: 60_000, bpm: 50 }, { atMs: 180_000, bpm: 60 }])
    archive.put({ ...shared, requestParams: listParams, fetchedAtMs: 1, body: firstPage })
    archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 2,
      body: pageWithBeats([{ atMs: 210_000, bpm: 80 }, { atMs: 120_000, bpm: 60 }]),
    })
    const deduplicated = archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 3, fetchEpisodeId: 'ep-2',
      body: firstPage,
    })
    expect(deduplicated.deduplicated).toBe(true)
    archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 4,
      fetchEpisodeId: 'ep-2', body: pageWithBeats([{ atMs: 120_000, bpm: 100 }]),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    // Minute three: the two pages with no id at all, still one call by the pageToken inference,
    // 60 and 80 downsampled together to a mean of 70.
    expect(meanAt(db, 180_000)).toMatchObject({ value: 70, n: 2 })
    // Minute two: the recorded page is its own call and corrects the 60 outright. Grouped by the
    // inference instead it would join the call above and leave a mean of 80 over n 2.
    expect(meanAt(db, 120_000)).toMatchObject({ value: 100, n: 1 })
    // Minute one: untouched by the correction, so the old call's reading stands.
    expect(meanAt(db, 60_000)).toMatchObject({ value: 50, n: 1 })
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
    // sleepBody's two stages, LIGHT and DEEP, as a concrete number rather than toBeGreaterThan(0):
    // counts.segments is now measured from the table, so a wrong but positive count would pass
    // an inequality check just as well as the right one.
    expect(counts.segments).toBe(2)
    expect(db.select().from(sessions).all()).toHaveLength(1)
  })

  test('writes an exercise session with its detail attrs from the archive alone, with no re-fetch', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'exercise', requestParams: listParams,
      windowStartMs: Date.parse('2026-08-18T00:00:00Z'),
      windowEndMs: Date.parse('2026-08-19T00:00:00Z'),
      fetchedAtMs: 1, httpStatus: 200,
      body: exerciseBody(),
    })

    // The state a person carrying an older mapping version is in when the rebuild starts: the
    // payload is on disk and the session row is not, because runRebuild empties tier 2 first.
    expect(db.select().from(sessions).where(eq(sessions.personId, 'p1')).all()).toHaveLength(0)

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    const rows = db.select().from(sessions).where(eq(sessions.personId, 'p1')).all()
    expect(rows).toHaveLength(1)
    const attrs = JSON.parse(rows[0]!.attrs) as Record<string, unknown>
    // The whole justification for a mapping bump rather than a re-fetch: an archived payload that
    // was mapped onto seven keys is re-mapped onto fourteen, so a workout that happened before
    // the release becomes as detailed as one that happens after it. Nothing was fetched here.
    expect(attrs.displayName).toBe('Evening Run')
    expect(attrs.activeDuration).toBe('1680s')
    expect(attrs.splits).toHaveLength(1)
    expect((attrs.splits as Record<string, unknown>[])[0]?.splitType).toBe('DISTANCE')
  })

  // The bug this pins: electrocardiogram declares target: 'sessions' with
  // alsoTargets: ['samples', 'observations'], and replayPerson used to dispatch on t.target
  // alone. runRebuild empties tier 2 before calling replayPerson, so that bug did not just leave
  // the sample and observation rows unwritten - a rebuild deleted an existing ECG's heart rate
  // sample and classification observation and never put them back. One row in each of the three
  // tables, not merely ">0" in any of them: a dispatch that ran a writer twice, or ran the wrong
  // one, could still pass a looser check.
  test('an ECG payload replays into all three tables its alsoTargets name', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'electrocardiogram', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: ecgBody(),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.sessions).toBe(1)
    expect(counts.samples).toBe(1)
    expect(counts.observations).toBe(1)

    const sessionRows = db.select().from(sessions).where(eq(sessions.personId, 'p1')).all()
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0]?.kind).toBe('ecg')

    const sampleRows = readSamples(db, 'p1')
    expect(sampleRows).toHaveLength(1)
    expect(sampleRows[0]).toMatchObject({ metric: 'ecg_heart_rate', value: 72, agg: 'raw' })

    const observationRows = db.select().from(observations).where(eq(observations.personId, 'p1')).all()
    expect(observationRows).toHaveLength(1)
    expect(observationRows[0]).toMatchObject({ kind: 'ecg_classification', value: 'ATRIAL_FIBRILLATION' })

    // The session's own local date and the samples/observations dates coincide here (same
    // instant), but localDates must still be the union across every branch that ran: a merge
    // that kept only the primary target's dates would happen to pass this assertion by
    // coincidence rather than by covering the property it exists to check.
    expect(counts.localDates).toEqual(['2026-08-18'])
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

  test('a payload whose data type left the catalogue is counted, not thrown, and does not cost its siblings', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'retired-type', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200, body: '{}',
    })
    // A live type archived alongside the retired one. The property under test is that one type
    // leaving the catalogue must not cost the person the rebuild of everything else, which a
    // single-payload test cannot show: it would pass just as well if the retired payload silently
    // stopped the whole walk.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 86_400_000, windowEndMs: 172_800_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([{ atMs: 90_000_000, bpm: 60 }]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.unmappable).toBe(1)
    // The live payload's own concrete count (one heart-rate reading downsamples to one minute,
    // four aggregate rows), not a comparison to a length queried from the same table counts.
    // samples is now measured against: that comparison would pass regardless of which number,
    // right or wrong, both sides happened to agree on.
    expect(counts.samples).toBe(4)
    expect(readSamples(db, 'p1')).toHaveLength(4)
  })

  test('the local dates the rows landed on come back sorted, deduplicated, and including rollup-only dates', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two heart rate readings on the same local date, at different times, so a set that failed to
    // deduplicate would show up as a repeated entry.
    archive.put({
      personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: pageWithBeats([
        { atMs: Date.parse('2026-08-01T10:00:00Z'), bpm: 60 },
        { atMs: Date.parse('2026-08-01T15:00:00Z'), bpm: 70 },
      ]),
    })
    // A sleep session ending on a different date. Sessions have to contribute their own date, not
    // just samples.
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 172_800_000, windowEndMs: 259_200_000, fetchedAtMs: 1, httpStatus: 200,
      body: sleepBody(),
    })
    // A rollup on a third date entirely, with no sample and no session anywhere near it. This
    // date has to be present. Deriving it writes no derived rows, since there is nothing
    // underneath a provider figure to roll up, but deriveDayInto is the only path that applies a
    // day_metric exclusion to a PROVIDER_SOURCE row, and it only runs for the dates named here.
    // Leave this date out and a correction on that figure is silently undone by every rebuild.
    archive.put({
      personId: 'p1', dataType: 'total-calories',
      requestParams: { range: { start: {}, end: {} } },
      windowStartMs: 432_000_000, windowEndMs: 518_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: rollupBody('2026-08-05', 2100),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.localDates).toEqual(['2026-08-01', '2026-08-05', '2026-08-18'])
  })

  // The rebuild's own daily row insert site. Every other insert site stamps updated_at_ms; this
  // one and runRollupJob's write path did not, and the oldest days a household carries are
  // commonly a provider row with no samples underneath at all, so those rows sat permanently
  // outside the change feed the column exists for.
  test('stamps a replayed provider row with the clock it was given', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'total-calories',
      requestParams: { range: { start: {}, end: {} } },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: rollupBody('2026-08-01', 2100),
    })

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1_700_000_000_000,
    }))

    const rows = db.select().from(daily).where(eq(daily.personId, 'p1')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.updatedAtMs).toBe(1_700_000_000_000)
  })
})

// Issue #274: on a real instance an image update moved DERIVATION_VERSION 7 -> 9, the boot rebuild
// that triggers threw `UNIQUE constraint failed: session_segments.id` at replay.ts's segment
// insert, and the only person on the instance was quarantined - every sync run skipped them, on
// every restart, with no way back without a code change. The duplicate is inside a single archived
// body, which is the one case the per-session delete above the insert cannot absorb, because every
// delete for a page runs before any insert for it.
describe('replayPerson, a body that repeats itself (#274)', () => {
  test('replays a session whose stage list repeats a type and start, rather than throwing', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: body([sleepPoint({
        startTime: '2026-08-17T21:30:00Z',
        endTime: '2026-08-18T05:15:00Z',
        stages: [
          { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T23:00:00Z' },
          // Same type, same start: one segment id, two rows, and the insert threw on the second.
          { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T23:30:00Z' },
          { type: 'DEEP', startTime: '2026-08-17T23:00:00Z', endTime: '2026-08-18T00:30:00Z' },
        ],
      })]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.sessions).toBe(1)
    expect(counts.segments).toBe(2)
    expect(db.select().from(sessions).all()).toHaveLength(1)
  })

  test('replays one body naming the same session twice, keeping the later stage timeline', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    const night = (stage: string): Record<string, unknown> => sleepPoint({
      name: 'users/me/dataTypes/sleep/dataPoints/twice',
      startTime: '2026-08-17T21:30:00Z',
      endTime: '2026-08-18T05:15:00Z',
      stages: [{ type: stage, startTime: '2026-08-17T23:00:00Z', endTime: '2026-08-18T05:15:00Z' }],
    })
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: body([night('DEEP'), night('REM')]),
    })

    const counts = db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    expect(counts.sessions).toBe(1)
    // One timeline, not the union of the superseded copy's and the one that replaced it.
    expect(counts.segments).toBe(1)
  })
})
