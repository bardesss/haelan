import type { Database } from '../db/open.ts'
import type { DeriveQueue } from '../store/deriveQueue.ts'
import type { SourcePriorityStore } from '../store/sourcePriority.ts'
import type { OverrideStore } from '../store/overrides.ts'
import type { Priority } from './priority.ts'
import type { OverrideLike } from './overrides.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from './sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from './sessionOverlap.ts'
import type { SettingsStore } from '../store/settings.ts'
import { deriveDayInto } from './deriveDay.ts'

const DEFAULT_BATCH = 64

export interface DeriveReport { daysDerived: number, rowsWritten: number }

/**
 * Drains the dirty day queue. One transaction per day: a day's rows are replaced wholesale, so
 * a metric whose samples were all excluded loses its row rather than keeping a stale number.
 *
 * The queue entry is cleared inside the same transaction as the rows it produced. A crash
 * between the two would otherwise leave a day that looks derived and is not.
 */
export function runDerive(input: {
  db: Database
  queue: DeriveQueue
  priority: SourcePriorityStore
  overrides: OverrideStore
  settings: SettingsStore
  batch?: number
}): DeriveReport {
  const claimed = input.queue.claim(input.batch ?? DEFAULT_BATCH)
  let rowsWritten = 0

  // Instance wide rather than per person, and read once for the whole drain. A change to either
  // marks nothing dirty today, so a drain that straddles an edit costs a stale night that the
  // next sync of that day corrects.
  const tuning = input.settings.get()
  const gapMinutes = tuning?.nightGapMinutes ?? DEFAULT_NIGHT_GAP_MINUTES
  const overlapRatio = tuning?.sessionOverlapRatio ?? DEFAULT_OVERLAP_RATIO

  // One load per person rather than per day: draining a year of backfill is 365 entries for the
  // same person. A ranking that changes underneath the drain costs a re-derive rather than a
  // wrong row, because a priority write marks the days dirty again.
  const priorities = new Map<string, Priority>()
  const priorityFor = (personId: string): Priority => {
    const cached = priorities.get(personId)
    if (cached) return cached
    const loaded = input.priority.load(personId)
    priorities.set(personId, loaded)
    return loaded
  }

  const overridesByPerson = new Map<string, OverrideLike[]>()
  const overridesFor = (personId: string): OverrideLike[] => {
    const cached = overridesByPerson.get(personId)
    if (cached) return cached
    const loaded = input.overrides.listFor(personId)
    overridesByPerson.set(personId, loaded)
    return loaded
  }

  for (const entry of claimed) {
    input.db.transaction((tx) => {
      rowsWritten += deriveDayInto(tx, {
        personId: entry.personId,
        localDate: entry.localDate,
        priority: priorityFor(entry.personId),
        overrides: overridesFor(entry.personId),
        gapMinutes,
        overlapRatio,
      })
      input.queue.clear([entry], tx)
    })
  }

  return { daysDerived: claimed.length, rowsWritten }
}
