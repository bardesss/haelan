import { afterEach, describe, expect, test } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
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

// The mean row for one downsampled minute. Four tests below check a minute's mean and n, and
// spelling the filter out at each one buried what they were actually claiming.
function meanAt(db: TestDatabase['db'], utcMs: number): unknown {
  return db.select().from(samples)
    .where(and(eq(samples.personId, 'p1'), eq(samples.utcMs, utcMs), eq(samples.agg, 'mean')))
    .get()
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

    const rows = db.select().from(samples)
      .where(and(eq(samples.personId, 'p1'), eq(samples.utcMs, 60_000))).all()
    expect(rows).toHaveLength(3)
    const byAgg = Object.fromEntries(rows.map((r) => [r.agg, r]))
    expect(byAgg.min).toMatchObject({ value: 100, n: 1 })
    expect(byAgg.mean).toMatchObject({ value: 100, n: 1 })
    expect(byAgg.max).toMatchObject({ value: 100, n: 1 })
    // Two episodes both wrote 3 rows each into mapper output, 6 total, but they upserted onto the
    // same 3 slots. counts.samples must report what the table now holds, not what the mappers
    // returned, or a re-fetch (which happens on every sync run) inflates this every single time.
    expect(counts.samples).toBe(3)
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
    // and leaves 60 standing, which is the reading Google had already replaced.
    const rows = db.select().from(samples).where(eq(samples.personId, 'p1')).all()
    expect(rows.every((row) => row.value === 100), 'the older reading overwrote the correction').toBe(true)
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
    const rows = db.select().from(samples).where(eq(samples.personId, 'p1')).all()
    expect(new Set(rows.map((r) => r.utcMs)).size).toBe(1)
    // A concrete number, not rows.length: counts.samples is measured against the table
    // independently of this query, and comparing it to a number derived from the very same table
    // would pass no matter what either side actually held.
    expect(counts.samples).toBe(3)
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
    // three aggregate rows), not a comparison to a length queried from the same table counts.
    // samples is now measured against: that comparison would pass regardless of which number,
    // right or wrong, both sides happened to agree on.
    expect(counts.samples).toBe(3)
    expect(db.select().from(samples).where(eq(samples.personId, 'p1')).all()).toHaveLength(3)
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
})
