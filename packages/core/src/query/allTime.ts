import { sql } from 'drizzle-orm'
import { eddingtonOf } from '../api/eddington.ts'
import { recordOf } from '../api/allTimeRecords.ts'
import { longestRun, MIN_RUN_DAYS } from '../api/runs.ts'
import type { DbOrTx } from '../db/open.ts'

/**
 * Everything the all-time page shows, in one read.
 *
 * M6 exists because this project argues its value is a complete mirror outliving Google's
 * retention windows, while every page it shipped rendered a window. These are the figures that
 * cannot be computed from the range on screen.
 *
 * Per CONTRIBUTING.md's rule for a reader whose output is printed as a number:
 *
 * - **Session kinds:** both, and separately. Workout counts read `exercise` and night counts read
 *   `sleep`; neither is ever summed with the other, which is the confusion that produced 65.10
 *   TRIMP for a sleeping person in #191.
 * - **Override actions:** both, and neither re-applied. `applyToDay` (derive/overrides.ts) removes
 *   an excluded metric's rows at derivation and a correction's value is already in the row, so
 *   everything read here has both applied. Filtering again would apply a rule twice, and the
 *   filter would never fire.
 * - **Thinned:** no, and it must never be. Every figure here is computed from complete rows. A
 *   record read off a downsampled series would be the largest point the downsampler happened to
 *   keep, which is a fact about a point budget rather than about a person.
 */

/**
 * The metrics an all-time record means something for.
 *
 * Deliberately not every metric in the catalogue: an all-time maximum resting heart rate is not
 * an achievement, it is a bad night.
 */
export const RECORD_METRICS = ['steps', 'distance', 'floors', 'active_energy', 'total_calories']

/**
 * The derived tiers, in the order a record should prefer them.
 *
 * Both, not merged alone, and this is the finding that decides whether the page works. Measured
 * against the household archive: `floors` and `total_calories` have **no merged row at all**,
 * 230 and 750 days of them living only under `provider`. Every other page in this app filters to
 * merged, so a records page that did the same would report two of its five metrics as absent
 * while looking perfectly healthy. Merged comes first because it is the reconciled figure;
 * provider is what one upstream said on its own.
 */
const TIERS = ['merged', 'provider'] as const
type Tier = (typeof TIERS)[number]

/** A thousand steps per unit of E. */
const EDDINGTON_UNIT = 1000

/** Cumulative step totals worth marking. */
const STEP_MILLIONS = 1_000_000

/** How often a session count is worth marking, per kind. */
const COUNT_EVERY = { exercise: 50, sleep: 100 } as const

export interface AllTimeSpan { from: string, to: string, days: number }

export interface MetricRecord {
  metric: string
  tier: Tier
  localDate: string
  value: number
  /** This metric's own first day, which is not the page's - see `eddington` for why that matters. */
  from: string
  days: number
}

export interface Milestone {
  kind: 'record' | 'count' | 'first' | 'run'
  localDate: string
  /** A metric name for `record`, a session kind for `count` and `first`. */
  metric?: string
  count?: number
  days?: number
}

export interface AllTime {
  span: AllTimeSpan
  records: MetricRecord[]
  /**
   * `from` and `days` are the STEP history's own window, not the span's.
   *
   * In the archive this was measured against the difference is eight months: the first row is
   * from 2024-08-25 and the first step row from 2026-01-21, so E rests on 235 days of 750.
   * Presenting that as an all-time figure without saying which days it covers is the failure
   * mode the M6-0 probe warned about, and this is the first feature to meet it.
   */
  eddington: { e: number, from: string, days: number } | null
  milestones: Milestone[]
}

interface DayRow { localDate: string, value: number }

