import { and, asc, eq, gt, max, or } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'

/** A day and a metric whose derived rows moved. Nothing about which source, on purpose: see readChanges. */
export interface ChangedPair {
  localDate: string
  metric: string
}

export interface ChangesResult {
  items: ChangedPair[]
  cursor: string | null
}

/**
 * The (localDate, metric) pairs whose derived rows carry an updated_at_ms greater than `since`,
 * for one person.
 *
 * Distinct pairs, not one row per derived row: a day whose steps moved has a row per aggregate
 * and per source, merged and provider alike, and a client asking what changed wants the day and
 * the metric, once. The reduction happens as a GROUP BY rather than in a Map, and the paging as a
 * keyset predicate rather than a fetch-then-slice, because this route exists to be polled: the
 * per-call cost is paid over and over, and after a rebuild "the whole result set" is a person's
 * entire history, which a fetch-everything reducer would re-load and re-reduce on every page.
 * daily_person_updated already serves the WHERE filter; the same index serves this GROUP BY and
 * ORDER BY, since both walk personId then updatedAtMs.
 *
 * A rebuild stamps a person's entire history with one clock reading, so the first poll after a
 * version bump legitimately reports everything: that is this reader answering correctly, not a
 * bug to filter down. Provider rows carry the same column, stamped at their own insert site, so a
 * rollup figure the API reconciled and later corrected shows up here too, with no samples under it.
 *
 * Ordered by the stamp, then by local date, then by metric, which is what makes the cursor below
 * well defined: the pagination walks exactly that order and nothing else decides it.
 */
export function readChanges(db: DbOrTx, input: {
  personId: string
  since: number
  limit?: number
  cursor?: string
}): ChangesResult {
  const cursorKey = input.cursor === undefined ? undefined : decodeCursor(input.cursor)
  if (cursorKey !== undefined && !cursorPairExists(db, input.personId, input.since, cursorKey)) {
    throw new ConfigError('cursor does not match any row in range')
  }

  // Referenced in the select list, the having continuation and the order by: one aggregate
  // expression standing for "the pair's stamp" everywhere it is used, so the continuation
  // predicate below compares against the same grouped maximum the ordering sorts by, rather than
  // against any one row that fed it.
  const stamp = max(daily.updatedAtMs)

  let query = db.select({
    localDate: daily.localDate,
    metric: daily.metric,
    stamp,
  }).from(daily).where(and(
    eq(daily.personId, input.personId),
    // gt() against a null column never matches in SQLite, so a row a rebuild has not reached
    // yet is excluded without a separate isNotNull check.
    gt(daily.updatedAtMs, input.since),
  )).groupBy(daily.localDate, daily.metric)
    // A tuple comparison expressed as an OR of its three prefixes, since the predicate has to
    // apply to the grouped maximum rather than to a raw row: stamp strictly after the cursor's,
    // or the same stamp and a later local date, or the same stamp and date and a later metric.
    .having(cursorKey === undefined ? undefined : or(
      gt(max(daily.updatedAtMs), cursorKey.stamp),
      and(eq(max(daily.updatedAtMs), cursorKey.stamp), gt(daily.localDate, cursorKey.localDate)),
      and(
        eq(max(daily.updatedAtMs), cursorKey.stamp),
        eq(daily.localDate, cursorKey.localDate),
        gt(daily.metric, cursorKey.metric),
      ),
    ))
    .orderBy(asc(stamp), asc(daily.localDate), asc(daily.metric))
    .$dynamic()

  // One row past the limit, so "is there a next page" is answered by this query rather than a
  // second one, or by loading everything just to find out: the shape this fix removes.
  if (input.limit !== undefined) query = query.limit(input.limit + 1)

  const rows = query.all() as { localDate: string, metric: string, stamp: number }[]

  const hasMore = input.limit !== undefined && rows.length > input.limit
  const page = hasMore ? rows.slice(0, input.limit) : rows
  const last = page.at(-1)
  const cursor = hasMore && last !== undefined
    ? encodeCursor({ stamp: last.stamp, localDate: last.localDate, metric: last.metric })
    : null

  return {
    items: page.map(({ localDate, metric }) => ({ localDate, metric })),
    cursor,
  }
}

interface CursorKey { stamp: number, localDate: string, metric: string }

/**
 * Whether the cursor's own pair is really in range, under the same personId and since filter the
 * main query uses. A keyset predicate alone only says what comes after a point; it has no opinion
 * on whether that point ever existed, and a cursor built from a different since or a stale run
 * must fail loudly rather than silently become "everything" or "nothing". One indexed lookup by
 * (personId, metric, localDate), not a scan: daily_person_metric_date covers it.
 */
function cursorPairExists(db: DbOrTx, personId: string, since: number, key: CursorKey): boolean {
  const rows = db.select({ stamp: max(daily.updatedAtMs) }).from(daily).where(and(
    eq(daily.personId, personId),
    gt(daily.updatedAtMs, since),
    eq(daily.localDate, key.localDate),
    eq(daily.metric, key.metric),
  )).groupBy(daily.localDate, daily.metric).all()

  return rows.length === 1 && rows[0]?.stamp === key.stamp
}

/**
 * Opaque to the caller: a base64url encoding of the pair's place in the total order above, never
 * an offset. A pair inserted ahead of the cursor between two calls cannot shift a position based
 * page, since this names the row itself rather than an index into a list that can move under it.
 */
function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/**
 * The cursor arrives from a query string, so it is caller controlled and its parsed shape has to
 * be checked rather than asserted. A bare `as CursorKey` accepted the literal `null`, which parses
 * fine and then dereferenced one frame later as a 500 with a stack trace on the one route the
 * surface exists to have polled. Every field is checked, not only the wrapper, since a well
 * shaped object carrying a string stamp would reach the keyset predicate and compare wrongly
 * rather than fail.
 */
function decodeCursor(raw: string): CursorKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ConfigError(`cursor is not valid, got '${raw}'`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError(`cursor is not valid, got '${raw}'`)
  }
  const key = parsed as Partial<Record<keyof CursorKey, unknown>>
  if (
    typeof key.stamp !== 'number' || !Number.isFinite(key.stamp)
    || typeof key.localDate !== 'string'
    || typeof key.metric !== 'string'
  ) {
    throw new ConfigError(`cursor is not valid, got '${raw}'`)
  }
  return { stamp: key.stamp, localDate: key.localDate, metric: key.metric }
}
