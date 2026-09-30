import { z } from 'zod'
import { localDateOf, shiftLocalDate, SLEEP_METRICS } from '@haelan/core'
import type { Baseline, DailyPoint, PersonQuery } from '@haelan/core'

/**
 * `explain`'s `empty` chain: why a metric has no reading on a day. See explain.ts for the tool.
 *
 * Gates come first. `thinBaseline` and `present` stop the walk when there is a reading after all,
 * so no later link is ever asked to explain an absence that is not one. The rest are ordered
 * cheapest and most certain first: a hand exclusion is a fact about the day, a night filed under
 * the next morning is a fact about the question, and "nothing reported it that day" is the least
 * specific account there is, so it is last and always stops.
 */

export const EMPTY_LINKS = [
  'thinBaseline', 'present', 'dayMetricExcluded', 'sessionExcluded', 'nightFiledUnderMorning',
  'otherSource', 'neverReported', 'beforeFirstReport', 'afterLastReport', 'nothingThatDay',
  'notReportedThatDay',
] as const

export type EmptyLink = typeof EMPTY_LINKS[number]

// Far enough either side of any real date that "every reading before" and "every reading after"
// need no second bound of their own. requireDate accepts both.
const EARLIEST = '0001-01-01'
const LATEST = '9999-12-31'

const DERIVED = new Set(['merged', 'provider'])

// Flat and nullable for the reason recovery.ts gives: TOOLS.md's generator documents a plain
// object's fields and renders a union as an opaque type. A field a link did not reach is null,
// so what the walk looked at is readable off the answer as well as off `walked`.
export const EMPTY_EVIDENCE = z.object({
  metric: z.string(),
  agg: z.string(),
  localDate: z.string(),
  source: z.string().nullable().describe('The `source` asked for, or null for the day itself.'),
  value: z.number().nullable(),
  coverage: z.number().nullable(),
  filled: z.boolean().nullable().describe(
    'True when this reading is the day\'s intraday average standing in for the daily name, not the '
    + 'device\'s own daily summary. Say so in words; do not state it as a measurement.',
  ),
  baseline: z.object({
    center: z.number(), spread: z.number(), n: z.number(), thin: z.boolean(),
  }).nullable().describe(
    'The reading\'s own baseline, the days before `localDate`. Only read when there was a reading. '
    + 'Thin is low confidence, not evidence of nothing.',
  ),
  excludedMetrics: z.array(z.string()).nullable().describe('Every metric excluded by hand on `localDate`.'),
  excludedSleepSessions: z.array(z.string()).nullable().describe(
    'Sleep sessions filed under `localDate` that were excluded by hand and would otherwise have '
    + 'been part of its night. An excluded nap is not listed.',
  ),
  nightFiledUnder: z.string().nullable().describe(
    'The morning a night that began on the evening of `localDate` is filed under.',
  ),
  daySource: z.string().nullable().describe(
    'Who answered the day when the `source` asked for did not: `merged` or `provider`.',
  ),
  lastReportedBefore: z.string().nullable(),
  firstReportedAfter: z.string().nullable(),
  dayHasOtherData: z.boolean().nullable().describe(
    'Whether any of the day\'s headline readings (steps, sleep, resting heart rate, HRV, active '
    + 'minutes, heart rate) arrived on `localDate`.',
  ),
})

type Evidence = z.infer<typeof EMPTY_EVIDENCE>

export interface EmptyArgs { metric: string, agg: string, localDate: string, source: string | undefined }

/**
 * Every read the chain can make, each at most once. A link that is never walked never reads, so
 * its evidence stays null and its cost is never paid.
 */
class EmptyContext {
  readonly q: PersonQuery
  readonly args: EmptyArgs
  readonly evidence: Evidence
  #reading: DailyPoint | null | undefined
  #baseline: Baseline | null | undefined
  #before: DailyPoint | null | undefined
  #after: DailyPoint | null | undefined

  constructor(q: PersonQuery, args: EmptyArgs) {
    this.q = q
    this.args = args
    this.evidence = {
      metric: args.metric, agg: args.agg, localDate: args.localDate, source: args.source ?? null,
      value: null, coverage: null, filled: null, baseline: null, excludedMetrics: null,
      excludedSleepSessions: null, nightFiledUnder: null, daySource: null,
      lastReportedBefore: null, firstReportedAfter: null, dayHasOtherData: null,
    }
  }

  get isSleep(): boolean {
    return (SLEEP_METRICS as readonly string[]).includes(this.args.metric)
  }

  // A device id, or undefined: the session readers take no `merged` or `provider`.
  get deviceSource(): string | undefined {
    return this.args.source !== undefined && !DERIVED.has(this.args.source) ? this.args.source : undefined
  }

  reading(): DailyPoint | null {
    if (this.#reading === undefined) {
      const { metric, agg, localDate, source } = this.args
      this.#reading = this.q.series({ metric, agg, from: localDate, to: localDate, source }).points[0] ?? null
      this.evidence.value = this.#reading?.value ?? null
      this.evidence.coverage = this.#reading?.coverage ?? null
      this.evidence.filled = this.#reading?.filled ?? null
    }
    return this.#reading
  }

  baseline(): Baseline | null {
    if (this.#baseline === undefined) {
      const { metric, agg, localDate, source } = this.args
      this.#baseline = this.q.baseline({ metric, agg, on: localDate, source })
      this.evidence.baseline = this.#baseline
    }
    return this.#baseline
  }

