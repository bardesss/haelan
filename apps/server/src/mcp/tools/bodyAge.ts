import { z } from 'zod'
import { LOCAL_DATE } from '../dates.ts'
import type { Tool } from '../contract.ts'
import { defineTool } from '../contract.ts'
import { roundBodyAge } from '../../routes/v1/bodyAge.ts'

const FACTOR_KEY = z.enum(['vo2Max', 'restingHeartRate', 'hrv', 'activity', 'sleepRegularity', 'strength'])

// A flat, nullable shape rather than a discriminated union on `enough`, for the reason
// recovery_index gives: TOOLS.md's generator documents only plain objects and arrays of them.
const FACTOR = z.object({
  key: FACTOR_KEY,
  value: z.number().nullable().describe('The person\'s own figure in the factor\'s unit. Null when `missing` is set.'),
  reference: z.number().nullable().describe('The typical figure for this age and sex, same unit. Null when `missing` is set.'),
  years: z.number().describe('Years this factor adds (positive) or takes away (negative), within its own cap. 0 when `missing` is set.'),
  capped: z.boolean().describe('True when the factor hit its own cap, so a larger difference would not have moved it further.'),
  missing: z.enum(['tooFewDays', 'noReading']).nullable().describe(
    'Null when the factor was scored. Otherwise it had too few days in the 30-day window, or none, '
    + 'and adds 0 years - withheld, not scored as typical.',
  ),
})

export const bodyAgeTool = defineTool({
  name: 'body_age',
  description:
    'A body age: the calendar age whose mortality risk matches this person\'s resting heart rate, '
    + 'VO2 max, weekly activity, bedtime regularity and strength training over the last 30 days, each '
    + 'read against the typical value for their age and sex. It is an estimate from published '
    + 'associations, not a measurement of cells or of anything inside the body. Read at the most '
    + 'recent day with a resting heart rate, named in `asOf`. `gap` is body age minus calendar age '
    + '(negative is younger), the sum of the factors\' `years`, held within a total cap. `carriedBy` '
    + 'names the factor holding at least half the years in the gap\'s direction, and `mostRoom` the '
    + 'factor adding the most years, the one that would give the most back at its typical value. `pace` is years '
    + 'of body age lived per calendar year over the last twelve months (1 is keeping pace, under 1 '
    + 'is slowing). `changeAgainstPrevious` is the body age now minus the body age 30 days earlier. '
    + '`fitnessAge` is the age at which this VO2 max would be typical, null outside 25-75. A '
    + 'person with `enough: false` has no body age: `missing` lists what is absent (birthDate, sex, '
    + 'or a VO2 max reading in the last 180 days) and every figure is null. `enough: false` with '
    + '`missing` and `asOf` both null means there is no scored day at all. A factor with `missing` '
    + 'set adds nothing and is not the same as a typical value. Report '
    + 'a finding as association with how the days were lived, never as advice, risk or a clinical '
    + 'claim.',
  inputSchema: {
    today: LOCAL_DATE.describe(
      "YYYY-MM-DD, today in the person's own zone. Days after it do not count, which is what keeps "
      + "this answer the same as the app's.",
    ),
  },
  outputSchema: {
    enough: z.boolean(),
    missing: z.array(z.enum(['birthDate', 'sex', 'vo2Max'])).nullable().describe(
      'Null when `enough` is true, and also null when there is no scored day at all. Otherwise the '
      + 'inputs a body age cannot be made without.',
    ),
    asOf: z.string().nullable().describe('YYYY-MM-DD, the last day of the 30-day window. Null when there is no scored day.'),
    calendarAge: z.number().nullable().describe('Years, 1 decimal. Null when `enough` is false.'),
    bodyAge: z.number().nullable().describe('Years, 1 decimal. Null when `enough` is false.'),
    gap: z.number().nullable().describe('Body age minus calendar age, years. Negative is younger. Null when `enough` is false.'),
    pace: z.number().nullable().describe('Null until the history reaches back twelve months.'),
    changeAgainstPrevious: z.number().nullable().describe(
      'Body age now minus body age 30 days earlier, years. Null when either is unavailable.',
    ),
    carriedBy: FACTOR_KEY.nullable().describe('Null when no single factor holds half the years in the gap\'s direction.'),
    mostRoom: z.object({ key: FACTOR_KEY, years: z.number() }).nullable().describe(
      'The factor adding the most years, with those years. Null when no factor adds any.',
    ),
    fitnessAge: z.number().nullable(),
    factors: z.array(FACTOR).describe('Empty when `enough` is false.'),
  },
  run: (q, args) => {
    const read = roundBodyAge(q.bodyAge({ today: args.today }))
    const { current, previous } = read
    if (current === null) {
      return {
        enough: false, missing: null, asOf: null, calendarAge: null, bodyAge: null, gap: null, pace: null,
        changeAgainstPrevious: null, carriedBy: null, mostRoom: null, fitnessAge: null, factors: [],
      }
    }
    if (!current.enough) {
      return {
        enough: false, missing: current.missing, asOf: current.endDate, calendarAge: null, bodyAge: null, gap: null,
        pace: null, changeAgainstPrevious: null, carriedBy: null, mostRoom: null, fitnessAge: null, factors: [],
      }
    }
    return {
      enough: true,
      missing: null,
      asOf: current.endDate,
      calendarAge: current.calendarAge,
      bodyAge: current.bodyAge,
      gap: current.gap,
      pace: read.pace,
      // Both are already rounded to a tenth, so the difference is taken again to a tenth: 0.1 + 0.2.
      changeAgainstPrevious: previous === null ? null : Math.round((current.bodyAge - previous.bodyAge) * 10) / 10,
      carriedBy: current.carriedBy,
      mostRoom: current.mostRoom,
      fitnessAge: current.fitnessAge,
      factors: current.factors.map((f) => ({
        key: f.key, value: f.value, reference: f.reference, years: f.years, capped: f.capped, missing: f.missing,
      })),
    }
  },
})

export const bodyAgeTools: Tool[] = [bodyAgeTool]
