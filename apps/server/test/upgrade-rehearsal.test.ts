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
  ASLEEP_STAGES, DATABASE_FILENAME, DeriveQueue, EventStore, NoteStore, OverrideStore,
  PeopleStore, RawArchive, SourceRegistry, closeDatabase, listBackups, openDatabase, openHaelan,
  readSamples, runBackup, runRebuild, seedArchive, seedPerson, vacuumIfBloated,
} from '@haelan/core'
import type { Database, SampleText } from '@haelan/core'
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

// A name the household member typed on the heart-rate source before the upgrade. Tier-1 by any
// definition - nobody can regenerate a name somebody typed - even though no table in TIER_1
// holds it: aliases and rankings live beside sources, not inside the list above, and
// runRebuild's own dropUnreferencedSources deletes both for a source it decides went stale.
// Named on SEED_HEART_RATE_SOURCE's source specifically because that source stays referenced by
// real samples after step 3, so a rebuild that dropped it anyway - the false positive this
// guards against - is the thing this constant exists to catch.
const SOURCE_ALIAS = 'The good watch'

// A row in each of `daily`, `sessions` and `observations` from before the upgrade, so "the
// rebuild replaced what was there" in step 3 is tested against something rather than an empty
// table. The local date is outside any year the seed or the fixture ever writes, so its
// continued presence after step 3 could not be mistaken for a row the rebuild produced.
const STALE_LOCAL_DATE = '1999-12-31'
const STALE_SESSION_ID = 'stale-pre-upgrade-session'
const STALE_OBSERVATION_ID = 'stale-pre-upgrade-observation'

type Rows = Record<string, unknown[]>

const rowsOf = (db: Database, tables: readonly string[]): Rows => Object.fromEntries(
  tables.map((t) => [t, db.$client.prepare(`select * from ${t} order by id`).all()]),
)

