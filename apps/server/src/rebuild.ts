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
