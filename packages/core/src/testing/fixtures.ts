import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../db/open.ts'
import { migrateToLatest } from '../db/migrate.ts'
import { people, sources, samples, sessions, overrides } from '../db/schema/index.ts'
import type { SessionKind, SampleAgg } from '../db/schema/index.ts'
import type { Database } from '../db/open.ts'
import type { OverrideScope } from '../derive/targetKey.ts'

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
