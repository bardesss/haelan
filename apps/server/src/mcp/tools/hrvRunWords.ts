import { HRV_DEVIATION_LOOKBACK_DAYS } from '@haelan/core'
import type { HrvDeviationRun } from '@haelan/core'

/**
 * The one sentence both of `explain`'s chains print when the seven-day HRV average has stayed on one
 * side of the person's own band. It leads with a space so it can be appended to a finding. It says
 * how long, since when (unless the run reached the lookback's cap), how many of the readings in
 * the last seven days stood outside the band on that side, and, when some of the stretch stood on
 * filled HRV, that those days were not measured.
 */
export function hrvRunSentence(run: HrvDeviationRun): string {
  // A capped run can hold fewer measured days than the lookback has days, and its first day is
  // only where the lookback began, so it gets neither "measured" nor a since date.
  const length = run.capped ? `more than ${HRV_DEVIATION_LOOKBACK_DAYS} days` : `${run.days} measured days, since ${run.since}`
  const nights = run.side === 'below' ? 'low' : 'high'
  const filled = run.filledDays === 0 ? ''
    : ` ${run.filledDays} of those days' HRV ${run.filledDays === 1 ? 'was' : 'were'} filled from an intraday average, not measured.`
  return ` HRV's seven-day average has been ${run.side} its usual for ${length}; `
    + `${run.sideNights} of the last ${run.weekReadings} nightly readings were ${nights}.${filled}`
}