  lastBefore(): DailyPoint | null {
    if (this.#before === undefined) {
      const { metric, agg, localDate, source } = this.args
      this.#before = this.q.series({ metric, agg, from: EARLIEST, to: shiftLocalDate(localDate, -1), source }).points.at(-1) ?? null
      this.evidence.lastReportedBefore = this.#before?.localDate ?? null
    }
    return this.#before
  }

  firstAfter(): DailyPoint | null {
    if (this.#after === undefined) {
      const { metric, agg, localDate, source } = this.args
      this.#after = this.q.series({ metric, agg, from: shiftLocalDate(localDate, 1), to: LATEST, source }).points[0] ?? null
      this.evidence.firstReportedAfter = this.#after?.localDate ?? null
    }
    return this.#after
  }
}

/** A sentence when the link accounts for the reading, null to walk on. */
type Link = (c: EmptyContext) => string | null

// The sentences use only values this app generated - metric names, dates, and the two derived
// source names - never a source's display name, which is free text a device or a person chose.
const filledClause = (c: EmptyContext): string =>
  c.evidence.filled === true ? ' That reading is filled from the day\'s intraday average, not measured.' : ''

const sourceClause = (c: EmptyContext): string =>
  c.args.source === undefined ? '' : ` from ${c.args.source}`

const LINKS: Record<EmptyLink, Link> = {
  thinBaseline: (c) => {
    if (c.reading() === null) return null
    const baseline = c.baseline()
    if (baseline !== null && !baseline.thin) return null
    const n = baseline?.n ?? 0
    return `${c.args.metric} has a reading on ${c.args.localDate}, but only ${n} earlier `
      + `${n === 1 ? 'day stands' : 'days stand'} behind its usual, so no standing against it is `
      + `claimed. A thin baseline is low confidence, not evidence of nothing.${filledClause(c)}`
  },
  present: (c) => {
    if (c.reading() === null) return null
    return `${c.args.metric} is not absent on ${c.args.localDate}: there is a reading.${filledClause(c)}`
  },
  dayMetricExcluded: (c) => {
    const excluded = c.q.excludedDayMetrics({ localDate: c.args.localDate })
    c.evidence.excludedMetrics = excluded
    if (!excluded.includes(c.args.metric)) return null
    return `${c.args.metric} on ${c.args.localDate} was excluded by hand, so no reading was kept for that day.`
  },
  sessionExcluded: (c) => {
    if (!c.isSleep) return null
    // Only the excluded sessions that would have been the night: an excluded nap on a date whose
    // night was never recorded is not why that night is missing.
    const excluded = c.q.excludedNightSessions({ localDate: c.args.localDate, sourceId: c.deviceSource })
    c.evidence.excludedSleepSessions = excluded
    if (excluded.length === 0) return null
    return `A sleep session filed under ${c.args.localDate} was excluded by hand, so the night `
      + `${c.args.metric} is read from was not counted.`
  },
  nightFiledUnderMorning: (c) => {
    if (!c.isSleep) return null
    const morning = shiftLocalDate(c.args.localDate, 1)
    const night = c.q.sleepNights({ from: morning, to: morning, sourceId: c.deviceSource })
      .find((n) => localDateOf(n.startMs, n.startOffsetMinutes) === c.args.localDate)
    if (night === undefined) return null
    c.evidence.nightFiledUnder = morning
    return `No night is filed under ${c.args.localDate}. The night that began on the evening of `
      + `${c.args.localDate} is filed under ${morning}, the morning it ended on.`
  },
  otherSource: (c) => {
    if (c.args.source === undefined) return null
    const { metric, agg, localDate } = c.args
    const day = c.q.series({ metric, agg, from: localDate, to: localDate }).points[0]
    if (day === undefined) return null
    c.evidence.daySource = day.source
    return `${c.args.source} has no ${metric} reading on ${localDate}, but the day does, `
      + `reconciled as ${day.source}.`
  },
  neverReported: (c) => {
    if (c.lastBefore() !== null || c.firstAfter() !== null) return null
    return `Nothing has reported ${c.args.metric} for this person${sourceClause(c)}, on any day.`
  },
  beforeFirstReport: (c) => {
    if (c.lastBefore() !== null) return null
    return `${c.args.localDate} is before the first ${c.args.metric} reading${sourceClause(c)}, on ${c.firstAfter()!.localDate}.`
  },
  afterLastReport: (c) => {
    if (c.firstAfter() !== null) return null
    return `Nothing has reported ${c.args.metric}${sourceClause(c)} since ${c.lastBefore()!.localDate}.`
  },
  nothingThatDay: (c) => {
    const other = c.q.daysWithData({ from: c.args.localDate, to: c.args.localDate }).length > 0
    c.evidence.dayHasOtherData = other
    if (other) return null
    return `None of the day's headline readings arrived on ${c.args.localDate}, so ${c.args.metric} `
      + 'is missing with the rest of that day rather than on its own.'
  },
  notReportedThatDay: (c) =>
    `Other readings arrived on ${c.args.localDate}, but no ${c.args.metric} reading${sourceClause(c)} `
    + 'did. The source did not report it that day.',
}

export function walkEmpty(q: PersonQuery, args: EmptyArgs): {
  finding: string, stoppedAt: EmptyLink, walked: EmptyLink[], evidence: Evidence
} {
  const c = new EmptyContext(q, args)
  const walked: EmptyLink[] = []
  for (const link of EMPTY_LINKS) {
    walked.push(link)
    const finding = LINKS[link](c)
    if (finding !== null) return { finding, stoppedAt: link, walked, evidence: c.evidence }
  }
  // notReportedThatDay always answers, so the loop never falls through.
  throw new Error('the empty chain ended without a finding')
}
