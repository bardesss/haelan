import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database, DbOrTx } from '../db/open.ts'
import { daily, samples, sessions, sources, sourceAliases, sourcePriority } from '../db/schema/index.ts'
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
  /**
   * How many `source_priority` rows went with those sources. Beside `sourcesRemoved` rather than
   * inside it because the two mean different things to whoever reads them: a stale source is a
   * regenerable cache entry, and a ranking is the household member's own choice of which device
   * wins for which metric, which nothing here or anywhere else can put back.
   */
  rankingsRemoved: number
  /**
   * How many names went with those sources. Beside the other two rather than folded in, for the
   * reason `rankingsRemoved` is: a stale source is a regenerable cache entry, a ranking and a name
   * are both the household member's own input and neither can be put back. A name is the cheaper
   * of the two to retype, which is why it gets a count rather than a line each.
   */
  aliasesRemoved: number
  overridesRetargeted: number
  overridesOrphaned: OrphanedOverride[]
  unmappablePayloads: number
}

/**
 * A person whose rebuild threw, and who is therefore still on their old derived rows.
 *
 * The error is carried whole rather than as a message. Whoever reports this decides how much of
 * it to print, and a stack is the only thing that turns "a payload no mapper handles" from a
 * sentence into something somebody can fix.
 */
export interface RebuildFailure {
  personId: string
  /** The same reasons the attempt was made for, so a log line can say what was being tried. */
  reasons: string[]
  error: Error
}

export interface RebuildReport {
  /** One entry per person actually rebuilt. Empty when nothing needed it. */
  people: RebuildPersonReport[]
  /**
   * One entry per person whose rebuild threw. Their transaction rolled back and their version
   * stamp went with it, so they keep the rows they had and the next boot retries them.
   */
  failures: RebuildFailure[]
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

  const report: RebuildReport = { people: [], failures: [] }

