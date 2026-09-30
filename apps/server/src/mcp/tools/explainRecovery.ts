import { z } from 'zod'
import { recoveryIndexSeries, bandOf } from '@haelan/core/recovery-index'
import type { RecoveryIndex, RecoveryInputKey } from '@haelan/core/recovery-index'
import { readRecoveryInput } from '@haelan/core'
import type { PersonQuery } from '@haelan/core'

/**
 * `explain`'s `recovery` chain: what the recovery index on one day stands on. See explain.ts for
 * the tool.
 *
 * The number is `recovery_index`'s own, read the same way (`readRecoveryInput`, then
 * `recoveryIndexSeries`), so the two cannot come to disagree about a day. Nothing is scored here.
 *
 * Gates first again. A withheld day is not a low score, and a day whose own HRV is an intraday
 * average is not a measured score, so either stops the walk before anything is read off the inputs.
 * A filled day inside the baseline, an absent optional input and sleep on half its evidence are
 * not stops: they are true of the score whatever carried it, so they ride along as clauses on
 * whichever link answers.
 */

export const RECOVERY_LINKS = ['withheld', 'hrvFilledToday', 'usual', 'carriedBy'] as const

export type RecoveryLink = typeof RECOVERY_LINKS[number]

const RECOVERY_INPUT_KEY = z.enum(['hrv', 'restingHeartRate', 'sleep', 'respiratoryRate'])

export const RECOVERY_EVIDENCE = z.object({
  localDate: z.string(),
  enough: z.boolean(),
  missing: z.array(RECOVERY_INPUT_KEY).nullable(),
  score: z.number().nullable(),
  band: z.enum(['low', 'below', 'usual', 'above', 'high']).nullable(),
  inputs: z.array(z.object({ key: RECOVERY_INPUT_KEY, weight: z.number(), points: z.number() })).nullable().describe(
    'The same inputs recovery_index answers. `points` is signed: positive lifted the score, negative '
    + 'lowered it. They do not add up to the distance between `score` and 50 on a day the inputs '
    + 'disagreed, and none of them is a total.',
  ),
  degraded: z.array(RECOVERY_INPUT_KEY).nullable(),
  reducedWeight: z.array(RECOVERY_INPUT_KEY).nullable(),
  dayHrvFilled: z.boolean().nullable().describe(
    'True when the day\'s own HRV reading is its intraday average standing in for the daily '
    + 'reading. Null when the day has none.',
  ),
  hrvFilled: z.object({ filled: z.number(), of: z.number() }).describe(
    'How many of the daily HRV readings behind this score (the day\'s own plus its 60-day '
    + 'baseline) were filled in from an intraday average, out of how many were used.',
  ),
  carriedBy: RECOVERY_INPUT_KEY.nullable().describe('The input that moved the score furthest in its own direction.'),
  pulledAgainst: z.array(RECOVERY_INPUT_KEY).nullable().describe('Inputs that moved the score the other way.'),
})

type Evidence = z.infer<typeof RECOVERY_EVIDENCE>

const NAMES: Readonly<Record<RecoveryInputKey, string>> = {
  hrv: 'heart rate variability',
  restingHeartRate: 'resting heart rate',
  sleep: 'the past week\'s sleep',
  respiratoryRate: 'breathing rate',
}

