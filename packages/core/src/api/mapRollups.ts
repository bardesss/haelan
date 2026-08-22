import type { DataType } from './catalogue.ts'
import type { DailyRow } from '../derive/rollup.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'
import { PROVIDER_SOURCE } from '../derive/rollup.ts'
import { parseNumeric, valueAt } from './parse.ts'

/**
 * A `dailyRollUp` response to `daily` rows. These two types have no tier 2: there is no per
 * sample data underneath them, only a daily figure the provider already reconciled across
 * sources. Inventing sample rows to carry one number a day would make `samples` lie.
 *
 * The rows land on `provider` rather than `merged`. We did not compute the merge and cannot
 * inspect it against per source data, and filing them as `merged` would make section 9's
 * promise false for exactly two metrics without saying so.
 */
export function mapRollups(input: { dataType: DataType, body: string, personId: string }): DailyRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []

  const points = (parsed as { rollupDataPoints?: unknown }).rollupDataPoints
  if (!Array.isArray(points)) return []

  const rows: DailyRow[] = []
  for (const point of points) {
    const date = valueAt(point, 'civilStartTime.date')
    const localDate = civilDate(date)
    if (localDate === null) continue

    const payload = valueAt(point, input.dataType.payloadKey)
    if (payload === undefined) continue
    // parseNumeric handles the int64-as-string case: floors.countSum arrives quoted.
    const value = parseNumeric(valueAt(payload, input.dataType.valuePath))
    if (value === null) continue

    rows.push({
      personId: input.personId,
      localDate,
      metric: input.dataType.metric,
      agg: 'sum',
      source: PROVIDER_SOURCE,
      value,
      // No samples underneath, so no basis to measure coverage. Not 1.0, which would read to
      // M2d's suppression as a fully observed day.
      coverage: null,
      derivationVersion: DERIVATION_VERSION,
    })
  }
  return rows
}

const pad = (n: number) => String(n).padStart(2, '0')

function civilDate(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { year, month, day } = value as { year?: unknown, month?: unknown, day?: unknown }
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null
  return `${year}-${pad(month)}-${pad(day)}`
}
