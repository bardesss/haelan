import type { HrvDeviationRun } from '@haelan/core'

/**
 * The one sentence both of `explain`'s chains print when the seven-day HRV average has stayed on one
 * side of the person's own band. It leads with a space so it can be appended to a finding. It says
 * how long, since when, how many of the last seven nightly readings stood outside the band on that side, and,
 * when some of the stretch stood on filled HRV, that those days were not measured.
 */
export function hrvRunSentence(run: HrvDeviationRun): string {
  const length = run.capped ? 'more than 60 measured days' : `${run.days} measured days`
  const nights = run.side === 'below' ? 'low' : 'high'
  const filled = run.filledDays === 0 ? ''
    : ` ${run.filledDays} of those days' HRV ${run.filledDays === 1 ? 'was' : 'were'} filled from an intraday average, not measured.`
  return ` HRV's seven-day average has been ${run.side} its usual for ${length}, since ${run.since}; `
    + `${run.sideNights} of the last 7 nightly readings were ${nights}.${filled}`
}
