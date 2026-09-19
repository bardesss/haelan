import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database, DbOrTx } from '../db/open.ts'
import { checkpointTruncate } from '../db/open.ts'
import {
  daily, observations, samples, sessions, sources, sourceAliases, sourcePriority,
} from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'
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
import type { RebuildStateStore } from '../store/rebuildState.ts'
import { ObservationStore } from '../store/observations.ts'
import { peopleNeedingRebuild } from './versions.ts'
import { replayPerson } from './replay.ts'
import { retargetOverrides } from './retarget.ts'
import type { OldSession, OrphanedOverride } from './retarget.ts'
import type { Drop } from './withPage.ts'

export interface RebuildPersonReport {
  personId: string
  /** Why this person was rebuilt. Empty when the caller forced it. */
  reasons: string[]
  samples: number
  sessions: number
  /** How many observations were regenerated. Tier 2, the same as samples and sessions beside it. */
  observations: number
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
  /**
   * Pages that could not be replayed and were skipped. Beside `unmappablePayloads` rather than
   * folded into it: one is a data type the catalogue retired, the other is a row that would not
   * go in, and an operator deciding whether to report a bug needs to tell those apart.
   *
   * Nothing is lost when this is non-zero. Tier 1 still holds every body, so a MAPPING_VERSION
   * bump once the cause is fixed replays them with no operator action at all.
   */
  droppedPages: number
  /**
   * Everything this rebuild left in tier 2 and tier 3 added together: `samples`, `sessions`,
   * session segments, `observations` and `dailyRows`, each measured against its own table rather
   * than summed from mapper output.
   *
   * Segments are in it although no field above carries them. They are rows a rebuild writes and
   * a person's sleep detail is made of them, so a replay that produced segments and nothing else
   * did produce something - leaving them out would have been the one way this number could read
   * zero over a person who has data.
   *
   * One number rather than five because of the one question it exists to answer - did this
   * rebuild produce anything at all - and because the surfaces that ask are not reporting volume.
   * Which table is empty is a diagnostic an operator reads out of the log line that already
   * prints them separately.
   *
   * A sum, and so blind to partial drift: one data type drifting while the rest map fine leaves
   * this large and nothing says a word. Accepted, and written down on the column in
   * db/schema/sync.ts rather than implied away.
   */
  rowsWritten: number
  /**
   * How many archived payloads carried at least one data point, straight off replayPerson.
   *
   * Beside `rowsWritten` and useless without it. A rebuild that wrote nothing is an ordinary
   * outcome for a member connected an hour ago, and only the fact that the archive held data
   * turns it into something worth reporting - see producedNothing in store/rebuildState.ts,
   * which is where the pair is read and where the argument lives.
   */
  payloadsWithData: number
  drops: Drop[]
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
   * stamp went with it, so for `daily` they keep the rows they had and the next boot retries
   * them. Not true of `samples` as of M5d-A: migration 0016 drops that table outright, outside
   * any rebuild transaction, so a person whose rebuild then fails has no samples at all until a
   * later boot succeeds, not the rows they had before the upgrade.
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
  /**
   * Where each person's outcome is recorded. Optional so existing callers and tests compile
   * unchanged; an instance always passes it.
   *
   * Called from the catch below and from after the commit, never from inside the transaction
   * callback - see the class comment on RebuildStateStore for why that distinction is the whole
   * point of this field.
   */
  rebuildState?: RebuildStateStore
}

/**
 * Runs one RebuildStateStore write and lets nothing it throws escape.
 *
 * Both recording calls sit outside the person's transaction, which is the whole point of them -
 * a write enlisted in a rebuild that rolled back would roll back with it. The cost of that
 * placement is that they are separate statements against a live database, and recordSuccess
 * opens a write transaction of its own. So they can fail for reasons that have nothing to do
 * with the rebuild they describe: SQLITE_BUSY past the busy timeout is the realistic one, since
 * the boot rebuild runs while the HTTP server is already answering requests, and better-sqlite3
 * throws rather than queueing once that timeout is spent.
 *
 * Unguarded, such a throw escaped the per-person catch below - it is raised from outside the try
 * - abandoned the loop, and rejected runRebuild. `runBootSequence` reads a rejection as
 * structural and deliberately does not start sync, so a lock held for a second longer than the
 * timeout would stop ingestion for every household member, after the person it happened to had
 * already committed. Contention there was caught per person before this branch existed; letting
 * it out again would be a change to rebuild behaviour, which #276a exists precisely not to make.
 *
 * Swallowed rather than reported, the same way runJob guards `onProgress`. What is lost is the
 * durable record of one attempt, and the caller still receives that attempt in the report it
 * returns, which is what `rebuildIfNeeded` logs line by line. The surfaces reading rebuild_state
 * then show the previous attempt until the next rebuild of that person writes over it - stale,
 * and a great deal better than a household that silently stopped syncing.
 */
