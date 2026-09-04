import { setImmediate } from 'node:timers/promises'
import { PeopleStore, peopleNeedingRebuild, runRebuild } from '@haelan/core'
import type { RebuildFailure, RebuildReport, openHaelan } from '@haelan/core'

// Re-exported so rebuildWorker.ts and rebuildInWorker.ts, which know rebuildIfNeeded through this
// module rather than through @haelan/core directly, can name the shape of what it returns.
export type { RebuildFailure, RebuildReport }

export interface BootRebuildDeps {
  instance: ReturnType<typeof openHaelan>
  nowMs: () => number
  log: (line: string) => void
}

/**
 * Rebuilds whoever needs it, yielding to the event loop once between each person.
 *
 * better-sqlite3 is synchronous, so runRebuild holds Node's only thread for the whole of one
 * person's rebuild; the `await setImmediate()` below only opens a gap after that person's
 * transaction has already returned, before the next one starts. That gap does nothing for a
 * household of one, which a self hosted personal dashboard mostly is: with a single person there
 * is no "between" for it to fall in, so the entire rebuild runs inside one turn regardless, and
 * that was measured at about fifteen minutes on real data. What actually keeps the caller
 * reachable during that time is running this whole function off the main thread, which is what
 * rebuildInWorker.ts now does; this function's own shape is unchanged and is still what atomicity
 * within a person rests on, since nobody ever reads a person whose tier 2 and tier 3 disagree.
 */
export async function rebuildIfNeeded(deps: BootRebuildDeps): Promise<RebuildReport> {
  const peopleStore = new PeopleStore(deps.instance.db)
  const needs = peopleNeedingRebuild(peopleStore.list())
  if (needs.length === 0) return { people: [], failures: [] }

  deps.log(`rebuild needed for ${needs.length} of ${peopleStore.count()} people`)

  // Built once from the instance's own stores, the same ones the sync runner's derive step
  // reads (see sync/runner.ts #derive): one DeriveQueue and one OverrideStore per instance,
  // never a second set that could disagree with the one everything else uses.
  const shared = {
    db: deps.instance.db,
    archive: deps.instance.archive,
    peopleStore,
    priority: deps.instance.sourcePriority,
    overrides: deps.instance.overrides,
    settings: deps.instance.settings,
  }

  const reports: RebuildReport = { people: [], failures: [] }
  for (const need of needs) {
    deps.log(`rebuilding ${need.personId}: ${need.reasons.join(', ')}`)
    const report = runRebuild({ ...shared, personIds: [need.personId], nowMs: deps.nowMs() })
    // Named individually, for the same reason an orphaned override is, and for a sharper one:
    // this person stops receiving data until a later boot rebuilds them, so the log has to say
    // who and why plainly enough that somebody can go and look. A count would say only that
    // something somewhere is wrong, which is the least useful thing a log can say about a
    // household member who has quietly stopped ingesting.
    for (const failure of report.failures) {
      reports.failures.push(failure)
      deps.log(
        `${failure.personId} could not be rebuilt and will be skipped by sync until a later boot `
        + `rebuilds them: ${failure.error.message}`,
      )
    }
    for (const person of report.people) {
      reports.people.push(person)
      deps.log(
        `rebuilt ${person.personId}: ${person.samples} samples, ${person.sessions} sessions, `
        + `${person.dailyRows} daily rows over ${person.daysDerived} days, `
        + `${person.sourcesRemoved} stale sources removed`,
      )
      // Named individually rather than counted. A correction somebody took the trouble to make
      // and that no longer applies is worth a line each, not a number to be scrolled past.
      for (const orphan of person.overridesOrphaned) {
        deps.log(`override ${orphan.id} no longer applies: ${orphan.reason}`)
      }
      // Its own line for the same reason, and only when there is something to say. Every other
      // number above describes rows that came back from tier 1; this one describes the household
      // member's own choice of which device wins for which metric, which went with the sources it
      // named and which nothing can regenerate or move onto the identities that replaced them.
      // Folded into the "stale sources removed" count it would read as housekeeping.
      if (person.rankingsRemoved > 0) {
        deps.log(
          `${person.rankingsRemoved} source rankings for ${person.personId} went with those `
          + 'sources and cannot be rebuilt, so set them again',
        )
      }
      // Its own line and only when there is something to say, for the same reason the rankings
      // get one: a name somebody typed is not a row that came back from tier 1, and folded into
      // the stale source count it would read as housekeeping.
      if (person.aliasesRemoved > 0) {
        deps.log(
          `${person.aliasesRemoved} source names for ${person.personId} went with those sources `
          + 'and cannot be rebuilt, so set them again',
        )
      }
      if (person.unmappablePayloads > 0) {
        deps.log(`${person.unmappablePayloads} payloads had no current mapper and were skipped`)
      }
    }
    // Back to the event loop, so requests queued during that person's transaction are answered
    // before the next one begins.
    await setImmediate()
  }

  return reports
}