const countOf = (db: Database, table: string): number =>
  (db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

const countWhere = (db: Database, table: string, where: string, ...params: unknown[]): number =>
  (db.$client.prepare(`select count(*) as n from ${table} where ${where}`).get(...params) as { n: number }).n

// Sorted, so an assertion is about which values are present and never about however sqlite
// happened to return them.
const namesOf = (db: Database, query: string): string[] =>
  (db.$client.prepare(query).all() as { name: string }[]).map((r) => r.name).sort()

// A grouped count, for the samples-per-metric and daily-rows-per-metric breakdowns below: a
// total moving is a question, and a total that moved because one metric grew while another
// shrank by the same amount would leave the question unanswerable from the total alone.
const countsByKey = (db: Database, query: string): Record<string, number> => Object.fromEntries(
  (db.$client.prepare(query).all() as { key: string, n: number }[]).map((r) => [r.key, r.n]),
)

// One sample's value, read back through the same text-keyed shape the mapper produced it in
// (readSamples, via SampleKeys) rather than a raw join against the ref columns this file would
// otherwise have to reimplement by hand.
const sampleValue = (rows: readonly SampleText[], input: {
  sourceId: string, metric: string, utcMs: number, agg: SampleText['agg'],
}): number | null => {
  const row = rows.find((r) => r.sourceId === input.sourceId && r.metric === input.metric
    && r.utcMs === input.utcMs && r.agg === input.agg)
  if (!row) throw new Error(`no ${input.metric}/${input.agg} sample at ${input.utcMs}`)
  return row.value
}

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

      // One row in each of daily, sessions and observations from before the upgrade - written
      // straight into the old, text-keyed schema the same way oldSamples above is, since these
      // three tables are untouched between LAST_OLD_TAG and head. "The rebuild replaced what was
      // there" in step 3 means nothing against a table that started empty; this gives it
      // something to replace. STALE_LOCAL_DATE is outside any year this file writes, so the row
      // surviving the rebuild could not be mistaken for one the seed produced.
      old.$client.prepare(
        'insert into daily (person_id, local_date, metric, agg, source, value, coverage,'
        + ' source_mix, derivation_version, updated_at_ms) values (?, ?, ?, ?, ?, ?, ?, null, 0, ?)',
      ).run(PERSON, STALE_LOCAL_DATE, 'weight', 'raw', sourceId, 999_999, 1, NOW)
      old.$client.prepare(
        'insert into sessions (id, person_id, source_id, kind, external_id, start_ms,'
        + ' start_offset_minutes, end_ms, end_offset_minutes, local_date, attrs, raw_payload_id)'
        + ' values (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, null)',
      ).run(STALE_SESSION_ID, PERSON, sourceId, 'sleep', STALE_SESSION_ID, 3_600_000, STALE_LOCAL_DATE, '{}')
      old.$client.prepare(
        'insert into observations (id, person_id, source_id, kind, started_at_ms,'
        + ' started_at_offset_minutes, ended_at_ms, ended_at_offset_minutes, local_date, value,'
        + ' raw_payload_id) values (?, ?, ?, ?, 0, 0, null, null, ?, ?, null)',
      ).run(STALE_OBSERVATION_ID, PERSON, sourceId, 'mood', STALE_LOCAL_DATE, 'STALE')

      // The three rows a rebuild cannot put back. Written through their own stores, because a
      // real instance has no other door onto them, and an override in particular is validated and
      // queued on the way in.
      const targetKey = sampleTarget({
        source: sourceId, metric: 'heart_rate', utcMs: OVERRIDDEN_AT_MS,
      })
      const deriveQueue = new DeriveQueue(old)
      const overrideId = new OverrideStore(old, deriveQueue).put({
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

      // A name and a ranking the household typed onto the heart-rate source before the upgrade.
      // Neither lives in a TIER_1 table, and both are exactly as unrecoverable as the rows that
      // do: nobody can regenerate a name somebody typed, and runRebuild's own
      // dropUnreferencedSources deletes both for a source it decides went stale. This source
      // stays referenced by real samples after step 3, so it must not be one of them.
      //
      // Written straight into the old schema's tables rather than through SourcePriorityStore or
      // SourceAliasStore: both stores are built against the current, integer-keyed `samples`
      // table (SourcePriorityStore.put reads it to mark days dirty), which does not exist yet on
      // this side of the migration. `source_priority` and `source_aliases` themselves are
      // untouched between LAST_OLD_TAG and head, the same as daily, sessions and observations
      // above, so a raw insert is what oldSamples already does for exactly this reason.
      old.$client.prepare(
        'insert into source_priority (person_id, metric, source_id, rank) values (?, ?, ?, 0)',
      ).run(PERSON, 'heart_rate', sourceId)
      old.$client.prepare(
        'insert into source_aliases (person_id, source_id, alias, updated_at_ms) values (?, ?, ?, ?)',
      ).run(PERSON, sourceId, SOURCE_ALIAS, NOW)

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
      // a measurement of the composition - but that composition is the seed's as much as the
      // mapper's, and both moved these figures on this branch already. A number below failing is
      // therefore a question, not an instruction: check what changed in seed.ts before assuming
      // the regression is in the derivation.
      //
      // 2492 samples and 904 daily rows, not the prior round's 1736 and 648: seed.ts now writes
      // six more data types closing the Activity page's own gap (distance, active-energy-burned,
      // active-minutes, active-zone-minutes as samples; floors and total-calories as dailyRollUp,
      // which lands only in `daily`, never `samples` - see this file's per-metric breakdowns
      // below for exactly what each type added).
      expect({
        samples: countOf(db, 'samples'),
        daily: countOf(db, 'daily'),
        sessions: countOf(db, 'sessions'),
        observations: countOf(db, 'observations'),
      }).toEqual({ samples: 2492, daily: 904, sessions: 19, observations: 14 })
      // The report an operator reads has to say what the tables say.
      expect({
        samples: rebuilt.samples, dailyRows: rebuilt.dailyRows,
        sessions: rebuilt.sessions, observations: rebuilt.observations,
      }).toEqual({ samples: 2492, dailyRows: 904, sessions: 19, observations: 14 })

      // Broken down per metric, so a regression that lost 300 steps samples while a mapper
      // started emitting 300 spurious weight rows - invisible to the bare total above, which
      // would still read 2492 - names what moved. Six of the ten are one raw sample a day, exact
      // against SEED_DAYS; heart_rate is downsampled to the minute, so its one reading an hour
      // becomes four rows (mean, min, max, count); steps, distance and active_energy have no
      // downsampling and report every one of their twenty-four hourly points; distance tracks the
      // step curve (seed.ts's own stepsByHour) rather than being drawn on its own, which is why it
      // matches steps' count exactly. floors and total_calories are not here at all - dailyRollUp
      // lands only in `daily`, as a `provider` row, never in `samples` (see mapRollups.ts's own
      // comment on why).
      expect(countsByKey(db, 'select m.name as key, count(*) as n from samples s'
        + ' join metrics m on m.ref = s.metric_ref group by m.name')).toEqual({
        steps: 24 * SEED_DAYS,
        heart_rate: 4 * 24 * SEED_DAYS,
        weight: SEED_DAYS,
        daily_hrv: SEED_DAYS,
        respiratory_rate: SEED_DAYS,
        resting_heart_rate: SEED_DAYS,
        distance: 24 * SEED_DAYS,
        active_energy: 24 * SEED_DAYS,
        active_minutes_light: SEED_DAYS,
        active_minutes_moderate: SEED_DAYS,
        active_minutes_vigorous: SEED_DAYS,
        active_zone_minutes_fat_burn: SEED_DAYS,
        active_zone_minutes_cardio: SEED_DAYS,
        active_zone_minutes_peak: SEED_DAYS,
      })
      // Sleep is one session a night, exact against SEED_DAYS. Exercise is not: seed.ts schedules
      // a workout every third day (`i % 3 === 1`) rather than every day, which over fourteen days
      // lands on five of them (days 1, 4, 7, 10 and 13) - a fixed count for this span rather than
      // a fraction of SEED_DAYS, because the schedule is a modulus and not a rate.
      expect(countsByKey(db, 'select kind as key, count(*) as n from sessions group by kind'))
        .toEqual({ sleep: SEED_DAYS, exercise: 5 })
      // Moods is the one categorical type this seed writes: one point a day, one kind.
      expect(countsByKey(db, 'select kind as key, count(*) as n from observations group by kind'))
        .toEqual({ mood: SEED_DAYS })
      // `daily` carries more metrics than `samples` does: deriveSleepDay expands one sleep
      // session into a dozen figures (time asleep, time in each stage, efficiency, nap count...),
      // and deriveDay writes a per-source row and, on top of it, a merged row for every metric -
      // one row each for most, and more where a metric also carries more than one aggregate
      // (heart_rate: five aggregates; weight: two). There is no comparably exact formula for the
      // total the way there is for samples above, which is why this is measured rather than
      // derived; writing it out per metric rather than trusting the bare total guards against the
      // same regression the samples breakdown above does.
      expect(countsByKey(db, 'select metric as key, count(*) as n from daily group by metric'))
        .toEqual({
          daily_hrv: 2 * SEED_DAYS,
          // +10 over the flat 10-per-day rate: Amsterdam's real offset ('3600s' across this
          // whole span - see amsterdamOffset in seed.ts, and the span never crosses a DST
          // boundary) shifts each day's last UTC hour one hour later in local time, so the
          // seeded span's final local day picks up a 24th hour that belongs to the calendar
          // date just past SEED_END. That extra local date gets one full day's worth of
          // heart_rate daily rows the same as any other; the UTC-only '0s' payloads this file
          // used to write could never produce it, because under a zero offset a local day and a
          // UTC day are always the same day.
          heart_rate: 10 * SEED_DAYS + 10,
          respiratory_rate: 2 * SEED_DAYS,
          resting_heart_rate: 2 * SEED_DAYS,
          sleep_asleep_minutes: 2 * SEED_DAYS,
          sleep_awake_minutes: 2 * SEED_DAYS,
          sleep_bedtime_minutes: 2 * SEED_DAYS,
          sleep_deep_minutes: 2 * SEED_DAYS,
          sleep_efficiency: 2 * SEED_DAYS,
          sleep_in_bed_minutes: 2 * SEED_DAYS,
          sleep_light_minutes: 2 * SEED_DAYS,
          sleep_nap_count: 2 * SEED_DAYS,
          sleep_nap_minutes: 2 * SEED_DAYS,
          sleep_rem_minutes: 2 * SEED_DAYS,
          sleep_waketime_minutes: 2 * SEED_DAYS,
          // Same spillover as heart_rate above, one metric's worth: +2 for the same extra local
          // date. distance and active_energy carry the identical +2, for the identical reason:
          // both are written on the same hourly, Amsterdam-offset walk steps is.
          steps: 2 * SEED_DAYS + 2,
          distance: 2 * SEED_DAYS + 2,
          active_energy: 2 * SEED_DAYS + 2,
          // active-minutes and active-zone-minutes carry no spillover: seed.ts writes each as one
          // point spanning the whole civil day rather than an hourly walk, so there is no last UTC
          // hour to land past local midnight the way steps' twenty-fourth hourly point does.
          active_minutes_light: 2 * SEED_DAYS,
          active_minutes_moderate: 2 * SEED_DAYS,
          active_minutes_vigorous: 2 * SEED_DAYS,
          active_zone_minutes_fat_burn: 2 * SEED_DAYS,
          active_zone_minutes_cardio: 2 * SEED_DAYS,
          active_zone_minutes_peak: 2 * SEED_DAYS,
          // floors and total_calories are dailyRollUp types: one `provider` row a day and no
          // `merged` row on top, since there is no per-source data under either for a merge to
          // choose between (mapRollups.ts's own comment, and Activity.tsx's REQUESTS comment).
          floors: SEED_DAYS,
          total_calories: SEED_DAYS,
          weight: 4 * SEED_DAYS,
          workout_count: 10,
          workout_minutes: 10,
        })

      // The single worst thing a rebuild can do: produce exactly the right number of rows with
      // the wrong numbers in them. Every assertion above this line would stay green if
      // mapSamples doubled every value on the way in - a real mutation this file has been run
      // against, see the fix report - so these three pin actual magnitudes, chosen so a change in
      // a mapper, a unit or an aggregate moves at least one of them.
      const sourceSamples = readSamples(db, PERSON)
      // A day's weight: one raw sample, the last day the seed writes. The magnitude moved from a
      // prior round's 63258 to 63321 not because the weight formula changed - it did not - but
      // because the shared PRNG stream did: seed.ts now draws distance and active energy inside
      // every day's loop body ahead of weightGrams's own draw, and draws active minutes,
      // active-zone minutes, total calories and floors after it, so every iteration after the
      // first pulls weightGrams's trend from a different point in the mulberry32 sequence than
      // before. The magnitude is read back from a real rebuild, not computed by hand.
      const lastDayStart = SEED_END - 1 * 86_400_000
      expect(sampleValue(sourceSamples, {
        sourceId, metric: 'weight', utcMs: lastDayStart + 7 * 3_600_000, agg: 'raw',
      })).toBe(63_321)
      // A known heart-rate hour's mean and its sample count: the same instant OVERRIDDEN_AT_MS
      // names, which is a real seeded reading (noon, seven days before the end) rather than a
      // second instant invented for this assertion alone. One reading a minute means mean, min
      // and max all equal the reading and count is 1; asserting mean and count is enough to catch
      // a downsample that started averaging across more than the one point it should have.
      //
      // 82, not the prior round's 164: day i=7 (seven days before SEED_END) is still a scheduled
      // workout day (i % 3 === 1 in seed.ts), but the six new data types draw ahead of `pick(rand,
      // [7, 12, 18])` in every day's loop body, so this run's workout for that day picks a
      // different hour of the three - not noon, the hour OVERRIDDEN_AT_MS names. Noon here reads
      // the ambient midday curve instead of the elevated exercise band: `60 + stepCurve(12) *
      // range(rand, 15, 25)`, whose ceiling is a little under 84, and 82 sits inside it.
      expect(sampleValue(sourceSamples, {
        sourceId, metric: 'heart_rate', utcMs: OVERRIDDEN_AT_MS, agg: 'mean',
      })).toBe(82)
      expect(sampleValue(sourceSamples, {
        sourceId, metric: 'heart_rate', utcMs: OVERRIDDEN_AT_MS, agg: 'count',
      })).toBe(1)
      // One sleep night's asleep minutes, summed from its segments the same way deriveSleepDay
      // does (ASLEEP_STAGES), for the same last night the weight reading above belongs to. This
      // last night (2026-02-27 to -28) is not one of Finding 5's occasional short ones - its own
      // interval runs a normal 420 minutes - so 401, not the prior round's 417, is the same PRNG
      // cascade the weight figure above describes: the stage-share jitter stagesFor draws for
      // every night sits downstream of the extra rand() calls this round added (the restless
      // flag once a night, the workout step-spike once a workout day), so every night's shares
      // land on different mulberry32 output even where the night itself is unremarkable.
      const lastNightId = (db.$client.prepare(
        "select id from sessions where person_id = ? and kind = 'sleep' order by end_ms desc limit 1",
      ).get(PERSON) as { id: string }).id
      const asleepMs = (db.$client.prepare(
        `select coalesce(sum(end_ms - start_ms), 0) as ms from session_segments`
        + ` where session_id = ? and stage in (${ASLEEP_STAGES.map(() => '?').join(',')})`,
      ).get(lastNightId, ...ASLEEP_STAGES) as { ms: number }).ms
      expect(Math.round(asleepMs / 60_000)).toBe(401)

      // The stale rows written into the old database before the upgrade: gone, not merely
      // outnumbered. A rebuild that stopped clearing a person's tier 2 before replaying it would
      // leave these sitting beside the real ones, and every assertion above this block would
      // still pass - counts, names and now magnitudes all come from the *new* rows, and none of
      // them looks at whether an old one is still there.
      expect(countWhere(db, 'daily', 'local_date = ?', STALE_LOCAL_DATE)).toBe(0)
      expect(countWhere(db, 'sessions', 'id = ?', STALE_SESSION_ID)).toBe(0)
      expect(countWhere(db, 'observations', 'id = ?', STALE_OBSERVATION_ID)).toBe(0)

      // The name and the ranking the household typed before the upgrade, on a source the rebuild
      // has every reason to keep: real samples reference it after step 3, so dropUnreferencedSources
      // must not have called it stale. Both counts on the report say so independently of the rows
      // themselves - a rebuild could in principle restore the rows here and still have reported a
      // false removal, which is what an operator's log actually shows them.
      expect(rebuilt.rankingsRemoved).toBe(0)
      expect(rebuilt.aliasesRemoved).toBe(0)
      expect(instance.sourcePriority.lists(PERSON))
        .toContainEqual({ metric: 'heart_rate', sourceIds: [sourceId] })
      expect(instance.sourceAliases.listNamed(PERSON).find((s) => s.id === sourceId)?.alias)
        .toBe(SOURCE_ALIAS)

      // Counts alone would let a rebuild that dropped one data type and over-produced another
      // pass, so name what came back. Every seeded type is here: steps, heart rate, weight, the
      // three daily recovery metrics (resting heart rate, HRV, respiratory rate), distance and
      // active energy burned, and the six active-minutes/active-zone-minutes sub-dimension
      // metrics - as samples; sleep and exercise as sessions; moods as observations. floors and
      // total_calories are not here: they are dailyRollUp types and land only in `daily`.
      expect(namesOf(db, 'select distinct m.name as name from samples s'
        + ' join metrics m on m.ref = s.metric_ref')).toEqual([
        'active_energy', 'active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous',
        'active_zone_minutes_cardio', 'active_zone_minutes_fat_burn', 'active_zone_minutes_peak',
        'daily_hrv', 'distance', 'heart_rate', 'respiratory_rate', 'resting_heart_rate', 'steps', 'weight',
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
      expect(countOf(restored.db, 'samples')).toBe(2492)
      // 175, not the prior round's 117: 8 list calls a day plus one exercise call every third day
      // was 117 over SEED_DAYS=14 (14*8+5). Four more list calls a day - distance,
      // active-energy-burned, active-minutes, active-zone-minutes - add 4*14=56, and floors and
      // total-calories each add exactly one dailyRollUp call: putRollups chunks by
      // rollupRangeCapDays, and fourteen days is inside floors' 90-day cap and exactly at
      // total-calories' 14-day cap (both close on one chunk), so +2, not +14 apiece.
      expect(countOf(restored.db, 'raw_payloads')).toBe(175)
      closeRestored()
    } finally {
      for (const close of [...openHandles]) close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