function recordQuietly(write: () => void): void {
  try { write() } catch { /* the record, not the rebuild */ }
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
        // One instance for this person's transaction, handed to the two helpers below that need
        // it. Not shared with the replay, which makes its own: two instances inside one
        // transaction cost a repeated lookup or two, where one instance escaping the transaction
        // would cost correctness.
        const keys = new SampleKeys(tx)
        tx.delete(samples).where(eq(samples.personRef, keys.personRef(personId))).run()
        // Provider rows included. They are mapped from archived rollup responses like everything
        // else, so the replay puts them back.
        tx.delete(daily).where(eq(daily.personId, personId)).run()
        // Through the store rather than a bare tx.delete, the same way the rest of this function
        // never touches events: deleteForPerson is the one door onto this table a rebuild is
        // allowed to use, and going around it here would leave the guard with nothing behind it.
        new ObservationStore(tx).deleteForPerson(personId)

        const counts = replayPerson(tx, {
          personId, payloads, archive: input.archive, sources: registry, nowMs: input.nowMs,
          // The connection this transaction is running on, which the replay's per-page
          // savepoints are issued against. Same connection, same transaction - the property the
          // comment above already depends on for the stores.
          client: input.db.$client,
        })

        const dropped = dropUnreferencedSources(tx, personId, keys)

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
          observations: counts.observations,
          daysDerived: counts.localDates.length,
          dailyRows,
          sourcesRemoved: dropped.sources,
          rankingsRemoved: dropped.rankings,
          aliasesRemoved: dropped.aliases,
          overridesRetargeted: retarget.retargeted,
          overridesOrphaned: retarget.orphaned,
          unmappablePayloads: counts.unmappable,
          droppedPages: counts.droppedPages,
          // Summed here rather than in the store, so the one definition of "what a rebuild
          // produced" sits beside the counts it adds up and moves with them if a sixth table is
          // ever rebuilt. dailyRows is the figure measured after the derive loop just above, not
          // counts.providerDaily, which is a subset of it.
          rowsWritten: counts.samples + counts.sessions + counts.segments
            + counts.observations + dailyRows,
          payloadsWithData: counts.payloadsWithData,
          drops: counts.drops,
        }
      })
    } catch (error) {
      // Caught per person, so one broken payload shape costs one household member their
      // rebuild instead of costing everybody their sync. The transaction has already rolled
      // back by the time this runs, which is what makes continuing safe: this person's version
      // stamp rolled back with it, and so the next boot picks them up again with nothing for an
      // operator to reset. For `daily` that means they keep the rows they had; for `samples` it
      // does not, since migration 0016 drops that table outright, outside any rebuild
      // transaction, so a failure here leaves them with no samples until a later boot succeeds.
      // Their sync is skipped meanwhile (see the runner), so the stale rows that do survive are
      // never mixed with rows derived at a different version, which is the invariant the stamp
      // exists to protect.
      report.failures.push({
        personId,
        reasons,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      // After the push and outside the transaction, which has already rolled back by the time
      // this runs. That is what makes the write durable: enlisted in the rebuild's own
      // transaction it would roll back with the failure it exists to record.
      //
      // `error.message` is stored and later shown whole - to the affected person on their own
      // sync status, and to any admin on the household-wide route - so this is the one place to
      // ask what can actually reach it, once, rather than trusting each reader to have checked.
      // Nothing inside this try touches the filesystem: every store call here runs against the
      // db handle this function was already given, and reading it does not open anything of its
      // own the way `db/open.ts` does at boot, so there is no path for a Node ENOENT/EACCES
      // message - the kind that embeds a filesystem path - to originate here. A body that fails
      // to parse cannot surface either: mapSamples, mapSessions and mapObservations each wrap
      // their own `JSON.parse(body)` and return no rows rather than throw, and replay.ts's two
      // `JSON.parse(requestParams)` calls do the same, so a corrupted or drifted payload is
      // reported as unmapped, never as this string. A corrupted `bodyGzip` blob still throws
      // out of `RawArchive.getBody`, but as one of zlib's fixed messages ("incorrect header
      // check", "unexpected end of file") - a description of the compression stream, not the
      // household's data inside it.
      //
      // What is left is SQLite's own constraint and corruption messages, which name a table and
      // a column, two families of ConfigError, and the two abandonment errors replayPerson
      // raises itself. None of them is thrown by this file, which throws none of its own.
      //
      // replayPerson's two are the breaker (a run of units that could not be replayed) and the
      // replay that committed nothing. Both name this person's id and a count, and then quote
      // the reason the last drop gave - which is not a new category of content, because that
      // reason is one of the same SQLite or zlib strings already accounted for above, with its
      // volatile tail stripped by dropReason. Both are deliberately worded to say what was
      // observed and not to diagnose a cause, since this is the string the affected person
      // reads on their own dashboard; the comment above the breaker in replay.ts has the why.
      //
      // The mappers raise one when the catalogue and their mapping tables
      // disagree - "<type> is not a sample type", "<type> has no observation mapping declared" -
      // naming a data type id from the shared catalogue. `db/keys.ts` raises the other when an
      // id or a ref it was asked to translate has no row: "no <label> for id <id>" from
      // #resolveRef, and "no metric for ref <n>", "no sample aggregate for ref <n>" and
      // "no <label> for ref <n>" from the readers beside it. Those are reachable from inside the
      // transaction above, through every SampleKeys call the replay and the derive loop make,
      // which is why they are listed rather than left to the mapper category.
      //
      // Both families name internal identifiers and nothing else. A source id is a sha256
      // prefix over the person and the provider's own id for the device; a person id is this
      // instance's key for a household member, which the affected person is already reading
      // their own row of and an admin already sees on members.ts; a raw payload id names one
      // archived response and a ref is a small integer. So: never a bound value, another
      // person's reading, or a location on disk.
      recordQuietly(() => input.rebuildState?.recordFailure({
        personId,
        nowMs: input.nowMs,
        error: error instanceof Error ? error.message : String(error),
      }))
      continue
    }

    // After the commit, never inside it: a checkpoint cannot run within a transaction, and the
    // whole point is to reclaim the log that transaction just produced. Per person rather than
    // once at the end, so a five person household never holds five people's worth of log at once.
    //
    // The return value is deliberately unused. A busy checkpoint means a reader held the file and
    // the space will be reclaimed by the next one; this person's rows are committed either way,
    // and failing their rebuild over a disk tidy-up would be a far worse outcome than a large file.
    checkpointTruncate(input.db)

    // After the commit, for the same reason the failure is recorded after the rollback: this is
    // a durable record of a durable outcome, including whatever replayPerson's own per-page
    // isolation had to skip - the same counts personReport just carried out of the transaction.
    recordQuietly(() => input.rebuildState?.recordSuccess({
      personId, nowMs: input.nowMs,
      droppedPages: personReport.droppedPages, drops: personReport.drops,
      rowsWritten: personReport.rowsWritten, payloadsWithData: personReport.payloadsWithData,
    }))

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

function dropUnreferencedSources(tx: DbOrTx, personId: string, keys: SampleKeys): Dropped {
  // observations.sourceId included alongside samples and sessions, not just those two: a person
  // whose only reading under a source is a mood or a symptom - no sample, no session - would
  // otherwise leave that source "unreferenced" by this function's own count while a freshly
  // replayed observation row still points at it, and the delete below would hit the foreign key
  // observations.source_id declares rather than the row it was actually meant to catch.
  const referenced = new Set<string>([
    // Distinct refs translated back one at a time rather than joined onto `sources`: the set this
    // builds is compared against source ids, and a person carries a handful of sources, so the
    // translation is a handful of cached lookups rather than a join over the largest table.
    ...tx.selectDistinct({ ref: samples.sourceRef }).from(samples)
      .where(eq(samples.personRef, keys.personRef(personId))).all()
      .map((row) => keys.sourceId(row.ref)),
    ...tx.selectDistinct({ id: sessions.sourceId }).from(sessions)
      .where(eq(sessions.personId, personId)).all().map((row) => row.id),
    ...tx.selectDistinct({ id: observations.sourceId }).from(observations)
      .where(eq(observations.personId, personId)).all().map((row) => row.id),
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
