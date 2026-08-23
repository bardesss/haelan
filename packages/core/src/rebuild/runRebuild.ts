import { and, eq, inArray } from 'drizzle-orm'
import type { Database, DbOrTx } from '../db/open.ts'
import { daily, samples, sessions, sources, sourcePriority } from '../db/schema/index.ts'
import { MAPPING_VERSION } from '../api/version.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'
import { deriveDayInto } from '../derive/deriveDay.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../derive/sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from '../derive/sessionOverlap.ts'
import { SourceRegistry } from '../store/sources.ts'
import type { RawArchive } from '../store/rawArchive.ts'
import type { PeopleStore } from '../store/people.ts'
import type { OverrideStore } from '../store/overrides.ts'
import type { SourcePriorityStore } from '../store/sourcePriority.ts'
import type { SettingsStore } from '../store/settings.ts'
import { peopleNeedingRebuild } from './versions.ts'
import { replayPerson } from './replay.ts'
import { retargetOverrides } from './retarget.ts'
import type { OldSession, OrphanedOverride } from './retarget.ts'

export interface RebuildPersonReport {
  personId: string
  /** Why this person was rebuilt. Empty when the caller forced it. */
  reasons: string[]
  samples: number
  sessions: number
  daysDerived: number
  dailyRows: number
  sourcesRemoved: number
  overridesRetargeted: number
  overridesOrphaned: OrphanedOverride[]
  unmappablePayloads: number
}

export interface RebuildReport {
  /** One entry per person actually rebuilt. Empty when nothing needed it. */
  people: RebuildPersonReport[]
}

export interface RebuildInput {
  db: Database
  archive: RawArchive
  peopleStore: PeopleStore
  priority: SourcePriorityStore
  overrides: OverrideStore
  settings: SettingsStore
  nowMs: number
  /** Restricts the run to these people. Absent means everyone who needs it. */
  personIds?: string[]
  /** Rebuilds people already stamped at the current versions. */
  force?: boolean
  /** Called after each person's transaction commits, so what it reports is durable. */
  onPersonDone?: (report: RebuildPersonReport) => void
}

/**
 * Regenerates tiers 2 and 3 from tier 1, one person at a time, each inside a single transaction.
 *
 * Per person rather than instance wide for two reasons. A household member reading their own
 * dashboard is unaffected while somebody else rebuilds, and an interrupted run resumes at the
 * next unstamped person rather than starting over, because the stamp commits with the rows it
 * describes.
 *
 * What this deliberately does not touch: sync high water marks, backfill cursors, notes, events,
 * and the overrides themselves beyond moving their keys. A rebuild is a re-derivation, not a
 * re-fetch. The entire value of tier 1 is that improving derivation costs a rebuild instead of
 * months of API calls, and a rebuild that reset a cursor would undo exactly that.
 */
