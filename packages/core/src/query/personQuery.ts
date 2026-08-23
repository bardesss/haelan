import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily } from '../db/schema/index.ts'
import { MERGED_SOURCE } from '../derive/rollup.ts'

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
}
