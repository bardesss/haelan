import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../db/open.ts'
import { migrateToLatest } from '../db/migrate.ts'
import {
  people, sources, sourcePriority, samples, sessions, sessionSegments, overrides, rawPayloads,
  syncState, deriveQueue, daily,
} from '../db/schema/index.ts'
import type { SessionKind, SampleAgg } from '../db/schema/index.ts'
import type { Database } from '../db/open.ts'
import type { OverrideScope } from '../derive/targetKey.ts'
import { RawArchive } from '../store/rawArchive.ts'
import { PeopleStore } from '../store/people.ts'
import { DeriveQueue } from '../store/deriveQueue.ts'
import { SourcePriorityStore } from '../store/sourcePriority.ts'
import { OverrideStore } from '../store/overrides.ts'
import { SettingsStore } from '../store/settings.ts'
import { body, dailyRollupBody, samplePoint, sleepPoint } from './payloads.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'

export interface TestDatabase { db: Database, dir: string, cleanup: () => void }

export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-test-'))
  const db = openDatabase(dir)
  // Every later plan calls this in a beforeEach; a migration that throws must not leave a
  // dangling handle and temp dir behind for every test in the run.
  try {
    migrateToLatest(db)
  } catch (err) {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { db, dir, cleanup: () => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) } }
}

export interface SeedPersonOverrides { timezone?: string, displayName?: string, createdAtMs?: number }

export function seedPerson(db: Database, id: string, overrides: SeedPersonOverrides = {}): string {
  db.insert(people).values({
    id,
    displayName: overrides.displayName ?? id,
    timezone: overrides.timezone ?? 'Europe/Amsterdam',
    createdAtMs: overrides.createdAtMs ?? 0,
  }).run()
  return id
}

/**
 * Ruins every archived body this person has, so any replay of them throws.
 *
 * Archived first and ruined afterwards because `RawArchive.put` gzips whatever it is handed, so
 * there is no body that survives storage and then fails to decompress. What this stands in for
 * is the hazard the rebuild has to survive: a payload it cannot get through. Which payload, and
 * why, is not what the callers assert; that the throw happens inside the person's transaction
 * is.
 */
export function corruptArchivedBodies(db: Database, personId: string): void {
  db.update(rawPayloads).set({ bodyGzip: Buffer.from('not gzip at all', 'utf8') })
    .where(eq(rawPayloads.personId, personId)).run()
}

export interface DerivableDay { personId: string, localDate: string }

