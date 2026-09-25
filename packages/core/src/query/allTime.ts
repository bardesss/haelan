import { sql } from 'drizzle-orm'
import { eddingtonOf } from '../api/eddington.ts'
import { recordOf } from '../api/allTimeRecords.ts'
import { longestRun, MIN_RUN_DAYS } from '../api/runs.ts'
import { sessionRecordsOf } from '../api/sessionRecords.ts'
import type { SessionForRecords, SessionRecord } from '../api/sessionRecords.ts'
import { namedSourcesOf } from '../store/sourceAliases.ts'
import type { NamedSource } from '../store/sourceAliases.ts'
import type { DefaultName } from '../api/sourceNames.ts'
import { parseSessionTarget } from '../derive/targetKey.ts'
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
 * - **Override actions:** both, and the two tables this reads need opposite treatment - which is
 *   the distinction an earlier version of this header got wrong by stating only the first half.
 *
 *   For `daily`, nothing is re-applied: `deriveDay` deletes an excluded metric's rows for the
 *   day, across every source including `provider` (its second delete, the one the first spares),
 *   and a correction's value is already in the row. Filtering again would apply a rule twice.
 *
 *   For `sessions`, this reader must filter, because `sessions` is the INGESTED table and
 *   nothing deletes from it: `sleepNights` and `deriveDay` both drop excluded sessions at read
 *   through `applyToSessions`, and `query/sessions.ts` marks rather than filters on purpose.
 *   Counting raw rows credited somebody a 50th workout they had thrown out, and could name an
 *   excluded session as their first ever.
 * - **Thinned:** no, and it must never be. Every figure here is computed from complete rows. A
 *   record read off a downsampled series would be the largest point the downsampler happened to
 *   keep, which is a fact about a point budget rather than about a person.
 *
 * **Measured, because this milestone's own rule is to measure rather than assume.** Against the
 * real household archive - 29,676 daily rows, 440 sessions - one call costs 12-29ms: up to ten
 * `daily` reads, two `sessions` reads and one `DISTINCT local_date` scan. That is the same order
 * as M6a's 23ms and it is paid once per visit to one page, not on every page like the read M6a
 * had to move off the hot path. Nothing is cached beyond the route's ETag. If this ever measures
 * slow, the next move is an index rather than a stored column: nothing here writes.
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
 * 230 and 750 days of them living only under `provider`. A reader that asked only for merged
 * rows would report two of its five metrics as absent while looking perfectly healthy.
 *
 * `PersonQuery.series` already accepts either tier, so the fallback is not novel - an earlier
 * version of this comment claimed every other page filters to merged, which is wrong and would
 * have sent the next reader looking for a problem that is not there. What IS particular here is
 * choosing per metric rather than per row: see the note on that below.
 */
const TIERS = ['merged', 'provider'] as const
type Tier = (typeof TIERS)[number]

/** A thousand steps per unit of E. */
const EDDINGTON_UNIT = 1000

/** Cumulative step totals worth marking. */
const STEP_MILLIONS = 1_000_000

/**
 * How often a session count is worth marking, per kind.
 *
 * Different numbers because the two accumulate at different rates: a household records a night
 * most nights and a workout some days, so one threshold would either bury the timeline in nights
 * or never reach a workout. Measured against the real archive to pick them - 201 workouts and 239
 * nights over the same span - which yields four workout marks and two night marks rather than
 * fifteen of one and one of the other. Proposals, not derived truths, and named here so the next
 * person argues with a number.
 */
const COUNT_EVERY = { exercise: 50, sleep: 100 } as const

export interface AllTimeSpan { from: string, to: string, days: number }