function listOf(keys: readonly RecoveryInputKey[]): string {
  const names = keys.map((key) => NAMES[key])
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const signed = (points: number): string => `${points >= 0 ? '+' : '-'}${Math.abs(points).toFixed(1)}`

/** A sentence when the link accounts for the score, null to walk on. */
type Link = (evidence: Evidence, index: RecoveryIndex) => string | null

// The caveats that hold for any scored day, whichever link answered. Each is a sentence of its own.
function caveats(evidence: Evidence): string {
  const out: string[] = []
  if (evidence.degraded !== null && evidence.degraded.length > 0) {
    out.push(`It was computed without ${listOf(evidence.degraded)}; that weight went to the other inputs.`)
  }
  if (evidence.reducedWeight !== null && evidence.reducedWeight.includes('sleep')) {
    out.push('The past week\'s sleep stood on only one of duration or bedtime consistency, at half its weight.')
  }
  const baselineFilled = evidence.hrvFilled.filled - (evidence.dayHrvFilled === true ? 1 : 0)
  if (baselineFilled > 0) {
    out.push(`${baselineFilled} of the HRV readings in its baseline ${baselineFilled === 1 ? 'was' : 'were'} filled from an intraday average, not measured.`)
  }
  return out.length === 0 ? '' : ` ${out.join(' ')}`
}

const scoreOf = (e: Evidence): string => `The recovery index on ${e.localDate} is ${e.score}, in the ${e.band} band`

const LINKS: Record<RecoveryLink, Link> = {
  withheld: (e, index) => {
    if (index.enough) return null
    return `No recovery index on ${e.localDate}: ${listOf(index.missing)} ${index.missing.length === 1 ? 'was' : 'were'} `
      + 'absent, too thin to judge, or without any spread to judge against. This is a withheld day, not a low score.'
  },
  hrvFilledToday: (e) => {
    if (e.dayHrvFilled !== true) return null
    return `${scoreOf(e)}, but the day's own HRV reading is its intraday average, not a measured daily `
      + `reading, so the score is not a measurement throughout.${caveats(e)}`
  },
  usual: (e) => {
    if (e.band !== 'usual') return null
    return `${scoreOf(e)}: within this person's own normal, with no input to single out.${caveats(e)}`
  },
  carriedBy: (e, index) => {
    if (!index.enough) return null
    const up = index.score >= 50
    const withScore = index.inputs.filter((input) => (up ? input.points > 0 : input.points < 0))
    const top = [...withScore].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0]
    if (top === undefined) return null
    // A pull that rounds to 0.0 at the precision the sentence prints is not named: "-0.0 the other
    // way" says nothing, and naming it would read as a disagreement the numbers do not show.
    const against = index.inputs.filter((input) => (up ? input.points < 0 : input.points > 0))
      .filter((input) => signed(input.points) !== '+0.0' && signed(input.points) !== '-0.0')
    e.carriedBy = top.key
    e.pulledAgainst = against.map((input) => input.key)
    const distance = Math.abs(index.score - 50)
    const disagreement = against.length === 0
      ? ''
      : ` ${capitalise(listOf(against.map((input) => input.key)))} pulled the other way (${against.map((input) => signed(input.points)).join(', ')}), `
        + 'so the inputs do not add up to the distance from 50.'
    return `${scoreOf(e)}. ${capitalise(NAMES[top.key])} ${up ? 'lifted' : 'lowered'} it most, `
      + `${signed(top.points)} of the ${distance} points between the score and 50.${disagreement}${caveats(e)}`
  },
}

function capitalise(text: string): string {
  return text[0]!.toUpperCase() + text.slice(1)
}

export function walkRecovery(q: PersonQuery, localDate: string): {
  finding: string, stoppedAt: RecoveryLink, walked: RecoveryLink[], evidence: Evidence
} {
  const range = { from: localDate, to: localDate }
  const { input, hrvFilled } = readRecoveryInput(q, range)
  const index = recoveryIndexSeries(input, range).get(localDate)!
  const day = q.series({ metric: 'daily_hrv', agg: 'last', from: localDate, to: localDate }).points[0]
  const evidence: Evidence = index.enough
    ? {
      localDate, enough: true, missing: null, score: index.score, band: bandOf(index.score),
      inputs: index.inputs.map((i) => ({ key: i.key, weight: i.weight, points: i.points })),
      degraded: [...index.degraded], reducedWeight: [...index.reducedWeight],
      dayHrvFilled: day?.filled ?? null, hrvFilled, carriedBy: null, pulledAgainst: null,
    }
    : {
      localDate, enough: false, missing: [...index.missing], score: null, band: null, inputs: null,
      degraded: null, reducedWeight: null, dayHrvFilled: day?.filled ?? null, hrvFilled,
      carriedBy: null, pulledAgainst: null,
    }

  const walked: RecoveryLink[] = []
  for (const link of RECOVERY_LINKS) {
    walked.push(link)
    const finding = LINKS[link](evidence, index)
    if (finding !== null) return { finding, stoppedAt: link, walked, evidence }
  }
  // A scored day outside the usual band has moved away from 50, so some input moved it that way
  // and carriedBy answers. Reaching here would mean the index and its own inputs disagree.
  throw new Error(`the recovery chain ended without a finding on ${localDate}`)
}
