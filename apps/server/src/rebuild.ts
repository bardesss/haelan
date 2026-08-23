import { setImmediate } from 'node:timers/promises'
import { PeopleStore, peopleNeedingRebuild, runRebuild } from '@haelan/core'
import type { RebuildPersonReport, openHaelan } from '@haelan/core'

export interface BootRebuildDeps {
  instance: ReturnType<typeof openHaelan>
  nowMs: () => number
  log: (line: string) => void
}

/**
 * Rebuilds whoever needs it, one person per turn of the event loop.
 *
 * better-sqlite3 is synchronous, so a rebuild holds Node's only thread for as long as it runs.
 * One person per call with a yield in between gives Fastify the gaps it needs to keep answering,
 * which is the difference between a slow upgrade and an unreachable one. Inside a single person
 * the thread is still held, and that is the price of the atomicity the design rests on: nobody
 * ever reads a person whose tier 2 and tier 3 disagree.
 */
export async function rebuildIfNeeded(deps: BootRebuildDeps): Promise<RebuildPersonReport[]> {
  const peopleStore = new PeopleStore(deps.instance.db)
  const needs = peopleNeedingRebuild(peopleStore.list())
  if (needs.length === 0) return []

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

  const reports: RebuildPersonReport[] = []
  for (const need of needs) {
    deps.log(`rebuilding ${need.personId}: ${need.reasons.join(', ')}`)
    const report = runRebuild({ ...shared, personIds: [need.personId], nowMs: deps.nowMs() })
    for (const person of report.people) {
      reports.push(person)
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
  /** Runs the rebuild. A callback rather than a call, so this function has nothing to reach for. */
  rebuild: () => Promise<unknown>
  /** Starts the sync runner. Called only once the rebuild has succeeded. */
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
 * rethrown: the rebuild is what makes the derived rows trustworthy, so a failed one must not be
 * followed by a sync appending more rows to a tier nobody has verified, and the sequence simply
 * stops before `startSync` rather than resolving to something the caller has to remember to
 * unwrap.
 *
 * Pulled out of index.ts, a top level script with side effects that nothing could import and
 * test, into a function that takes its collaborators as parameters. This is what makes the
 * ordering itself, not just the comments describing it, something a test can hold a mutation
 * against.
 */
export async function runBootSequence(deps: BootSequenceDeps): Promise<void> {
  try {
    await deps.rebuild()
  } catch (error) {
    deps.logError('rebuild failed, sync not started', error)
    return
  }
  deps.startSync()
  deps.log('sync runner started')
}