  for (const { personId, reasons } of todo) {
    // A registry per person, never shared across the loop. Its cache maps an external id to a
    // row id, and a rebuild deletes rows, so a cache that outlived one person's transaction
    // would hand the next person an id that no longer exists.
    //
    // That used to be a precaution against a control flow nobody had written yet. It is now the
    // control flow: the catch below means work does run after a person's transaction rolls back.
    // resolve() returns a cached id without reinserting the row, so a registry that survived the
    // rollback would hand back an id whose row is gone and the next write against it would fail
    // the foreign key, turning one person's failure into everybody's. A fresh registry per
    // person costs one allocation and makes the question moot.
    const registry = new SourceRegistry(input.db)

    // Declared out here so the catch below, not the transaction, decides what a failure means.
    let personReport: RebuildPersonReport
    try {
      // Oldest fetch first, which is the order the syncs wrote in. Not oldest window: a backfill
      // walks history backwards, so window order and write order disagree, and replaying by
      // window would let a stale reading overwrite the correction a later fetch brought.
      const payloads = input.archive.listFor(personId)
      // input.peopleStore, input.priority and input.overrides were built on the outer db handle
      // and are used inside this transaction anyway. That is correct rather than an oversight:
      // better-sqlite3 runs on one connection, so every statement issued while the transaction
      // callback executes is part of the transaction, whichever handle issued it. Two properties
      // depend on it. The version stamp commits and rolls back with the rows it describes, and
      // overrides.listFor below sees the keys retargetOverrides just rewrote. Moving the stores
      // onto tx is not a fix; if this ever does change, both properties have to survive it.
      personReport = input.db.transaction((tx) => {
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

        const dropped = dropUnreferencedSources(tx, personId)

        const retarget = retargetOverrides(tx, { personId, oldSessions })

        const priority = input.priority.load(personId)
        // Read after re-targeting, so a moved key is the one the derivation applies.
        const personOverrides = input.overrides.listFor(personId)
        for (const localDate of counts.localDates) {
          deriveDayInto(tx, {
            personId, localDate, priority, overrides: personOverrides, gapMinutes, overlapRatio,
            nowMs: input.nowMs,
          })
        }

        // Measured after the derive loop rather than summed from what the replay and the
        // derivation each returned, for the same reason replayPerson measures its own counters.
        // deriveDayInto applies day metric exclusions, and those delete provider rows the replay
        // had already counted, so the two returned figures added together overstate the table by
        // one per exclusion. This is the number an operator reads to decide whether their upgrade
        // worked, so it has to be what is actually there.
        const dailyRows = tx.select({ n: sql<number>`count(*)` })
          .from(daily).where(eq(daily.personId, personId)).get()?.n ?? 0

        input.peopleStore.stampBuiltVersions({
          id: personId, mappingVersion: MAPPING_VERSION, derivationVersion: DERIVATION_VERSION,
        })

        return {
          personId,
          reasons,
          samples: counts.samples,
          sessions: counts.sessions,
          daysDerived: counts.localDates.length,
          dailyRows,
          sourcesRemoved: dropped.sources,
          rankingsRemoved: dropped.rankings,
          aliasesRemoved: dropped.aliases,
          overridesRetargeted: retarget.retargeted,
          overridesOrphaned: retarget.orphaned,
          unmappablePayloads: counts.unmappable,
        }
      })
    } catch (error) {
      // Caught per person, so one broken payload shape costs one household member their
      // rebuild instead of costing everybody their sync. The transaction has already rolled
      // back by the time this runs, which is what makes continuing safe: this person keeps
      // the derived rows they had, their version stamp rolled back with them, and so the next
      // boot picks them up again with nothing for an operator to reset. Their sync is skipped
      // meanwhile (see the runner), so the stale rows are never mixed with rows derived at a
      // different version, which is the invariant the stamp exists to protect.
      report.failures.push({
        personId,
        reasons,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      continue
    }

    report.people.push(personReport)
    input.onPersonDone?.(personReport)
  }

  return report
}

/**
 * Removes the source rows the replay did not recreate, and the rankings and names that pointed
 * at them.
 *
 * Source ids are derived from the person and the external id, so a source the current
 * `describe()` still produces comes back under the same id and survives untouched. What is left
 * over is exactly the identities the old mapping produced and the current one does not, which is
 * what makes this the difference between re-deriving source identity and preserving it.
 *
 * The rankings and the names go with them because `source_priority.source_id` and
 * `source_aliases.source_id` are both foreign keys, and a ranking or a name for a source that no
 * longer exists is not something anybody can act on.
 *
 * They are counted separately, and the caller says so out loud, because they are the two things a
 * rebuild destroys that no rebuild can restore. Every other row here comes back from tier 1; a
 * ranking is the household member's own decision about which device wins for which metric, and a
 * name is what they called it, and neither exists anywhere else. Re-targeting them the way
 * overrides are re-targeted is not available: an override's key names an instant we can look up
 * again, while a stale source's identity carries no record of which new identity replaced it, and
 * the change to the identity rules is exactly the thing we cannot invert. So reporting is the
 * whole of what is possible, and reporting nothing would leave a household's merge preferences and
 * source names quietly different after an upgrade.
 */
interface Dropped { sources: number, rankings: number, aliases: number }

function dropUnreferencedSources(tx: DbOrTx, personId: string): Dropped {
  const referenced = new Set<string>([
    ...tx.selectDistinct({ id: samples.sourceId }).from(samples)
      .where(eq(samples.personId, personId)).all().map((row) => row.id),
    ...tx.selectDistinct({ id: sessions.sourceId }).from(sessions)
      .where(eq(sessions.personId, personId)).all().map((row) => row.id),
  ])

  const owned = tx.select({ id: sources.id }).from(sources)
    .where(eq(sources.personId, personId)).all().map((row) => row.id)
  const stale = owned.filter((id) => !referenced.has(id))
  if (stale.length === 0) return { sources: 0, rankings: 0, aliases: 0 }

  const doomed = and(
    eq(sourcePriority.personId, personId),
    inArray(sourcePriority.sourceId, stale),
  )
  // Counted by reading the rows before deleting them rather than off the delete's changes count,
  // for the same reason the replay counts against the table: one source can be ranked for
  // several metrics, so the number an operator needs is rows, not sources.
  const rankings = tx.select({ metric: sourcePriority.metric }).from(sourcePriority)
    .where(doomed).all().length
  tx.delete(sourcePriority).where(doomed).run()

  const doomedAliases = and(
    eq(sourceAliases.personId, personId),
    inArray(sourceAliases.sourceId, stale),
  )
  // Read before deleting, the same way the rankings are: a delete's changes count is not
  // available through this handle and the number an operator needs is rows either way.
  const aliases = tx.select({ sourceId: sourceAliases.sourceId }).from(sourceAliases)
    .where(doomedAliases).all().length
  tx.delete(sourceAliases).where(doomedAliases).run()

  tx.delete(sources).where(inArray(sources.id, stale)).run()
  return { sources: stale.length, rankings, aliases }
}
