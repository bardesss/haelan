import { z } from 'zod'
import { readHrvDeviation, roundMetricValue } from '@haelan/core'
import type { HrvDeviationDay } from '@haelan/core'
import type { Tool } from '../contract.ts'
import { defineTool } from '../contract.ts'

// A flat, nullable day rather than a discriminated union, for the reason recovery.ts gives above
// RECOVERY_DAY: TOOLS.md's generator documents plain objects and arrays of them, not unions. A day
// that could not be judged answers `measured: false` with its `reason` and nulls, never absent.
export const HRV_DAY = z.object({
  localDate: z.string(),
  measured: z.boolean(),
  reason: z.enum(['thin-week', 'thin-baseline', 'flat-baseline']).nullable().describe(
    'Null when `measured` is true. thin-week: fewer than four HRV readings in the seven days ending here. '
    + 'thin-baseline: too few days in the 60 before that week. flat-baseline: those 60 days did not vary at all.',
  ),
  rolling: z.number().nullable().describe('The seven-day average HRV in ms, averaged on the log scale. Null when not measured.'),
  low: z.number().nullable().describe('The low edge of this person\'s own band for that average, in ms. Null when not measured.'),
  high: z.number().nullable().describe('The high edge, in ms. Null when not measured.'),
  side: z.enum(['below', 'within', 'above']).nullable().describe('Null when not measured.'),
})

export const HRV_RUN = z.object({
  side: z.enum(['below', 'above']),
  days: z.number().describe('Measured days in a row the seven-day average has been on this side. Days without enough readings are skipped, not counted.'),
  capped: z.boolean().describe('True when the run is longer than the 60 days looked back over.'),
  since: z.string(),
  sideNights: z.number().describe('Of the readings in the last seven days, how many were outside the band on this side. Out of `weekReadings`, not out of seven.'),
  weekReadings: z.number().describe('How many HRV readings the last seven days hold, `to` and the six before it. Fewer than seven when nights are missing.'),
  filledDays: z.number().describe('Days in the run whose HRV was an intraday average standing in for a measured reading.'),
}).nullable()

function dayOf(day: HrvDeviationDay): z.infer<typeof HRV_DAY> {
  if (!day.measured) {
    return { localDate: day.localDate, measured: false, reason: day.reason, rolling: null, low: null, high: null, side: null }
  }
  return {
    localDate: day.localDate,
    measured: true,
    reason: null,
    rolling: roundMetricValue('daily_hrv', day.rolling),
    low: roundMetricValue('daily_hrv', day.band.low),
    high: roundMetricValue('daily_hrv', day.band.high),
    side: day.side,
  }
}

export const hrvDeviationTool = defineTool({
  name: 'hrv_deviation',
  description:
    'The seven-day average of heart rate variability against this person\'s own band for each day in '
    + 'a date range, oldest first, and `run`: whether that average has stayed on one side of the band '
    + 'for at least three measured days in a row as of `to` (null when it has not). Both directions '
    + 'are reported and neither is a verdict: a long stretch above the band is not "recovered", and a '
    + 'long stretch below is not a diagnosis, only distance from a person\'s own usual. A day with '
    + '`measured: false` had too little to judge (see `reason`) and is not the same as a low reading; '
    + 'only read `rolling`, `low`, `high` and `side` where `measured` is true. Days in `run` without '
    + 'enough readings are skipped, not counted. A nonzero `run.filledDays` means some of the stretch '
    + 'stood on HRV filled in from an intraday average rather than the device\'s own daily summary; '
    + 'say so in words rather than reporting the stretch as measurement throughout. Report a finding '
    + 'as association with how the days were lived, never as advice, risk or a clinical claim.',
  inputSchema: {
    from: z.string().describe('YYYY-MM-DD, inclusive'),
    to: z.string().describe('YYYY-MM-DD, inclusive. The run is read as of this day.'),
  },
  outputSchema: {
    days: z.array(HRV_DAY),
    run: HRV_RUN,
  },
  run: (q, args) => {
    const { days, run } = readHrvDeviation(q, { from: args.from, to: args.to })
    return { days: days.map(dayOf), run }
  },
})

export const hrvDeviationTools: Tool[] = [hrvDeviationTool]