export function runRebuild(input: RebuildInput): RebuildReport {
  const all = input.peopleStore.list()
  const candidates = input.personIds === undefined
    ? all
    : all.filter((row) => input.personIds!.includes(row.id))

  const needs = new Map(peopleNeedingRebuild(candidates).map((n) => [n.personId, n.reasons]))
  const todo = input.force === true
    ? candidates.map((row) => ({ personId: row.id, reasons: needs.get(row.id) ?? [] }))
    : candidates.filter((row) => needs.has(row.id))
      .map((row) => ({ personId: row.id, reasons: needs.get(row.id)! }))

  // Instance wide tuning, read once. The same values the queue drain uses, for the same reason:
  // a change to either marks nothing dirty, so both paths have to read the current setting.
  const tuning = input.settings.get()
  const gapMinutes = tuning?.nightGapMinutes ?? DEFAULT_NIGHT_GAP_MINUTES
  const overlapRatio = tuning?.sessionOverlapRatio ?? DEFAULT_OVERLAP_RATIO

  const report: RebuildReport = { people: [] }

  for (const { personId, reasons } of todo) {
    // Oldest window first, which is the order the syncs wrote in.
    const payloads = input.archive.listFor(personId)
    // A registry per person, never shared across the loop. Its cache maps an external id to a
    // row id, and a rebuild deletes rows, so a cache that outlived one person's transaction
    // would hand the next person an id that no longer exists.
    //
    // Measured honesty about that: as SourceRegistry stands today the collision is not reachable
    // from here, because its cache key names the person as well as the external id, and source
    // ids are a hash of exactly those two, so even a rolled back person's cached id is the id
    // their next rebuild recreates. Hoisting this line out of the loop passes every test in
    // rebuild.test.ts. It stays per person anyway: the two facts holding it up live in another
    // file, one of them is a caching detail nobody would think to preserve, and a fresh registry
    // per person costs one allocation against a whole transaction of work.
    const registry = new SourceRegistry(input.db)

    // input.peopleStore, input.priority and input.overrides were built on the outer db handle and
    // are used inside this transaction anyway. That is correct rather than an oversight:
    // better-sqlite3 runs on one connection, so every statement issued while the transaction
    // callback executes is part of the transaction, whichever handle issued it. Two properties
    // depend on it. The version stamp commits and rolls back with the rows it describes, and
    // overrides.listFor below sees the keys retargetOverrides just rewrote. Moving the stores
    // onto tx is not a fix; if this ever does change, both properties have to survive it.
    const personReport = input.db.transaction((tx) => {
      // Captured before the delete, because re-targeting a session override needs to know what
      // the id it names used to mean, and after the delete nothing does.
      const oldSessions = new Map<string, OldSession>(
        tx.select({ id: sessions.id, kind: sessions.kind, externalId: sessions.externalId })
          .from(sessions).where(eq(sessions.personId, personId)).all()
          .map((row) => [row.id, { kind: row.kind, externalId: row.externalId }]),
      )

      // Segments go with their sessions by cascade: session_segments.session_id declares
      // ON DELETE cascade and openDatabase sets PRAGMA foreign_keys = ON on every connection it
      // makes, which is the only way this package opens one. Deleting them explicitly first
      // would be a second statement doing what the first already does.
      tx.delete(sessions).where(eq(sessions.personId, personId)).run()
      tx.delete(samples).where(eq(samples.personId, personId)).run()
      // Provider rows included. They are mapped from archived rollup responses like everything
      // else, so the replay puts them back.
      tx.delete(daily).where(eq(daily.personId, personId)).run()

      const counts = replayPerson(tx, {
        personId, payloads, archive: input.archive, sources: registry, nowMs: input.nowMs,
      })

      const sourcesRemoved = dropUnreferencedSources(tx, personId)

      const retarget = retargetOverrides(tx, { personId, oldSessions })

      const priority = input.priority.load(personId)
      // Read after re-targeting, so a moved key is the one the derivation applies.
      const personOverrides = input.overrides.listFor(personId)
      let dailyRows = 0
      for (const localDate of counts.localDates) {
        dailyRows += deriveDayInto(tx, {
          personId, localDate, priority, overrides: personOverrides, gapMinutes, overlapRatio,
        })
      }

      input.peopleStore.stampBuiltVersions({
        id: personId, mappingVersion: MAPPING_VERSION, derivationVersion: DERIVATION_VERSION,
      })

      return {
        personId,
        reasons,
        samples: counts.samples,
        sessions: counts.sessions,
        daysDerived: counts.localDates.length,
        // Provider rows come from the replay, derived rows from the loop above. Both are tier 3.
        dailyRows: dailyRows + counts.providerDaily,
        sourcesRemoved,
        overridesRetargeted: retarget.retargeted,
        overridesOrphaned: retarget.orphaned,
        unmappablePayloads: counts.unmappable,
      }
    })

    report.people.push(personReport)
    input.onPersonDone?.(personReport)
  }

  return report
}

/**
 * Removes the source rows the replay did not recreate, and the rankings that pointed at them.
 *
 * Source ids are derived from the person and the external id, so a source the current
 * `describe()` still produces comes back under the same id and survives untouched. What is left
 * over is exactly the identities the old mapping produced and the current one does not, which is
 * what makes this the difference between re-deriving source identity and preserving it.
 *
 * The rankings go with them because `source_priority.source_id` is a foreign key, and a ranking
 * of a source that no longer exists is not a preference anybody can act on.
 */
function dropUnreferencedSources(tx: DbOrTx, personId: string): number {
  const referenced = new Set<string>([
    ...tx.selectDistinct({ id: samples.sourceId }).from(samples)
      .where(eq(samples.personId, personId)).all().map((row) => row.id),
    ...tx.selectDistinct({ id: sessions.sourceId }).from(sessions)
      .where(eq(sessions.personId, personId)).all().map((row) => row.id),
  ])

  const owned = tx.select({ id: sources.id }).from(sources)
    .where(eq(sources.personId, personId)).all().map((row) => row.id)
  const stale = owned.filter((id) => !referenced.has(id))
  if (stale.length === 0) return 0

  tx.delete(sourcePriority).where(and(
    eq(sourcePriority.personId, personId),
    inArray(sourcePriority.sourceId, stale),
  )).run()
  tx.delete(sources).where(inArray(sources.id, stale)).run()
  return stale.length
}
