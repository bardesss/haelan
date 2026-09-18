import { peopleNeedingRebuild, runDerive } from '@haelan/core'
import type { Instance } from '@haelan/core'
import type { Stores } from '../app.ts'

/**
 * Days per tick rather than a millisecond budget. The per-day cost is the thing that was
 * measured, and a millisecond budget silently drains fewer days on a slower disk, which is the
 * opposite of what a budget is for. 64 is runDerive's own default batch.
 */
export const DRAIN_DAYS_PER_TICK = 64

/** Long enough that an idle instance is idle, short enough that a backlog converges in an hour. */
export const DRAIN_TICK_MS = 30_000

export interface DrainDeps {
  instance: Instance
  stores: Stores
  nowMs: () => number
  /**
   * Whether the boot rebuild is still holding the write lock. The same flag ServerDeps threads
   * through as rebuildInFlight for the reclaim and backup routes, for the same reason: this
   * process is not the only thing that can be writing haelan.sqlite while it is true.
   */
  rebuildRunning: () => boolean
}

/**
 * Whether this tick does anything. Split from the loop so the rule is testable without a timer,
 * and so the two reasons to stand down are named rather than buried in a condition.
 *
 * The rebuild check exists because of an outage this project already shipped: version 1.16.0's
 * boot rebuild holds the SQLite write lock for its whole run, so a second writer on a request
 * path is not a slow request there, it is an outage. A tick that ran anyway would be that second
 * writer.
 */
export function shouldDrain(input: { rebuildRunning: boolean, queueSize: number }): boolean {
  if (input.rebuildRunning) return false
  return input.queueSize > 0
}

/**
 * One tick. Returns the days derived, which the timer can log or use to decide whether to look
 * again sooner than the next tick.
 *
 * The eligibility gate is the one SyncRunner#eligible and annotations.ts's drain helper both
 * apply, and for the same reason recorded there: a person whose boot rebuild failed still carries
 * tier 2 built by an older mapper, and deriving their queued days now would write tier 3 at the
 * current version on top of it, leaving the two tiers disagreeing with no record of which rows
 * came from which.
 */
export function drainOnce(deps: DrainDeps): number {
  if (!shouldDrain({
    rebuildRunning: deps.rebuildRunning(),
    queueSize: deps.instance.deriveQueue.size(),
  })) return 0

  const people = deps.stores.people.list()
  const behind = new Set(peopleNeedingRebuild(people).map((need) => need.personId))
  const eligible = people.filter((person) => !behind.has(person.id)).map((person) => person.id)
  if (eligible.length === 0) return 0

  try {
    return runDerive({
      db: deps.instance.db,
      queue: deps.instance.deriveQueue,
      priority: deps.instance.sourcePriority,
      overrides: deps.instance.overrides,
      settings: deps.instance.settings,
      nowMs: deps.nowMs(),
      batch: DRAIN_DAYS_PER_TICK,
      personIds: eligible,
    }).daysDerived
  } catch (error) {
    // Failures stay inside, the way SyncRunner#derive keeps its own: a derivation defect must
    // not take the server down or kill the timer. The days stay queued and the next tick tries
    // again.
    console.log(`drainer: derivation failed, ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}