export interface MetricRecord {
  metric: string
  tier: Tier
  localDate: string
  value: number
  /**
   * What the person calls the source that recorded the record day, or null.
   *
   * Null is common and honest rather than a failure: a `provider` row carries no `sourceMix` at
   * all (rollup.ts writes it null), so the two provider-tier metrics can never be attributed,
   * and a merged day assembled from several devices is not one device's record.
   */
  sourceName: string | null
  /**
   * The known-app default `sourceName` was built from, for the web to say in the reader's
   * language, or null - always null beside a null `sourceName`, and null when the person renamed
   * the source or it is not a known app. See NamedSource.defaultName.
   */
  sourceDefaultName: DefaultName | null
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
   * The records a SESSION holds rather than a day: longest, furthest, fastest kilometre.
   *
   * A separate list because they are a different kind of claim - one read off `sessions` and its
   * payload attributes, one off `daily` - and because a household may support some and not
   * others. Only the records the sessions actually support appear.
   */
  sessionRecords: SessionRecord[]
  /**
   * `from` and `days` are the STEP history's own window, not the span's.
   *
   * In the archive this was measured against the difference is eight months: the first row is
   * from 2024-08-25 and the first step row from 2026-01-21, so E rests on 235 days of 750.
   * Presenting that as an all-time figure without saying which days it covers is the failure
   * mode the M6-0 probe warned about, and this is the first feature to meet it.
   *
   * That horizon is a fact about the data rather than a gap in derivation, checked rather than
   * assumed: the archive holds 457 step payloads reaching back to 2025-08-25, and the 149 dated
   * before 2026-01-21 are empty - median body three bytes, every one HTTP 200. Google was asked
   * and had nothing. So the window is the honest answer here, not a label over a bug.
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
  // Read once, and only when a record day turns out to have one source: most do not, and the
  // list is the same for every metric.
  let named: Map<string, NamedSource> | undefined
  const namedById = (): Map<string, NamedSource> =>
    (named ??= new Map(namedSourcesOf(db, personId).map((source) => [source.id, source])))

  for (const metric of RECORD_METRICS) {
    // Whichever tier actually has rows, asked rather than assumed, so a household whose device
    // reports floors per source gets the merged answer without a code change here.
    //
    // **Chosen once for the metric's whole history, which is deliberately not what
    // `preferMerged` (personQuery.ts) does per row.** That function's own comment warns that "a
    // metric can gain a merged row partway through its history", and mixing the two tiers row by
    // row is right for a series: each day shows the best answer available for that day. A record
    // is one day compared against every other, so mixing would compare a reconciled figure
    // against an unreconciled one and call the larger a personal best. The cost is the case that
    // comment names: one stray merged row makes this read the merged tier alone and ignore a
    // longer provider history. Accepted, because a wrong record is worse than a short one, and
    // the record's own `from`/`days` say which history it was drawn from.
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
      const sole = soleSourceOn(db, personId, metric, best.localDate, namedById)
      records.push({
        metric, tier, localDate: best.localDate, value: best.value,
        from: rows[0]!.localDate, days: rows.length,
        sourceName: sole?.name ?? null,
        // Null beside an alias, for the reason the status route gives: a record carries no alias
        // for the web to check first.
        sourceDefaultName: sole !== null && sole.alias === null ? sole.defaultName : null,
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

  const excludedSessions = excludedSessionIds(db, personId)

  return {
    span: { from: span.from ?? '', to: span.to ?? '', days: span.days ?? 0 },
    records,
    sessionRecords: sessionRecordsOf(sessionsForRecords(db, personId, excludedSessions)),
    eddington,
    milestones: milestonesOf(db, personId, records, stepDays, excludedSessions),
  }
}

/**
 * The name of the one source behind a record day, or null when that question has no answer.
 *
 * Null rather than a guess in three real cases: a provider row carries no mix at all, a merged
 * day assembled from two devices belongs to neither, and a source may have no row in `sources`.
 * The name is namedSourcesOf's, the same one every other surface resolves a source name through,
 * so a household that renamed its watch sees that name here too, and a known app reads the same
 * default here as it does in the status panel.
 */
function soleSourceOn(
  db: DbOrTx, personId: string, metric: string, localDate: string,
  namedById: () => ReadonlyMap<string, NamedSource>,
): NamedSource | null {
  const row = db.all<{ sourceMix: string | null }>(sql`
    SELECT source_mix AS sourceMix FROM daily
     WHERE person_id = ${personId} AND metric = ${metric} AND local_date = ${localDate}
       AND source = 'merged' AND agg = 'sum'`)[0]
  if (!row?.sourceMix) return null

  let mix: unknown
  try { mix = JSON.parse(row.sourceMix) } catch { return null }
  if (!Array.isArray(mix) || mix.length !== 1) return null

  const sourceId = (mix[0] as { source?: unknown }).source
  if (typeof sourceId !== 'string') return null

  return namedById().get(sourceId) ?? null
}

/**
 * Records per SOURCE were specified, measured and rejected on 2026-09-16; this note is here
 * because it is where the next person will come looking to add them.
 *
 * For steps the archive has four sources: 48,030 over 207 days, then 14,661, 13,963 and 8,424
 * over 29, 94 and 9 days. The top row is the record already on the page and the rest are
 * short-lived devices that never stood a chance, so the table is one real row and three that
 * read as failures. Worse, `floors` and `total_calories` have no per-source rows at all - they
 * are provider-only - so two of the five metrics would render empty.
 *
 * What the data does support is attribution, which is what `soleSourceOn` above does: naming the
 * one device behind a record day. If a household ever genuinely wants to compare two watches,
 * that is the request to design against, and it is not this.
 */

/** Session-scope exclusions, read once and shared by the milestones and the session records. */
function excludedSessionIds(db: DbOrTx, personId: string): Set<string> {
  return new Set(
    db.all<{ targetKey: string }>(sql`
      SELECT target_key AS targetKey FROM overrides
       WHERE person_id = ${personId} AND scope = 'session' AND action = 'exclude'`)
      .map((row) => parseSessionTarget(row.targetKey)),
  )
}

/**
 * Exercise sessions in the shape `sessionRecordsOf` needs, with the payload parsing kept here.
 *
 * `attrs` is JSON this process wrote but a mapper's shape rather than a schema, so every read
 * below is defensive: a session with no metricsSummary, no splits, or a split that is not a
 * kilometre is ordinary rather than broken.
 */
function sessionsForRecords(
  db: DbOrTx, personId: string, excluded: ReadonlySet<string>,
): SessionForRecords[] {
  const rows = db.all<{ id: string, localDate: string, startMs: number, endMs: number, attrs: string }>(sql`
    SELECT id, local_date AS localDate, start_ms AS startMs, end_ms AS endMs, attrs
      FROM sessions
     WHERE person_id = ${personId} AND kind = 'exercise'
     ORDER BY start_ms`)

  const out: SessionForRecords[] = []
  for (const row of rows) {
    if (excluded.has(row.id)) continue

    let attrs: Record<string, unknown> = {}
    try { attrs = JSON.parse(row.attrs) as Record<string, unknown> } catch { attrs = {} }

    const summary = attrs['metricsSummary'] as { distanceMillimeters?: unknown } | undefined
    const distance = typeof summary?.distanceMillimeters === 'number' && summary.distanceMillimeters > 0
      ? summary.distanceMillimeters
      : null

    // Exactly one kilometre, so every candidate is the same distance: a 400m lap would win a
    // "fastest split" every time by being shorter rather than quicker.
    const kilometreSeconds: number[] = []
    for (const split of (attrs['splits'] as unknown[] | undefined) ?? []) {
      const s = split as { splitType?: unknown, activeDuration?: unknown, metricsSummary?: { distanceMillimeters?: unknown } }
      if (s.splitType !== 'DISTANCE') continue
      if (s.metricsSummary?.distanceMillimeters !== 1_000_000) continue
      const seconds = Number.parseFloat(String(s.activeDuration ?? '').replace(/s$/, ''))
      if (Number.isFinite(seconds) && seconds > 0) kilometreSeconds.push(seconds)
    }

    out.push({
      sessionId: row.id,
      localDate: row.localDate,
      exerciseType: typeof attrs['exerciseType'] === 'string' ? attrs['exerciseType'] : null,
      durationMs: row.endMs - row.startMs,
      distanceMm: distance,
      kilometreSeconds,
    })
  }
  return out
}

function milestonesOf(
  db: DbOrTx, personId: string, records: readonly MetricRecord[], stepDays: readonly DayRow[],
  excludedSessions: ReadonlySet<string>,
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
    const dates = db.all<{ id: string, localDate: string }>(sql`
      SELECT id, local_date AS localDate FROM sessions
       WHERE person_id = ${personId} AND kind = ${kind}
       ORDER BY start_ms`)
      .filter((row) => !excludedSessions.has(row.id))
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

  // 4. The longest unbroken run of WORN days, dated to the day it ended.
  //
  // Over the step history, not over every row this person has, and the difference is the whole
  // milestone. Measured against the real archive: a run over any row at all answers 751 days and
  // a run over merged rows answers 732, because the provider tier files a total_calories row on
  // every single day of the span whether anybody moved or not. Both numbers are the length of
  // the archive wearing a habit's clothes. The step history answers 159, because steps exist
  // when somebody carried the device, which is the question this milestone is asking: is the
  // mirror complete, not did a server reply.
  //
  // The same rows the Eddington number reads, so the two agree about which days count.
  const run = longestRun(stepDays.map((day) => day.localDate), MIN_RUN_DAYS)
  if (run !== null) milestones.push({ kind: 'run', localDate: run.to, days: run.days })

  return milestones.sort((a, b) => a.localDate.localeCompare(b.localDate))
}
