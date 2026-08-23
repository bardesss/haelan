import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily } from '../db/schema/index.ts'
import { MERGED_SOURCE } from '../derive/rollup.ts'
import { baselineOf, BASELINE_WINDOW_DAYS } from './baseline.ts'
import type { Baseline } from './baseline.ts'
// Aliased: the class has a method of the same name, and an unqualified call inside it
// resolving to the module import rather than the method is technically fine and genuinely
// confusing to read.
import { comparePeriods as comparePeriodPoints } from './insights.ts'
import type { Insight, PeriodPoint } from './insights.ts'
import { shiftLocalDate } from '../derive/localDay.ts'

export interface DailyPoint {
  localDate: string
  value: number
  /** Null where there was never a basis to measure hours: a sleep row or a provider row. */
  coverage: number | null
  source: string
  sourceMix: string | null
}

/**
 * Everything a surface asks of the store, bound to one person at construction.
 *
 * Master design section 11 requires the binding to live here rather than in the callers, because
 * a tool that forgets a WHERE clause must not be able to leak another member's data. There is
 * deliberately no unbound variant and no optional person parameter: the guarantee is that you
 * cannot express the question without saying whose data it is about.
 */
export class PersonQuery {
  readonly #db: DbOrTx

  readonly #personId: string

  constructor(db: DbOrTx, personId: string) {
    this.#db = db
    this.#personId = personId
  }

  /**
   * The daily rows for a metric over an inclusive range, oldest first.
   *
   * `source` defaults to the merged row, which is the answer to what happened rather than to
   * what one device said. Passing a source id reads that device instead, which is what keeps
   * a merge inspectable against the rows underneath it.
   */
  series(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): DailyPoint[] {
    return this.#db.select({
      localDate: daily.localDate,
      value: daily.value,
      coverage: daily.coverage,
      source: daily.source,
      sourceMix: daily.sourceMix,
    }).from(daily).where(and(
      eq(daily.personId, this.#personId),
      eq(daily.metric, input.metric),
      eq(daily.agg, input.agg),
      eq(daily.source, input.source ?? MERGED_SOURCE),
      gte(daily.localDate, input.from),
      lte(daily.localDate, input.to),
      // A row with no value is not a measurement, and letting one through would put a hole in
      // every mean computed downstream. Nothing writes one today; this is the guard for later.
      isNotNull(daily.value),
    )).orderBy(asc(daily.localDate)).all() as DailyPoint[]
  }

  /**
   * The person's own baseline for a metric as of a date.
   *
   * The window ends the day BEFORE `on`, so a reading is never part of the baseline it is
   * judged against. Including it pulls the centre toward itself and biases its own z score
   * toward zero, and the bias is largest exactly when history is shortest.
   */
  baseline(input: {
    metric: string
    agg: string
    on: string
    windowDays?: number
    source?: string
  }): Baseline | null {
    const windowDays = input.windowDays ?? BASELINE_WINDOW_DAYS
    const to = shiftLocalDate(input.on, -1)
    const from = shiftLocalDate(to, -(windowDays - 1))
    const points = this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    })
    return baselineOf(points.map((point) => point.value))
  }

  /**
   * A range against the range of equal length immediately before it. Suppression is the pure
   * function's decision; this only fetches the two periods and says how long they are.
   */
  comparePeriods(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): Insight {
    const periodDays = daysBetween(input.from, input.to)
    const previousTo = shiftLocalDate(input.from, -1)
    const previousFrom = shiftLocalDate(previousTo, -(periodDays - 1))

    const fetch = (from: string, to: string): PeriodPoint[] => this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    }).map((point) => ({
      localDate: point.localDate, value: point.value, coverage: point.coverage,
    }))

    return comparePeriodPoints({
      current: fetch(input.from, input.to),
      previous: fetch(previousFrom, previousTo),
      periodDays,
    })
  }
}

const DAY_MS = 86_400_000

/**
 * Inclusive, so a range from a date to itself is one day. Local dates carry no zone, so
 * parsing them as UTC midnights is exact and a daylight saving change never moves a date.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}