// One person, one source, one sample on one local date: the minimum a derivation needs to
// produce a row. Shared by tests that only need a day worth deriving and do not care what is
// in it, so a rebuild test and a queue drain test are not each inventing their own person.
export function seedDerivableDay(db: Database): DerivableDay {
  const personId = 'p1'
  const localDate = '2026-08-22'
  seedPerson(db, personId)
  db.insert(sources).values({
    id: 'watch', personId, externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  db.insert(samples).values({
    personId, sourceId: 'watch', metric: 'steps',
    utcMs: Date.parse(`${localDate}T09:00:00Z`), tzOffsetMinutes: 0,
    agg: 'raw', value: 400, n: 1, rawPayloadId: null,
  }).run()
  return { personId, localDate }
}

export interface SeedSampleInput {
  personId: string
  sourceId: string
  metric: string
  utcMs: number
  value?: number
  // Defaults to 'raw'. A caller seeding more than one row at the same person, source, metric and
  // instant has to vary this, because samples_natural is unique on all five columns together and
  // that is exactly what per-minute downsampling does: one row per aggregate, same instant.
  agg?: SampleAgg
}

// Creates the source row a sample references as well as the sample itself, so a retarget test
// naming a source id it has never seen does not have to seed the source separately. Returns the
// source id: samples have no id column of their own to hand back.
export function seedSample(db: Database, input: SeedSampleInput): string {
  db.insert(sources).values({
    id: input.sourceId, personId: input.personId, externalId: input.sourceId,
    displayName: input.sourceId, kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
  db.insert(samples).values({
    personId: input.personId, sourceId: input.sourceId, metric: input.metric, utcMs: input.utcMs,
    tzOffsetMinutes: 0, agg: input.agg ?? 'raw', value: input.value ?? 1, n: 1, rawPayloadId: null,
  }).run()
  return input.sourceId
}

export interface SeedSessionInput {
  id: string
  personId: string
  kind: SessionKind
  externalId: string
}

// Creates the source row the session references as well as the session itself. The source id is
// synthesized from the session id: nothing in this milestone's tests cares what it is, only that
// a session always has one, the way a real session does.
export function seedSession(db: Database, input: SeedSessionInput): string {
  const sourceId = `source-for-${input.id}`
  db.insert(sources).values({
    id: sourceId, personId: input.personId, externalId: sourceId,
    displayName: sourceId, kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
  db.insert(sessions).values({
    id: input.id, personId: input.personId, sourceId, kind: input.kind, externalId: input.externalId,
    startMs: 0, startOffsetMinutes: 0, endMs: 0, endOffsetMinutes: 0,
    localDate: '1970-01-01', attrs: '{}', rawPayloadId: null,
  }).run()
  return input.id
}

export interface SeedOverrideInput {
  personId: string
  scope: OverrideScope
  targetKey: string
  action?: 'exclude' | 'correct'
  correctedValue?: number
  reason?: string
  createdAtMs?: number
}

// Inserts straight into the overrides table rather than going through OverrideStore.put, because
// put also marks derived days dirty and a retarget test is about the key alone.
export function seedOverride(db: Database, input: SeedOverrideInput): string {
  const id = randomUUID()
  db.insert(overrides).values({
    id,
    personId: input.personId,
    scope: input.scope,
    targetKey: input.targetKey,
    action: input.action ?? 'exclude',
    correctedValue: input.correctedValue ?? null,
    reason: input.reason ?? 'test',
    createdAtMs: input.createdAtMs ?? 0,
  }).run()
  return id
}

export interface RebuildDeps {
  db: Database
  archive: RawArchive
  peopleStore: PeopleStore
  priority: SourcePriorityStore
  overrides: OverrideStore
  settings: SettingsStore
}

export interface SecondPersonRows {
  samples: (typeof samples.$inferSelect)[]
  sessions: (typeof sessions.$inferSelect)[]
  daily: (typeof daily.$inferSelect)[]
}

export interface Rebuildable {
  db: Database
  personId: string
  /** Everything runRebuild needs except nowMs, so a caller spreads this and adds the clock. */
  deps: RebuildDeps
  cleanup: () => void
  /**
   * A second household member with an archive and rows of their own, returned so a test can
   * compare them. All three tables a person transaction empties, because asserting only over
   * samples would let a delete that forgot its person filter on sessions or daily pass.
   */
  seedSecondPerson: () => SecondPersonRows
  /** Makes one archived body ungzippable, which is the cheapest honest way to fail a replay. */
  corruptOneArchivedBody: () => void
  /**
   * Every row of the five tables a rebuild writes, each sorted by its own full natural key
   * rather than however sqlite happens to have stored it. A property asserting that a second
   * rebuild changes nothing needs two of these to compare equal, which insertion order alone
   * could not promise even when the rows themselves are identical.
   */
  snapshot: () => RebuildableSnapshot
}

export interface RebuildableSnapshot {
  sources: (typeof sources.$inferSelect)[]
  samples: (typeof samples.$inferSelect)[]
  sessions: (typeof sessions.$inferSelect)[]
  sessionSegments: (typeof sessionSegments.$inferSelect)[]
  daily: (typeof daily.$inferSelect)[]
}

export interface SeedRebuildableOptions {
  /**
   * What the archived payloads claim recorded them. The source registry derives a source's
   * identity from this, so a caller exploring which identities survive a rebuild chooses it.
   * Sugar for `dataSources: [dataSource]`; ignored when `dataSources` is also given.
   */
  dataSource?: Record<string, unknown>
  /**
   * Several descriptors, one archived heart-rate window per descriptor, so a caller can seed more
   * than one source at once. The first descriptor also carries the sleep night and the rollup, so
   * the singular `dataSource` above (or the default) still produces exactly what this fixture has
   * always produced.
   */
  dataSources?: Record<string, unknown>[]
}

/** The one local date every archived payload in the fixture lands on. */
export const REBUILDABLE_DATE = '2026-08-18'
const REBUILDABLE_WINDOW_START = Date.parse(`${REBUILDABLE_DATE}T00:00:00Z`)

/**
 * The provider's own name for the archived night, which mapSessions uses as the session's
 * external id. Exported because it is the one part of a session's identity that re-resolving a
 * source cannot move, so a test about overrides following their session has to name it.
 */
export const REBUILDABLE_SLEEP_EXTERNAL_ID = 'users/me/dataTypes/sleep/dataPoints/abc'

// Same envelope shape map-samples.test.ts and rebuild-replay.test.ts use for heart rate: a list
// response whose points carry sampleTime and beatsPerMinute, and an explicit dataSource because
// the source registry derives a source's identity from it. windowStartMs is a parameter rather
// than always REBUILDABLE_WINDOW_START so several descriptors can each get a window of their own
// and stay independently inspectable instead of merging into one window's samples.
function heartRateBody(dataSource: Record<string, unknown>, windowStartMs: number): string {
  return body([
    { atMs: windowStartMs + 10 * 3_600_000, bpm: 62 },
    { atMs: windowStartMs + 11 * 3_600_000, bpm: 71 },
  ].map((b) => samplePoint({
    payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(b.bpm),
    physicalTime: new Date(b.atMs).toISOString(), dataSource,
  })))
}

// Same envelope shape map-sessions.test.ts uses for sleep: one point carrying an interval and a
// couple of stages. It ends on REBUILDABLE_DATE, so the night and the readings share a day and
// one derived date covers both.
function sleepNightBody(dataSource: Record<string, unknown>): string {
  return body([sleepPoint({
    name: REBUILDABLE_SLEEP_EXTERNAL_ID,
    startTime: '2026-08-17T21:30:00Z',
    endTime: `${REBUILDABLE_DATE}T05:15:00Z`,
    stages: [
      { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T23:00:00Z' },
      { type: 'DEEP', startTime: '2026-08-17T23:00:00Z', endTime: `${REBUILDABLE_DATE}T00:30:00Z` },
    ],
    dataSource,
  })])
}

// Same envelope shape map-rollups.test.ts and rebuild-replay.test.ts use for total calories:
// rollupDataPoints keyed by civil date, with the payload's own value object nested under its
// payload key. Archived because a provider daily row can only ever come from one of these, and a
// rebuild that spared them would leave a retired mapping's figures on the dashboard forever.
function rollupBody(localDate: string, kcal: number): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number]
  return dailyRollupBody('totalCalories', [{ date: { year, month, day }, value: { kcalSum: kcal } }])
}

const REBUILDABLE_LIST_PARAMS = { filter: 'x', pageSize: 1000, pageToken: null }

/**
 * Archives the heart-rate windows, the sleep night and the rollup, and writes the sync_state row.
 * Shared between `seedRebuildable`, which does this once against a brand new file, and
 * `openRebuildLab`'s `reset`, which does it again and again against the same file after clearing
 * every row it wrote last time. Neither caller does anything to the archived payloads that the
 * other does not, so a fix made here reaches both without the two drifting apart.
 */
function archiveRebuildablePayloads(
  db: Database, archive: RawArchive, personId: string, options: SeedRebuildableOptions,
): void {
  const dataSources = options.dataSources
    ?? [options.dataSource ?? { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' }]
  // One heart-rate window per descriptor, each on its own day: a shared window would let two
  // descriptors' readings collide on nothing (different dataSource, different bodyHash, so the
  // archive keeps both), but putting them on separate days keeps every descriptor's samples
  // independently inspectable rather than downsampled together into one window.
  dataSources.forEach((dataSource, i) => {
    const windowStartMs = REBUILDABLE_WINDOW_START + i * 86_400_000
    archive.put({
      personId, dataType: 'heart-rate', requestParams: REBUILDABLE_LIST_PARAMS,
      windowStartMs, windowEndMs: windowStartMs + 86_400_000,
      fetchedAtMs: 1, httpStatus: 200, body: heartRateBody(dataSource, windowStartMs),
    })
  })
  archive.put({
    personId, dataType: 'sleep', requestParams: REBUILDABLE_LIST_PARAMS,
    windowStartMs: REBUILDABLE_WINDOW_START, windowEndMs: REBUILDABLE_WINDOW_START + 86_400_000,
    fetchedAtMs: 1, httpStatus: 200, body: sleepNightBody(dataSources[0]!),
  })
  // A rollup response, which is the only thing that ever produces a provider daily row. The
  // range in requestParams is what tells the replay this was a rollup call rather than a list
  // one, so it cannot be omitted.
  archive.put({
    personId, dataType: 'total-calories', requestParams: { range: { start: {}, end: {} } },
    windowStartMs: REBUILDABLE_WINDOW_START, windowEndMs: REBUILDABLE_WINDOW_START + 86_400_000,
    fetchedAtMs: 1, httpStatus: 200, body: rollupBody(REBUILDABLE_DATE, 2100),
  })

  // A high water mark and a backfill cursor, the two things a rebuild must not reset. Without a
  // row here the test that pins that compares an empty table to an empty table.
  db.insert(syncState).values({
    personId, dataType: 'heart-rate',
    highWaterMs: REBUILDABLE_WINDOW_START + 86_400_000,
    backfillCursorMs: REBUILDABLE_WINDOW_START,
    lastSuccessAtMs: 1,
  }).run()
}

/**
 * Every row of the five tables a rebuild writes, each sorted by its own full natural key. Shared
 * by `seedRebuildable` and `openRebuildLab` so the two fixtures hand a property test the same
 * definition of "unchanged" to compare against.
 */
function snapshotOf(db: Database): RebuildableSnapshot {
  return {
    sources: db.select().from(sources)
      .orderBy(asc(sources.personId), asc(sources.externalId), asc(sources.id)).all(),
    samples: db.select().from(samples)
      .orderBy(
        asc(samples.personId), asc(samples.sourceId), asc(samples.metric),
        asc(samples.utcMs), asc(samples.agg),
      ).all(),
    sessions: db.select().from(sessions)
      .orderBy(
        asc(sessions.personId), asc(sessions.sourceId), asc(sessions.kind),
        asc(sessions.externalId), asc(sessions.id),
      ).all(),
    // Ordered by session, stage and start rather than id: two rows sharing all three would be
    // two segments of the same stage starting at the same instant, which is not a shape the
    // fixture or the mappers produce, so id only has to break a tie that cannot occur. It is
    // still included last, because a sort that silently depended on that never happening would
    // be the kind of thing this fixture exists to not do.
    sessionSegments: db.select().from(sessionSegments)
      .orderBy(
        asc(sessionSegments.sessionId), asc(sessionSegments.stage),
        asc(sessionSegments.startMs), asc(sessionSegments.id),
      ).all(),
    daily: db.select().from(daily)
      .orderBy(
        asc(daily.personId), asc(daily.localDate), asc(daily.metric),
        asc(daily.agg), asc(daily.source),
      ).all(),
  }
}

// The one database the most recent seedRebuildable handed out, so the next call can close it.
let openRebuildable: { cleanup: () => void } | null = null

/**
 * A database that has everything a rebuild needs and nothing it should have to invent: one
 * person, one archived heart rate window, one archived sleep window, one archived daily rollup,
 * and a sync_state row that a rebuild must leave exactly where it found it.
 *
 * Tiers 2 and 3 are deliberately left empty. Every row a rebuild test asserts on comes from the
 * archive by way of the real mappers, which is the property the milestone is about; seeding
 * samples directly would prove only that the fixture can write samples.
 *
 * ONE LIVE DATABASE AT A TIME. Each call closes the database the previous call handed out, so a
 * caller cannot hold two of these open at once. That is deliberate: a later task drives this
 * from inside a fast-check property, which runs hundreds of cases inside a single test body and
 * so fires afterEach exactly once, at the end. Without the close here, every generated case
 * would leak a temp directory and an open sqlite handle. `cleanup` is idempotent, so calling it
 * from a hook as well costs nothing.
 */
export function seedRebuildable(options: SeedRebuildableOptions = {}): Rebuildable {
  openRebuildable?.cleanup()

  const t = createTestDatabase()
  const db = t.db
  const personId = 'p1'
  seedPerson(db, personId)

  const archive = new RawArchive(db)
  archiveRebuildablePayloads(db, archive, personId, options)

  const queue = new DeriveQueue(db)
  const deps: RebuildDeps = {
    db,
    archive,
    peopleStore: new PeopleStore(db),
    priority: new SourcePriorityStore(db, queue),
    overrides: new OverrideStore(db, queue),
    settings: new SettingsStore(db),
  }

  let closed = false
  const handle: Rebuildable = {
    db,
    personId,
    deps,
    cleanup: () => {
      // Idempotent, because the afterEach hook and the next seedRebuildable both call it and
      // closing an already closed better-sqlite3 handle throws.
      if (closed) return
      closed = true
      if (openRebuildable === handle) openRebuildable = null
      t.cleanup()
    },
    seedSecondPerson: () => {
      const otherId = 'p2'
      seedPerson(db, otherId)
      // An archive of their own, under a different platform and package so their sources are
      // genuinely different identities. Without this the second person is never replayed at all,
      // and every claim about doing per person work holds vacuously for them.
      archive.put({
        personId: otherId, dataType: 'heart-rate', requestParams: REBUILDABLE_LIST_PARAMS,
        windowStartMs: REBUILDABLE_WINDOW_START, windowEndMs: REBUILDABLE_WINDOW_START + 86_400_000,
        fetchedAtMs: 1, httpStatus: 200,
        body: heartRateBody({
          platform: 'HEALTH_CONNECT',
          application: { packageName: 'com.example.other' },
          recordingMethod: 'PASSIVELY_MEASURED',
        }, REBUILDABLE_WINDOW_START),
      })
      // A row in each of the three tables a person transaction empties. One table is not enough:
      // a delete that lost its person filter on sessions or on daily has to fail as loudly as
      // one that lost it on samples.
      seedSample(db, {
        personId: otherId, sourceId: 'p2-watch', metric: 'steps',
        utcMs: Date.parse(`${REBUILDABLE_DATE}T09:00:00Z`), value: 900,
      })
      seedSession(db, {
        id: 'p2-night', personId: otherId, kind: 'sleep', externalId: 'p2-night-external',
      })
      db.insert(daily).values({
        personId: otherId, localDate: REBUILDABLE_DATE, metric: 'steps', agg: 'sum',
        source: 'p2-watch', value: 900, coverage: null, sourceMix: null,
        derivationVersion: DERIVATION_VERSION,
      }).run()
      return {
        samples: db.select().from(samples).where(eq(samples.personId, otherId)).all(),
        sessions: db.select().from(sessions).where(eq(sessions.personId, otherId)).all(),
        daily: db.select().from(daily).where(eq(daily.personId, otherId)).all(),
      }
    },
    corruptOneArchivedBody: () => {
      // Ordered, so which body is ruined is the same on every run. An unordered get() would
      // leave a rollback test that passes or fails on sqlite's row order.
      const row = db.select({ id: rawPayloads.id }).from(rawPayloads)
        .where(eq(rawPayloads.personId, personId))
        .orderBy(asc(rawPayloads.dataType), asc(rawPayloads.id)).get()
      if (!row) throw new Error('seedRebuildable archived nothing to corrupt')
      db.update(rawPayloads).set({ bodyGzip: Buffer.from('not gzip at all', 'utf8') })
        .where(eq(rawPayloads.id, row.id)).run()
    },
    snapshot: () => snapshotOf(db),
  }
  openRebuildable = handle
  return handle
}

export interface RebuildLab {
  db: Database
  personId: string
  /** Everything runRebuild needs except nowMs, so a caller spreads this and adds the clock. */
  deps: RebuildDeps
  /**
   * Wipes every row this fixture writes and reseeds fresh archived payloads for `personId`,
   * without recreating the sqlite file or re-running its migrations. Safe to call any number of
   * times against the same lab, which is the entire reason this exists: a fast-check property
   * calls it once per generated case instead of calling `seedRebuildable` and paying for a fresh
   * file and seven migrations every time.
   */
  reset: (options?: SeedRebuildableOptions) => void
  /** Same definition of "every row that matters" as `Rebuildable.snapshot`. */
  snapshot: () => RebuildableSnapshot
  cleanup: () => void
}

/**
 * A rebuild fixture that pays sqlite's setup cost once instead of once per fast-check run.
 *
 * `seedRebuildable` creates a fresh file and runs every migration on each call, because its other
 * callers each call it once or twice per test. A property test calling it fifty times inside one
 * `fc.assert` pays that migration cost fifty times for work the property itself never reads:
 * `runRebuild` only ever touches the tables `reset` clears below. Measured, opening a fresh
 * database and migrating it costs around half of what one full `seedRebuildable` call spends, and
 * it is the syscall-heavy half, which is exactly the part that gets worse under the parallelism a
 * full `vitest run` runs everything under.
 *
 * `reset` clearing rows and reseeding is only as safe as a fresh file if nothing upstream of it
 * can tell the difference, which is what this instance's own unique constraints
 * (`sources_person_external`, `samples_natural`, `sessions_natural`, `daily_natural`) guarantee:
 * every row this fixture or a rebuild ever writes is addressed by its natural key, never by
 * anything a leftover row from a previous case could collide with once that case's own rows are
 * gone.
 */
export function openRebuildLab(): RebuildLab {
  const t = createTestDatabase()
  const db = t.db
  const personId = 'p1'
  const archive = new RawArchive(db)
  const queue = new DeriveQueue(db)
  const deps: RebuildDeps = {
    db,
    archive,
    peopleStore: new PeopleStore(db),
    priority: new SourcePriorityStore(db, queue),
    overrides: new OverrideStore(db, queue),
    settings: new SettingsStore(db),
  }

  const reset = (options: SeedRebuildableOptions = {}): void => {
    // Children before the parents they reference, and sources and people last of all: sources
    // and people are what samples, sessions, source_priority, raw_payloads, sync_state and
    // derive_queue all point at, and PRAGMA foreign_keys = ON (set on every connection this
    // package opens) rejects a delete order that got that backwards.
    db.delete(sessionSegments).run()
    db.delete(sessions).run()
    db.delete(samples).run()
    db.delete(sourcePriority).run()
    db.delete(overrides).run()
    db.delete(daily).run()
    db.delete(sources).run()
    db.delete(rawPayloads).run()
    db.delete(syncState).run()
    db.delete(deriveQueue).run()
    db.delete(people).run()

    seedPerson(db, personId)
    archiveRebuildablePayloads(db, archive, personId, options)
  }

  return {
    db,
    personId,
    deps,
    reset,
    snapshot: () => snapshotOf(db),
    cleanup: t.cleanup,
  }
}
