import type { DeriveReport, OnDayFailed } from '@haelan/core'

/**
 * Lets a drain loop tell "nothing left that can be derived" from "this batch only held days that
 * failed". A batch that derived nothing used to end the drain, so a few poisoned days at the
 * front hid every good day behind them. A failure counts as progress the first time a day fails
 * in this drain, because that day then sits at the back of the queue and the next claim reaches
 * the days behind it; a day failing again means the queue has cycled back to days already tried.
 */
export function trackFailures(log: OnDayFailed): { onDayFailed: OnDayFailed, stalled: (report: DeriveReport) => boolean } {
  const seen = new Set<string>()
  let fresh = false
  return {
    onDayFailed: (entry, error, failures) => {
      const key = `${entry.personId}|${entry.localDate}`
      if (!seen.has(key)) {
        seen.add(key)
        fresh = true
      }
      log(entry, error, failures)
    },
    stalled: (report) => {
      const sawFresh = fresh
      fresh = false
      return report.daysDerived === 0 && !sawFresh
    },
  }
}
