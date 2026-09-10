// The upgrade path, walked end to end: an old database migrated to head, rebuilt from its own
// archive, offered to the reclaim, backed up, and restored over itself.
//
// Every one of those five things has a unit test of its own. None of them has ever been run in
// sequence by anything but a person, by hand, against a copy of a real instance - which is how
// this milestone found three defects that exist only on the upgrade path, one of them capable of
// bricking an instance. This file is that person.
//
// The asymmetry below is the design rather than an accident. The **old** database is built here,
// by replaying the repository's own migrations 0000 to 0015 and recording them the way drizzle's
// migrator records them. The **upgrade** is `openHaelan`, the function a user's boot calls, and
// `migrateToLatest` underneath it, which hardcodes its migrations folder on purpose: a boot that
// can be pointed at a different migration set is a boot that can be pointed at the wrong one. So
// only the fixture building is bespoke, and the thing under test is the real thing.
//
// No timing assertion appears anywhere in this file. What survives each step is the question;
// how long a step took is not, and three flaky-test incidents on this project came from
// answering the second one on a shared runner.

import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DATABASE_FILENAME, DeriveQueue, EventStore, NoteStore, OverrideStore, PeopleStore, RawArchive,
  SourceRegistry, closeDatabase, listBackups, openDatabase, openHaelan, runBackup, runRebuild,
  seedArchive, seedPerson, vacuumIfBloated,
} from '@haelan/core'
import type { Database } from '@haelan/core'
import { sampleTarget } from '@haelan/core/target-key'

const PERSON = 'p1'
const SEED_DAYS = 14
const SEED_END = Date.parse('2026-03-01T00:00:00Z')
const NOW = Date.parse('2026-03-01T09:00:00Z')

// The last migration the old database gets. 0016 is the one an upgrading user has not run yet:
// it drops `samples` outright and recreates it keyed on integers, which is the whole reason the
// rebuild in step 3 has anything to do.
const LAST_OLD_TAG = '0015_common_black_widow'
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/core/drizzle/', import.meta.url))