export interface BootSequenceDeps {
  /**
   * Runs the rebuild. A callback rather than a call, so this function has nothing to reach for.
   *
   * It resolves with the people it could not rebuild rather than throwing for them, which is the
   * distinction this whole sequence now turns on: a resolved report with failures in it is one
   * or more household members quarantined, and a rejection is something structural.
   */
  rebuild: () => Promise<{ failures: readonly RebuildFailure[] }>
  /** Starts the sync runner. Not called at all when the rebuild throws. */
  startSync: () => void
  log: (line: string) => void
  logError: (message: string, error: unknown) => void
}

/**
 * Runs the rebuild, then starts the sync runner, and never rejects.
 *
 * Before the runner, because a sync landing mid rebuild would write samples that the replay,
 * having already listed the archive, deletes without replaying. Serialising the two costs one
 * sync interval and removes the hole entirely.
 *
 * The promise this returns is the one `shutdown` awaits, and a rejected promise nothing has
 * attached a handler to is how a shutdown turns into an unhandled rejection rather than a clean
 * exit. So a failed rebuild is caught here, reported loudly through `logError`, and never
 * rethrown.
 *
 * A throw and a per person failure mean different things, and this is where the difference is
 * spent. A throw is structural, so the sequence stops before `startSync`: the rebuild is what
 * makes the derived rows trustworthy, and a sync appending rows to a tier nobody has verified is
 * worse than no sync. A person the rebuild reported as failed is quarantined instead. Sync
 * starts, the runner skips that person because their stamp is not at the current versions, and
 * every other household member goes on ingesting. Refusing to start for everybody used to be the
 * safe direction, and it is not: intraday samples have a shelf life, because the API only
 * retains them for a recent window, so a household held out of sync until somebody edits code
 * loses minute level history permanently, one day at a time, for a fault in one person's data.
 *
 * Pulled out of index.ts, a top level script with side effects that nothing could import and
 * test, into a function that takes its collaborators as parameters. This is what makes the
 * ordering itself, not just the comments describing it, something a test can hold a mutation
 * against.
 */
export async function runBootSequence(deps: BootSequenceDeps): Promise<void> {
  let outcome: { failures: readonly RebuildFailure[] }
  try {
    outcome = await deps.rebuild()
  } catch (error) {
    deps.logError('rebuild failed, sync not started', error)
    return
  }
  // Through logError rather than log, and one line each. rebuildIfNeeded has already said this
  // once on the way past, but that line is a progress line among many; this one is the state the
  // instance is now in, and it is the last thing said before sync starts without these people.
  for (const failure of outcome.failures) {
    deps.logError(
      `${failure.personId} is quarantined: sync will skip them until a boot rebuilds them`,
      failure.error,
    )
  }
  deps.startSync()
  deps.log('sync runner started')
}
