import type { Database } from '../db/open.ts'
import type { DataType } from '../api/catalogue.ts'
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
  now: () => number
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

/**
 * The read path for a type that answers only rollups. It steps by the per type range cap rather
 * than paginating, because these methods do not paginate: `pageSize` is a floor the request must
 * clear rather than a page size, and no response carries a `nextPageToken`.
 *
 * It marks nothing dirty. These rows are ingested rather than derived, which is the same reason
 * `runDerive` leaves `provider` rows alone: nothing local could recompute them.
 */
export async function runRollupJob(input: RollupJobInput): Promise<{ chunks: number, rowsWritten: number }> {
  const capMs = rollupRangeCapDays(input.dataType) * DAY_MS
  let chunks = 0
  let rowsWritten = 0

  // Backwards from the most recent day, so an interrupted walk has already collected the
  // history anyone is most likely to open first.
  for (let endMs = input.toMs; endMs > input.fromMs; endMs -= capMs) {
    const startMs = Math.max(input.fromMs, endMs - capMs)
    const { payloadId } = await input.deps.client.dailyRollUpDataPoints({
      personId: input.personId,
      dataType: input.dataType,
      fromLocalDate: localDate(startMs, input.timezone),
      toLocalDate: localDate(endMs, input.timezone),
    })
    chunks++

    const rows = mapRollups({
      dataType: input.dataType,
      body: input.deps.archive.getBody(input.personId, payloadId),
      personId: input.personId,
    })
    input.deps.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(daily).values(row).onConflictDoUpdate({
          target: [daily.personId, daily.localDate, daily.metric, daily.agg, daily.source],
          set: { value: row.value, coverage: row.coverage, derivationVersion: row.derivationVersion },
        }).run()
      }
    })
    rowsWritten += rows.length
  }

  return { chunks, rowsWritten }
}
