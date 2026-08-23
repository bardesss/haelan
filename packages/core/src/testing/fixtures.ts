import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../db/open.ts'
import { migrateToLatest } from '../db/migrate.ts'
import { people, sources, samples, sessions, overrides, rawPayloads, syncState } from '../db/schema/index.ts'
import type { SessionKind, SampleAgg } from '../db/schema/index.ts'
import type { Database } from '../db/open.ts'
import type { OverrideScope } from '../derive/targetKey.ts'
import { RawArchive } from '../store/rawArchive.ts'
import { PeopleStore } from '../store/people.ts'
import { DeriveQueue } from '../store/deriveQueue.ts'
import { SourcePriorityStore } from '../store/sourcePriority.ts'
import { OverrideStore } from '../store/overrides.ts'
import { SettingsStore } from '../store/settings.ts'
import { body, samplePoint, sleepPoint } from './payloads.ts'

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

export interface Rebuildable {
  db: Database
  personId: string
  /** Everything runRebuild needs except nowMs, so a caller spreads this and adds the clock. */
  deps: RebuildDeps
  cleanup: () => void
  /** A second household member with rows of their own, returned so a test can compare them. */
  seedSecondPerson: () => (typeof samples.$inferSelect)[]
  /** Makes one archived body ungzippable, which is the cheapest honest way to fail a replay. */
  corruptOneArchivedBody: () => void
}

export interface SeedRebuildableOptions {
  /**
   * What the archived payloads claim recorded them. The source registry derives a source's
   * identity from this, so a caller exploring which identities survive a rebuild chooses it.
   */
  dataSource?: Record<string, unknown>
}

const REBUILDABLE_DATE = '2026-08-18'
const REBUILDABLE_WINDOW_START = Date.parse(`${REBUILDABLE_DATE}T00:00:00Z`)

/**
 * The provider's own name for the archived night, which mapSessions uses as the session's
 * external id. Exported because it is the one part of a session's identity that re-resolving a
 * source cannot move, so a test about overrides following their session has to name it.
 */
export const REBUILDABLE_SLEEP_EXTERNAL_ID = 'users/me/dataTypes/sleep/dataPoints/abc'

// Same envelope shape map-samples.test.ts and rebuild-replay.test.ts use for heart rate: a list
// response whose points carry sampleTime and beatsPerMinute, and an explicit dataSource because
// the source registry derives a source's identity from it.
function heartRateBody(dataSource: Record<string, unknown>): string {
  return body([
    { atMs: Date.parse(`${REBUILDABLE_DATE}T10:00:00Z`), bpm: 62 },
    { atMs: Date.parse(`${REBUILDABLE_DATE}T11:00:00Z`), bpm: 71 },
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

// The one database the most recent seedRebuildable handed out. A later task drives this fixture
// from inside a fast-check property, which runs hundreds of cases inside a single test body and
// so fires afterEach exactly once, at the end. Closing the previous handle as the next one is
// made keeps that from leaking a temp directory and an open sqlite file per generated case.
let openRebuildable: { cleanup: () => void } | null = null

/**
 * A database that has everything a rebuild needs and nothing it should have to invent: one
 * person, one archived heart rate window, one archived sleep window, and a sync_state row that a
 * rebuild must leave exactly where it found it.
 *
 * Tiers 2 and 3 are deliberately left empty. Every row a rebuild test asserts on comes from the
 * archive by way of the real mappers, which is the property the milestone is about; seeding
 * samples directly would prove only that the fixture can write samples.
 */
export function seedRebuildable(options: SeedRebuildableOptions = {}): Rebuildable {
  openRebuildable?.cleanup()

  const t = createTestDatabase()
  const db = t.db
  const personId = 'p1'
  seedPerson(db, personId)

  const dataSource = options.dataSource ?? { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' }
  const archive = new RawArchive(db)
  const listParams = { filter: 'x', pageSize: 1000, pageToken: null }
  archive.put({
    personId, dataType: 'heart-rate', requestParams: listParams,
    windowStartMs: REBUILDABLE_WINDOW_START, windowEndMs: REBUILDABLE_WINDOW_START + 86_400_000,
    fetchedAtMs: 1, httpStatus: 200, body: heartRateBody(dataSource),
  })
  archive.put({
    personId, dataType: 'sleep', requestParams: listParams,
    windowStartMs: REBUILDABLE_WINDOW_START, windowEndMs: REBUILDABLE_WINDOW_START + 86_400_000,
    fetchedAtMs: 1, httpStatus: 200, body: sleepNightBody(dataSource),
  })

  // A high water mark and a backfill cursor, the two things a rebuild must not reset. Without a
  // row here the test that pins that compares an empty table to an empty table.
  db.insert(syncState).values({
    personId, dataType: 'heart-rate',
    highWaterMs: REBUILDABLE_WINDOW_START + 86_400_000,
    backfillCursorMs: REBUILDABLE_WINDOW_START,
    lastSuccessAtMs: 1,
  }).run()

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
      seedPerson(db, 'p2')
      seedSample(db, {
        personId: 'p2', sourceId: 'p2-watch', metric: 'steps',
        utcMs: Date.parse(`${REBUILDABLE_DATE}T09:00:00Z`), value: 900,
      })
      return db.select().from(samples).where(eq(samples.personId, 'p2')).all()
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
  }
  openRebuildable = handle
  return handle
}
