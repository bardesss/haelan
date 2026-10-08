import { z } from 'zod'
import { metricSpec } from '@haelan/core/metrics'
import { FLAT_SPREAD_EPSILON } from '@haelan/core'
import type { Baseline, PersonQuery } from '@haelan/core'

/**
 * `explain`'s `comparison` chain: what a period's mean against the equal period before it can and
 * cannot say. See explain.ts for the tool.
 *
 * The comparison is compare_periods' own (PersonQuery.comparePeriods), so the two cannot come to
 * disagree about a period or a refusal. Its two refusals are gates here and stop the walk: a
 * suppressed comparison is not enough data, never no change, and the finding says which.
 *
 * Past the gates, the difference is set against the person's own day-to-day spread for the metric
 * - the baseline get_baselines answers, taken as of the current period's first day, so neither
 * period's days sit in it. Smaller than that spread, the two periods read alike; larger, the mean
 * moved. That is a conservative bar chosen here, not a significance test: a mean over many days
 * varies less than one day does, so a difference under one day's spread is well inside what the
 * days themselves wander by. Filled days are stated whichever link answers.
 */

export const COMPARISON_LINKS = ['thinDays', 'thinCoverage', 'spreadUnknown', 'withinSpread', 'moved'] as const

export type ComparisonLink = typeof COMPARISON_LINKS[number]

const FILLED = z.object({ filled: z.number(), of: z.number() })

export const COMPARISON_EVIDENCE = z.object({
  metric: z.string(),
  agg: z.string(),
  source: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  previousFrom: z.string(),
  previousTo: z.string(),
  current: z.number().nullable(),
  previous: z.number().nullable(),
  delta: z.number().nullable(),
  periodDays: z.number(),
  currentDays: z.number(),
  previousDays: z.number(),
  currentCoverage: z.number().nullable(),
  previousCoverage: z.number().nullable(),
  reason: z.enum(['thin-days', 'thin-coverage']).nullable(),
  currentFilledDays: FILLED,
  previousFilledDays: FILLED,
  spread: z.object({ spread: z.number(), n: z.number(), thin: z.boolean() }).nullable().describe(
    'The person\'s own day-to-day spread for the metric, from the 60 days before `from`. Only read past the gates.',
  ),
})

type Evidence = z.infer<typeof COMPARISON_EVIDENCE>

export interface ComparisonArgs { metric: string, agg: string, from: string, to: string, source: string | undefined }

const UNITS: Readonly<Record<string, string>> = {
  count: '', bpm: ' bpm', minutes: ' minutes', ms: ' ms', percent: '%', breaths_per_minute: ' breaths a minute',
  celsius: ' °C', kg: ' kg', meters: ' m', kcal: ' kcal',
}

function show(metric: string, value: number): string {
  const spec = metricSpec(metric)
  const unit = spec === undefined ? '' : UNITS[spec.unit] ?? ` ${spec.unit.replaceAll('_', ' ')}`
  return `${value.toFixed(spec?.precision ?? 1)}${unit}`
}

function filledClause(e: Evidence): string {
  const { currentFilledDays: c, previousFilledDays: p } = e
  if (c.filled === 0 && p.filled === 0) return ''
  return ` ${c.filled} of the ${c.of} days in ${e.from} to ${e.to} and ${p.filled} of the ${p.of} before it were filled from `
    + 'an intraday average, not measured.'
}

const periods = (e: Evidence): string => `${e.from} to ${e.to} against ${e.previousFrom} to ${e.previousTo}`

const means = (e: Evidence): string =>
  `${e.metric} averaged ${show(e.metric, e.current!)} from ${e.from} to ${e.to}, against ${show(e.metric, e.previous!)} from ${e.previousFrom} to ${e.previousTo}`

/** A sentence when the link accounts for the comparison, null to walk on. */
type Link = (e: Evidence, spread: () => Baseline | null) => string | null

const LINKS: Record<ComparisonLink, Link> = {
  thinDays: (e) => {
    if (e.reason !== 'thin-days') return null
    return `Not enough data to compare ${periods(e)}: ${e.currentDays} and ${e.previousDays} of their ${e.periodDays} `
      + 'days carry a reading, short of the seven in ten a period needs. This is not a finding of no change.'
  },
  thinCoverage: (e) => {
    if (e.reason !== 'thin-coverage') return null
    return `Not enough data to compare ${periods(e)}: the days that carry a reading were too thinly observed to stand on. `
      + 'This is not a finding of no change.'
  },
  spreadUnknown: (e, spread) => {
    const s = spread()
    // Not `> 0`: a flat baseline's float residue (~1e-16) is no usual spread either, the same
    // rule zScoreOf applies.
    if (s !== null && !s.thin && s.spread >= FLAT_SPREAD_EPSILON) return null
    return `${means(e)}, a `
      + `difference of ${show(e.metric, e.delta!)}. There is no usual day-to-day spread thick enough to set it against, so `
      + `whether that is a change is not judged.${filledClause(e)}`
  },
  withinSpread: (e, spread) => {
    const s = spread()!
    if (Math.abs(e.delta!) >= s.spread) return null
    return `${means(e)}: a `
      + `difference of ${show(e.metric, e.delta!)}, inside this person's usual day-to-day spread of `
      + `${show(e.metric, s.spread)}, so the two periods read alike.${filledClause(e)}`
  },
  moved: (e, spread) => {
    const s = spread()!
    return `${means(e)}: `
      + `${e.delta! > 0 ? 'higher' : 'lower'} by ${show(e.metric, Math.abs(e.delta!))}, more than this person's usual `
      + `day-to-day spread of ${show(e.metric, s.spread)}.${filledClause(e)}`
  },
}

export function walkComparison(q: PersonQuery, args: ComparisonArgs): {
  finding: string, stoppedAt: ComparisonLink, walked: ComparisonLink[], evidence: Evidence
} {
  const { metric, agg, from, to, source } = args
  const insight = q.comparePeriods({ metric, agg, from, to, source })
  const previousRange = insight.previousRange!
  // Filled days counted over the same two windows compare_periods itself reopens.
  const filledOf = (range: { from: string, to: string }) => {
    const points = q.series({ metric, agg, from: range.from, to: range.to, source }).points
    return { filled: points.filter((p) => p.filled).length, of: points.length }
  }
  const evidence: Evidence = {
    metric, agg, source: source ?? null, from, to, previousFrom: previousRange.from, previousTo: previousRange.to,
    current: insight.current, previous: insight.previous, delta: insight.delta, periodDays: insight.periodDays,
    currentDays: insight.currentDays, previousDays: insight.previousDays,
    currentCoverage: insight.currentCoverage, previousCoverage: insight.previousCoverage, reason: insight.reason,
    currentFilledDays: filledOf({ from, to }), previousFilledDays: filledOf(previousRange), spread: null,
  }
  let read: Baseline | null | undefined
  const spread = (): Baseline | null => {
    if (read === undefined) {
      read = q.baseline({ metric, agg, on: from, source })
      evidence.spread = read === null ? null : { spread: read.spread, n: read.n, thin: read.thin }
    }
    return read
  }

  const walked: ComparisonLink[] = []
  for (const link of COMPARISON_LINKS) {
    walked.push(link)
    const finding = LINKS[link](evidence, spread)
    if (finding !== null) return { finding, stoppedAt: link, walked, evidence }
  }
  throw new Error('the comparison chain ended without a finding')
}