export function readAllTime(db: DbOrTx, personId: string): AllTime {
  const rowsFor = (metric: string, tier: Tier): DayRow[] => db.all<DayRow>(sql`
    SELECT local_date AS localDate, value FROM daily
     WHERE person_id = ${personId} AND metric = ${metric} AND source = ${tier}
       AND agg = 'sum' AND value IS NOT NULL
     ORDER BY local_date`)

  const records: MetricRecord[] = []
  let stepDays: DayRow[] = []

  for (const metric of RECORD_METRICS) {
    // Whichever tier actually has rows, asked rather than assumed, so a household whose device
    // reports floors per source gets the merged answer without a code change here.
    let tier: Tier | undefined
    let rows: DayRow[] = []
    for (const candidate of TIERS) {
      const found = rowsFor(metric, candidate)
      if (found.length > 0) { tier = candidate; rows = found; break }
    }
    if (tier === undefined) continue

    if (metric === 'steps') stepDays = rows

    const best = recordOf(rows)
    if (best !== null) {
      records.push({
        metric, tier, localDate: best.localDate, value: best.value,
        from: rows[0]!.localDate, days: rows.length,
      })
    }
  }

  const span = db.all<{ from: string, to: string, days: number }>(sql`
    SELECT MIN(local_date) AS "from", MAX(local_date) AS "to",
           COUNT(DISTINCT local_date) AS days
      FROM daily WHERE person_id = ${personId} AND value IS NOT NULL`)[0]
    ?? { from: '', to: '', days: 0 }

  const eddington = stepDays.length === 0 ? null : {
    e: eddingtonOf(stepDays.map((day) => day.value), EDDINGTON_UNIT),
    from: stepDays[0]!.localDate,
    days: stepDays.length,
  }

  return {
    span: { from: span.from ?? '', to: span.to ?? '', days: span.days ?? 0 },
    records,
    eddington,
    milestones: milestonesOf(db, personId, records, stepDays),
  }
}

function milestonesOf(
  db: DbOrTx, personId: string, records: readonly MetricRecord[], stepDays: readonly DayRow[],
): Milestone[] {
  const milestones: Milestone[] = []

  // 1. When each standing record was set. One event per metric, NOT one per time a record was
  // beaten: day one always sets a record and day two usually beats it, which is how one metric
  // produced 70 events across 750 days in the archive. Seventy entries clustered at the start is
  // a history of the archive beginning rather than of anything the person did.
  for (const record of records) {
    milestones.push({ kind: 'record', metric: record.metric, localDate: record.localDate })
  }

  // 2. Round numbers reached, per session kind and never across them.
  for (const [kind, every] of Object.entries(COUNT_EVERY)) {
    const dates = db.all<{ localDate: string }>(sql`
      SELECT local_date AS localDate FROM sessions
       WHERE person_id = ${personId} AND kind = ${kind}
       ORDER BY start_ms`)
    for (let at = every; at <= dates.length; at += every) {
      milestones.push({ kind: 'count', metric: kind, count: at, localDate: dates[at - 1]!.localDate })
    }
    // 3. The first of each kind. Labelled "first recorded" by the page, never "first": both fall
    // on the day syncing started, so they say when the mirror began rather than anything about
    // the person.
    if (dates.length > 0) {
      milestones.push({ kind: 'first', metric: kind, localDate: dates[0]!.localDate })
    }
  }

  // Each millionth cumulative step.
  let cumulative = 0
  for (const day of stepDays) {
    const before = cumulative
    cumulative += day.value
    const crossed = Math.floor(cumulative / STEP_MILLIONS) - Math.floor(before / STEP_MILLIONS)
    for (let n = 1; n <= crossed; n += 1) {
      milestones.push({
        kind: 'count', metric: 'steps',
        count: (Math.floor(before / STEP_MILLIONS) + n) * STEP_MILLIONS,
        localDate: day.localDate,
      })
    }
  }

  // 4. The longest unbroken run of days carrying any reading, dated to the day it ended.
  const dates = db.all<{ localDate: string }>(sql`
    SELECT DISTINCT local_date AS localDate FROM daily
     WHERE person_id = ${personId} AND value IS NOT NULL`).map((row) => row.localDate)
  const run = longestRun(dates, MIN_RUN_DAYS)
  if (run !== null) milestones.push({ kind: 'run', localDate: run.to, days: run.days })

  return milestones.sort((a, b) => a.localDate.localeCompare(b.localDate))
}