// What the seed's heart-rate payloads claim recorded them: `samplePoint`'s own default. The
// override written below names the source id derived from this, so if the seed ever starts
// passing a descriptor of its own the override stops resolving and step 3 says so.
const SEED_HEART_RATE_SOURCE = { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' }

// The reading the person threw out: seven days before the end of the seeded span, at noon. The
// seed writes one heart-rate point an hour carrying a '0s' offset, so this instant is a real
// reading and the local day it belongs to is the UTC one.
const OVERRIDDEN_AT_MS = SEED_END - 7 * 86_400_000 + 12 * 3_600_000
const OVERRIDDEN_LOCAL_DATE = '2026-02-22'

// Everything a rebuild cannot regenerate. `people` and `sources` are the rows the rest hang off,
// `raw_payloads` is the archive the rebuild reads back, and `overrides`, `notes` and `events` are
// the household's own writing - the only rows in this database whose loss is permanent.
const TIER_1 = ['people', 'sources', 'raw_payloads', 'overrides', 'notes', 'events'] as const

// What a rebuild is allowed to touch of tier 1, and therefore what step 3 leaves out of its
// comparison: the version stamp on `people` is the rebuild's own record that it ran, and the
// replay legitimately adds the `sources` row the moods payloads describe. Everything else on the
// list above has to come through both the migration and the rebuild untouched.
const UNTOUCHED_BY_A_REBUILD = ['raw_payloads', 'overrides', 'notes', 'events'] as const

type Rows = Record<string, unknown[]>

const rowsOf = (db: Database, tables: readonly string[]): Rows => Object.fromEntries(
  tables.map((t) => [t, db.$client.prepare(`select * from ${t} order by id`).all()]),
)

const countOf = (db: Database, table: string): number =>
  (db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

// Sorted, so an assertion is about which values are present and never about however sqlite
// happened to return them.
const namesOf = (db: Database, query: string): string[] =>
  (db.$client.prepare(query).all() as { name: string }[]).map((r) => r.name).sort()

/**
 * A database at migration `throughTag`, built by replaying the repository's own migration files.
 *
 * Drizzle's own `migrate()`, pointed at a temp folder holding a trimmed journal, would be the
 * obvious way to do this - but `drizzle-orm` is `@haelan/core`'s dependency and this package does
 * not declare it, the same constraint `v1-etag.test.ts` already works around. Declaring it here
 * for one fixture would put a package into `@haelan/server` that nothing it ships uses, and drag
 * an unrelated dependency-resolution change through the lockfile with it.
 *
 * What is reproduced instead is small, and it is checked immediately. Drizzle decides what to
 * apply purely by comparing each journal entry's `when` against the newest `created_at` in
 * `__drizzle_migrations` - the hash it records is written and never read back - so one row per
 * applied migration carrying its journal timestamp is the whole of the bookkeeping. And a fixture
 * that got that wrong cannot pass quietly: `migrateToLatest` runs against this same file moments
 * later and would either replay 0000 and throw on a table that already exists, or skip 0016 and
 * leave the rebuild reading a `samples` table with no `person_ref` column. Step 2 pins the
 * migration count for the same reason.
 */
function buildOldDatabase(dir: string, throughTag: string): Database {
  const db = openDatabase(dir)
  try {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string, when: number }[] }
    const cut = journal.entries.findIndex((e) => e.tag === throughTag)
    if (cut < 0) throw new Error(`the migration history has no ${throughTag}`)

    const client = db.$client
    client.exec(
      'CREATE TABLE IF NOT EXISTS __drizzle_migrations '
      + '(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    )
    const record = client.prepare(
      'INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)',
    )
    // One transaction around the whole history, which is what drizzle's migrator does, and which
    // matters for more than tidiness: 0003 asks for `PRAGMA foreign_keys=OFF`, sqlite ignores that
    // inside a transaction, and applying these statements loose would therefore exercise a foreign
    // key regime no boot has ever run them under.
    client.transaction(() => {
      for (const entry of journal.entries.slice(0, cut + 1)) {
        const sql = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8')
        // The same separator drizzle's own `readMigrationFiles` splits on. Blank pieces are
        // dropped only because sqlite refuses a statement with nothing in it; no file in the
        // history has one today, and skipping them changes no SQL that runs.
        for (const statement of sql.split('--> statement-breakpoint')) {
          if (statement.trim().length > 0) client.exec(statement)
        }
        record.run(createHash('sha256').update(sql).digest('hex'), entry.when)
      }
    })()
    return db
  } catch (err) {
    // openDatabase already holds the file handle and the WAL lock, which is the hazard openHaelan
    // guards against for the same reason: a fixture that threw halfway must not leave a handle
    // behind that blocks the next open.
    closeDatabase(db)
    throw err
  }
}

/**
 * Puts a backup file back over the live database, which is what the restore procedure is: there
 * is no `runRestore`, because a restore is an operator copying one file while nothing is running.
 *
 * The write-ahead log and its shared-memory file describe the database being replaced, not the
 * one being copied in. Left in place, sqlite replays them onto the restored file at the next open
 * and the restore quietly undoes itself - which is exactly the "a restore that appears to work
 * and does not" this test exists to catch, so it must not be able to happen here by accident
 * either.
 */
function restoreOver(dir: string, backupPath: string): void {
  const live = join(dir, DATABASE_FILENAME)
  rmSync(`${live}-wal`, { force: true })
  rmSync(`${live}-shm`, { force: true })
  copyFileSync(backupPath, live)
}

describe('the upgrade path', () => {
  it('carries tier 1 from an old schema through rebuild, reclaim, backup and restore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-rehearsal-'))
    // Every sqlite handle this walk opens, so the cleanup at the end can close whichever one was
    // still live when an assertion failed. Without it a failure halfway leaves the file open, the
    // temp directory refuses to go on Windows, and the EPERM from removing it replaces the
    // assertion error that actually mattered - which is how the first draft of this test reported
    // a permissions problem instead of the row it had got wrong.
    const openHandles = new Set<() => void>()
    const track = (close: () => void): (() => void) => {
      const once = (): void => { openHandles.delete(once); close() }
      openHandles.add(once)
      return once
    }
    try {
      // ---- 1. An instance as it stood before the upgrade -----------------------------------
      const old = buildOldDatabase(dir, LAST_OLD_TAG)
      const closeOld = track(() => closeDatabase(old))
      seedPerson(old, PERSON)

      // Resolved through the real registry rather than spelled out here, because a source id is
      // derived from the person and the payload's descriptor precisely so that a rebuild
      // reconstructs it. That property is what lets an override written today still name a row
      // regenerated tomorrow, and it is what step 3 checks.
      const sourceId = new SourceRegistry(old).resolve(PERSON, SEED_HEART_RATE_SOURCE, NOW)

      seedArchive({
        archive: new RawArchive(old), personId: PERSON, days: SEED_DAYS, endMs: SEED_END,
      })

      // Rows in the old, text-keyed `samples`, so that "samples is empty afterwards" in step 2 is
      // a statement about the migration rather than about a table that was empty either way.
      const oldSamples = old.$client.prepare(
        'insert into samples (person_id, source_id, metric, utc_ms, tz_offset_minutes, agg, value,'
        + ' n, raw_payload_id) values (?, ?, ?, ?, 0, ?, ?, 1, null)',
      )
      for (const minute of [9, 10, 11]) {
        oldSamples.run(PERSON, sourceId, 'heart_rate', OVERRIDDEN_AT_MS + minute * 60_000, 'avg', 61)
      }
      expect(countOf(old, 'samples')).toBe(3)

      // The three rows a rebuild cannot put back. Written through their own stores, because a
      // real instance has no other door onto them, and an override in particular is validated and
      // queued on the way in.
      const targetKey = sampleTarget({
        source: sourceId, metric: 'heart_rate', utcMs: OVERRIDDEN_AT_MS,
      })
      const overrideId = new OverrideStore(old, new DeriveQueue(old)).put({
        personId: PERSON, scope: 'sample', targetKey, action: 'exclude',
        reason: 'the strap was loose', nowMs: NOW,
      })
      new NoteStore(old).put({
        personId: PERSON, localDate: OVERRIDDEN_LOCAL_DATE, body: 'slept badly', nowMs: NOW,
      })
      new EventStore(old).add({
        personId: PERSON, kind: 'illness', startedAtMs: OVERRIDDEN_AT_MS,
        startedAtOffsetMinutes: 0, note: 'a cold',
      })

      const tier1Before = rowsOf(old, TIER_1)
      closeOld()

      // ---- 2. The boot a user actually gets ------------------------------------------------
      const instance = openHaelan(dir, {})
      const closeInstance = track(() => { instance.close() })
      const db = instance.db

      // Row for row, not table by table: a migration that rewrote a note's body or dropped an
      // event's offset would leave every count intact.
      expect(rowsOf(db, TIER_1)).toEqual(tier1Before)
      // The deliberate part. 0016 drops `samples` rather than translating 1.6 million rows inside
      // a migration transaction, and the rebuild below is what refills it.
      expect(countOf(db, 'samples')).toBe(0)
      // 0016 ran, and the fixture stopped where it claimed to. See buildOldDatabase.
      expect(countOf(db, '__drizzle_migrations')).toBe(17)
      // With no samples there is nothing yet for the override to point at, which is what makes
      // the same call in step 3 mean anything.
      expect(instance.overrides.affectedLocalDate({
        personId: PERSON, scope: 'sample', targetKey,
      })).toBeNull()

      // ---- 3. The rebuild the version stamps ask for ---------------------------------------
      // Not forced. The person carries no built-version stamp, which is what an upgrading
      // instance looks like, so the boot's own "who needs this" answer is what selects them.
      const report = runRebuild({
        db,
        archive: instance.archive,
        peopleStore: new PeopleStore(db),
        priority: instance.sourcePriority,
        overrides: instance.overrides,
        settings: instance.settings,
        nowMs: NOW,
      })
      expect(report.failures).toEqual([])
      expect(report.people).toHaveLength(1)
      const rebuilt = report.people[0]!
      expect(rebuilt.reasons.length).toBeGreaterThan(0)
      expect(rebuilt.overridesOrphaned).toEqual([])
      expect(rebuilt.unmappablePayloads).toBe(0)

      // What fourteen seeded days derive into. Fixed figures rather than a comparison against the
      // old database, because the old database could not hold them: `samples` there is the
      // text-keyed table 0016 replaces, and nothing in this repository can derive `daily`,
      // `sessions` or `observations` against that shape. The seed is deterministic, so these are
      // a measurement of the composition, and they move only when a mapping or the derivation
      // does.
      expect({
        samples: countOf(db, 'samples'),
        daily: countOf(db, 'daily'),
        sessions: countOf(db, 'sessions'),
        observations: countOf(db, 'observations'),
      }).toEqual({ samples: 1736, daily: 636, sessions: 19, observations: 14 })
      // The report an operator reads has to say what the tables say.
      expect({
        samples: rebuilt.samples, dailyRows: rebuilt.dailyRows,
        sessions: rebuilt.sessions, observations: rebuilt.observations,
      }).toEqual({ samples: 1736, dailyRows: 636, sessions: 19, observations: 14 })

      // Counts alone would let a rebuild that dropped one data type and over-produced another
      // pass, so name what came back. Every seeded type is here: steps, heart rate, weight and
      // the three daily recovery metrics (resting heart rate, HRV, respiratory rate) as samples,
      // sleep and exercise as sessions, moods as observations.
      expect(namesOf(db, 'select distinct m.name as name from samples s'
        + ' join metrics m on m.ref = s.metric_ref')).toEqual([
        'daily_hrv', 'heart_rate', 'respiratory_rate', 'resting_heart_rate', 'steps', 'weight',
      ])
      expect(namesOf(db, 'select distinct kind as name from sessions'))
        .toEqual(['exercise', 'sleep'])
      expect(namesOf(db, 'select distinct kind as name from observations')).toEqual(['mood'])

      // The one piece of tier-1 data that points into tier 2, and it points by text: a source id,
      // a metric name and an instant, translated into this database's integer refs only at the
      // moment it is read. A rebuild that regenerated the samples under different identities
      // would leave the household's correction pointing at nothing at all.
      expect(instance.overrides.affectedLocalDate({
        personId: PERSON, scope: 'sample', targetKey,
      })).toBe(OVERRIDDEN_LOCAL_DATE)
      expect(instance.overrides.get(PERSON, overrideId)?.targetKey).toBe(targetKey)
      // And the household's own writing stands exactly as it did before the upgrade, now on the
      // far side of a rebuild as well as a migration.
      expect(rowsOf(db, UNTOUCHED_BY_A_REBUILD)).toEqual(
        Object.fromEntries(UNTOUCHED_BY_A_REBUILD.map((t) => [t, tier1Before[t]!])),
      )

      // ---- 4. The reclaim the boot offers --------------------------------------------------
      // It declines, and that is the assertion. `vacuumIfBloated` runs only above 20 percent free
      // pages AND above 64 MiB of them, and fourteen days of seeded data is on the order of a
      // megabyte all told - three orders of magnitude short. Bloating this database artificially
      // to force the vacuum would make the step a test of a scenario no instance built from this
      // seed ever reaches; `vacuum.test.ts` already covers the running case that way, on purpose
      // and in one place. What matters to the composition is that the boot asks, gets an answer
      // it understands, and carries on.
      const before = statSync(join(dir, DATABASE_FILENAME)).size
      expect(vacuumIfBloated(db, dir)).toMatchObject({ ran: false, reason: 'below_fraction' })
      // From statSync rather than from a pragma. A pragma reports the freelist the instant a
      // vacuum commits, while the file itself only shrinks at the checkpoint after it, and taking
      // the pragma's word for a reclaim was a blocking finding on this path once already.
      expect(statSync(join(dir, DATABASE_FILENAME)).size).toBe(before)

      // ---- 5. The backup, and the restore over the top of it -------------------------------
      // runBackup writes a `.part`, opens it, integrity-checks it, compares its row counts
      // against the live database and only then gives it the name of a backup - so a file
      // appearing here at all is the verification having passed.
      const backup = runBackup({ db, dir, nowMs: NOW })
      expect(listBackups(dir).map((f) => f.name)).toEqual([backup.name])

      // A marker written after the copy was taken. The restore has to lose it: a restore that
      // quietly did nothing would leave every earlier assertion true, and this is the only row
      // that can tell the difference.
      const MARKER_DATE = '2026-02-25'
      instance.notes.put({
        personId: PERSON, localDate: MARKER_DATE, body: 'written after the backup', nowMs: NOW,
      })
      expect(instance.notes.listFor(PERSON, MARKER_DATE, MARKER_DATE)).toHaveLength(1)
      closeInstance()

      restoreOver(dir, backup.path)

      // Through openHaelan again, so the restored file has to boot: migrations reconciled, key
      // read, every store constructed. "An instance that cannot boot after the migration" is on
      // the same list of failures this file exists to catch.
      const restored = openHaelan(dir, {})
      const closeRestored = track(() => { restored.close() })
      expect(restored.notes.listFor(PERSON, '2026-01-01', '2026-12-31').map((n) => n.localDate))
        .toEqual([OVERRIDDEN_LOCAL_DATE])
      // The rest of the instance came back with it, rather than the restore having produced some
      // empty database that also happens not to hold the marker.
      expect(restored.overrides.get(PERSON, overrideId)?.targetKey).toBe(targetKey)
      expect(restored.events.listFor(PERSON, '2026-01-01', '2026-12-31')).toHaveLength(1)
      expect(countOf(restored.db, 'samples')).toBe(1736)
      expect(countOf(restored.db, 'raw_payloads')).toBe(117)
      closeRestored()
    } finally {
      for (const close of [...openHandles]) close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
