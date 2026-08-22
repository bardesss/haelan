import type { Database } from '../db/open.ts'
import type { DataType } from '../api/catalogue.ts'
import type { RateLimiter } from './runJob.ts'
import { daily } from '../db/schema/index.ts'
import { mapRollups } from '../api/mapRollups.ts'

const DAY_MS = 86_400_000

// Measured in probe/findings/rollup-methods.md. The discovery document names the same 14 day
// group: calories-in-heart-rate-zone, heart-rate, active-minutes and total-calories. Everything
// else is 90, and a request exactly at 90 succeeded, so the bound is inclusive.
const SHORT_CAP_TYPES = new Set([
  'total-calories', 'heart-rate', 'active-minutes', 'calories-in-heart-rate-zone',
])

export function rollupRangeCapDays(t: DataType): number {
  return SHORT_CAP_TYPES.has(t.id) ? 14 : 90
}

interface RollupClient {
  dailyRollUpDataPoints(input: {
    personId: string, dataType: DataType, fromLocalDate: string, toLocalDate: string,
  }): Promise<{ payloadId: string }>
}

export interface RollupJobDeps {
  db: Database
  client: RollupClient
  archive: { getBody: (personId: string, payloadId: string) => string }
  /** Narrowed to the one thing the walk records itself. SyncStateStore satisfies it. */
  syncState: {
    recordSchemaDrift: (
      input: { personId: string, dataType: string, points: number, nowMs: number, reason?: string },
    ) => void
  }
  now: () => number
  /**
   * Optional, the same interface JobDeps carries. runJob applies it to every list window; a
   * rollup chunk is a request too and must not get to skip the household's shared quota.
   */
  limiter?: RateLimiter
}

export interface RollupJobInput {
  personId: string
  dataType: DataType
  fromMs: number
  toMs: number
  timezone: string
  deps: RollupJobDeps
}

// en-CA yields ISO ordered parts, matching windows.ts's localDateOf. A rollup window has to
// land on the person's own local day, not the UTC one: two people in different zones asking
// for "the same" absolute range must get different civil dates, the same way dayWindows does
// for list jobs, or the archive's day-aligned dedup key stops meaning anything per person.
const localDate = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))

// A local date string carries no zone, so once fromMs/toMs have been converted to dates above,
// stepping the walk here is pure calendar arithmetic: parsing a date as a UTC midnight and
// adding whole days is exact, the same technique DeriveQueue.markRange's datesBetween uses. A
// day-count step in this space cannot land on a 15 civil day span the way stepping by a fixed
// count of milliseconds can when the range crosses a DST transition: instants near a spring
// forward or fall back are not evenly 86,400,000 ms of civil time apart, but dates always are.
const addCivilDays = (dateStr: string, days: number): string =>
  new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

const civilDaysBetween = (fromDate: string, toDate: string): number =>
  (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS

/**
 * The read path for a type that answers only rollups. It steps by the per type range cap rather
 * than paginating, because these methods do not paginate: `pageSize` is a floor the request must
 * clear rather than a page size, and no response carries a `nextPageToken`.
 *
 * It marks nothing dirty. These rows are ingested rather than derived, which is the same reason
 * `runDerive` leaves `provider` rows alone: nothing local could recompute them.
 */
export async function runRollupJob(
  input: RollupJobInput,
): Promise<{ chunks: number, points: number, rowsWritten: number, unreadable: number }> {
  const capDays = rollupRangeCapDays(input.dataType)
  const fromDate = localDate(input.fromMs, input.timezone)
  let chunks = 0
  let points = 0
  let rowsWritten = 0
  let unreadable = 0
  let firstUnreadable: string | null = null

  // Backwards from the most recent day, so an interrupted walk has already collected the
  // history anyone is most likely to open first.
  for (let endDate = localDate(input.toMs, input.timezone); civilDaysBetween(fromDate, endDate) > 0;) {
    const spanDays = Math.min(capDays, civilDaysBetween(fromDate, endDate))
    const startDate = addCivilDays(endDate, -spanDays)

    await input.deps.limiter?.take()
    const { payloadId } = await input.deps.client.dailyRollUpDataPoints({
      personId: input.personId,
      dataType: input.dataType,
      fromLocalDate: startDate,
      toLocalDate: endDate,
    })
    chunks++

    const mapped = mapRollups({
      dataType: input.dataType,
      body: input.deps.archive.getBody(input.personId, payloadId),
      personId: input.personId,
    })
    const rows = mapped.rows
    points += mapped.points
    if (!mapped.readable) {
      // Counted per chunk rather than folded into the point total, because points are summed
      // across the walk and one unreadable chunk among readable ones would vanish into it.
      unreadable += 1
      firstUnreadable ??= `${startDate} to ${endDate}`
    }
    input.deps.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(daily).values(row).onConflictDoUpdate({
          target: [daily.personId, daily.localDate, daily.metric, daily.agg, daily.source],
          set: { value: row.value, coverage: row.coverage, derivationVersion: row.derivationVersion },
        }).run()
      }
    })
    rowsWritten += rows.length

    endDate = startDate
  }

  // The same judgment runJob makes for a list window, and for the same reason: nothing threw,
  // the windows came back carrying points, and every one of them was skipped by a mapper that
  // could not find its field. A response with no points at all is not this case, because days
  // with no data are omitted rather than zeroed, so an empty walk is what a person with no
  // device looks like. Left unreported, a renamed value path is a permanent silent gap.
  // A body we could not read at all is the other half, and it is the half a point count cannot
  // see: zero points is what a stretch of days with no data looks like too. The caller leaves
  // the cursor where it was when this is non-zero, so the same range is asked for again once
  // somebody fixes the mapper, rather than being scrolled past and lost at this resolution.
  //
  // One record for both, in the same order runJob uses: last_error holds one string, and
  // written separately whichever ran second would erase the other.
  const drifted = [
    unreadable > 0 ? `${unreadable} of ${chunks} chunks unreadable, first ${firstUnreadable}` : null,
    points > 0 && rowsWritten === 0 ? `${points} points fetched and none mapped to a row` : null,
  ].filter((reason) => reason !== null)
  if (drifted.length > 0) {
    input.deps.syncState.recordSchemaDrift({
      personId: input.personId, dataType: input.dataType.id, points, nowMs: input.deps.now(),
      reason: drifted.join('; '),
    })
  }

  return { chunks, points, rowsWritten, unreadable }
}
