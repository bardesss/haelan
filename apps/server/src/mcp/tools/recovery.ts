import { z } from 'zod'
import { recoveryIndexSeries, bandOf } from '@haelan/core/recovery-index'
import type { RecoveryIndex } from '@haelan/core/recovery-index'
import { readRecoveryInput } from '@haelan/core'
import type { Tool } from '../contract.ts'
import { defineTool } from '../contract.ts'

const RECOVERY_INPUT_KEY = z.enum(['hrv', 'restingHeartRate', 'sleep', 'respiratoryRate'])

// A flat, nullable shape rather than a `z.discriminatedUnion('enough', ...)`: TOOLS.md's own
// generator (`scripts/generate-tools-doc.mjs`) only recurses into a field's children for a plain
// object or an array of one, and no other tool in this catalogue returns a union - a
// discriminated union here rendered as an opaque "array of union" with none of its fields
// documented. `enough` plus nulls is the same shape `compare_periods` already uses for a period
// that could not be judged (`suppressed` plus null fields) and `get_baselines` uses for a metric
// with no baseline (`baseline: null`), so a day that could not be scored answers `enough: false`
// with `score`, `band`, `inputs` and `degraded` all null - never a zero, and never silently
// absent from the array the way a filtered-out day would be.
const RECOVERY_DAY = z.object({
  localDate: z.string(),
  enough: z.boolean(),
  missing: z.array(RECOVERY_INPUT_KEY).nullable().describe(
    'Null when `enough` is true. Otherwise which required inputs were absent, too thin to judge, '
    + 'or standing on a baseline with zero spread - this day was withheld, not scored as a zero.',
  ),
  score: z.number().nullable().describe(
    '0-100, integer. Null when `enough` is false. Distance from this person\'s own baseline, not '
    + 'a readiness verdict.',
  ),
  band: z.enum(['low', 'below', 'usual', 'above', 'high']).nullable().describe('Null when `enough` is false.'),
  inputs: z.array(z.object({
    key: RECOVERY_INPUT_KEY,
    weight: z.number().describe('This input\'s share of the composite, after redistributing any absent input\'s weight.'),
    points: z.number().describe(
      'This input\'s share of the distance between score and 50, scaled by how much every '
      + 'present input moved in total - not by weight alone, so it can read smaller than weight '
      + 'would suggest on a day the inputs disagreed.',
    ),
  })).nullable().describe('Null when `enough` is false.'),
  degraded: z.array(RECOVERY_INPUT_KEY).nullable().describe(
    'Null when `enough` is false. Otherwise the optional inputs that were entirely ABSENT this '
    + 'day; their weight was redistributed across the rest, which is why a present input\'s '
    + 'weight can read higher than its nominal share. Never includes an input listed in '
    + '`reducedWeight` - that input was present, just on reduced evidence, not absent.',
  ),
  reducedWeight: z.array(RECOVERY_INPUT_KEY).nullable().describe(
    'Null when `enough` is false. Otherwise the optional inputs that WERE present this day but on '
    + 'less than their full evidence, and so carried less than their nominal weight rather than '
    + 'being dropped. Today this can only ever be `["sleep"]`, for a week with only duration or '
    + 'only bedtime consistency observed - never treat an input named here as absent the way one '
    + 'named in `degraded` is.',
  ),
})

// `RecoveryIndexUnavailable` carries no `localDate` of its own - the date is the map key
// `recoveryIndexSeries` stores it under - so the caller's date loop hands it in here rather than
// this function reading it off `index`.
function dayOf(localDate: string, index: RecoveryIndex): z.infer<typeof RECOVERY_DAY> {
  if (!index.enough) {
    return {
      localDate, enough: false, missing: [...index.missing], score: null, band: null, inputs: null,
      degraded: null, reducedWeight: null,
    }
  }
  return {
    localDate,
    enough: true,
    missing: null,
    score: index.score,
    band: bandOf(index.score),
    inputs: index.inputs.map((input) => ({ key: input.key, weight: input.weight, points: input.points })),
    degraded: [...index.degraded],
    reducedWeight: [...index.reducedWeight],
  }
}

export const recoveryIndexTool = defineTool({
  name: 'recovery_index',
  description:
    'The recovery index for each day in a date range, oldest first - the same number the app\'s '
    + 'own Recovery page shows when it is left on its default, all-sources view (a Recovery page '
    + 'narrowed to one source computes over that source alone and can disagree with this), built '
    + 'from heart rate variability, resting heart rate, respiratory '
    + 'rate and the past week\'s sleep duration and bedtime consistency, each read against this '
    + 'person\'s own 60-day baseline. `band` names five comparative bands around that baseline - '
    + 'low, below, usual, above, high - never a readiness verdict, only distance from a person\'s '
    + 'own normal. A day with `enough: false` could not be scored at all (see `missing`) and is not '
    + 'the same as a low score; only read `score` and `band` where `enough` is true. Each scored '
    + 'day\'s `inputs` shows how much of that day\'s movement each of the four inputs carried, '
    + 'scaled by how much every present input moved in total - on a day the inputs pulled in '
    + 'different directions, their points do not add up to the distance between `score` and 50, '
    + 'and none is reported as a total. `hrvFilled` says how many of the daily HRV readings behind '
    + 'every score in this answer were filled in from an intraday average rather than the device\'s '
    + 'own daily summary, out of how many were used - HRV is the only one of the four inputs this '
    + 'can ever happen to. A nonzero `filled` means some of the HRV behind these scores was '
    + 'estimated, not measured; say so in words rather than reporting the score as measurement '
    + 'throughout. Report a finding as association with how the day was lived, never as advice, '
    + 'risk or a clinical claim.',
  inputSchema: {
    from: z.string().describe('YYYY-MM-DD, inclusive'),
    to: z.string().describe('YYYY-MM-DD, inclusive'),
  },
  outputSchema: {
    days: z.array(RECOVERY_DAY),
    hrvFilled: z.object({
      filled: z.number(),
      of: z.number(),
    }).describe(
      'How many of the daily HRV readings behind these scores (each day\'s own reading plus its '
      + '60-day baseline) were filled in from an intraday average rather than measured, out of how '
      + 'many were used.',
    ),
  },
  run: (q, args) => {
    const { input, hrvFilled } = readRecoveryInput(q, { from: args.from, to: args.to })
    const byDate = recoveryIndexSeries(input, { from: args.from, to: args.to })
    return { days: [...byDate.entries()].map(([localDate, index]) => dayOf(localDate, index)), hrvFilled }
  },
})

export const recoveryTools: Tool[] = [recoveryIndexTool]
