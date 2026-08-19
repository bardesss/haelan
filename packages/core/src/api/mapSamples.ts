import type { DataType } from './catalogue.ts'
import type { SampleAgg } from '../db/schema/derived.ts'
import { parseInstant, parseCivilDate, parseNumeric, valueAt } from './parse.ts'

export interface SampleRow {
  personId: string
  sourceId: string
  metric: string
  utcMs: number
  tzOffsetMinutes: number
  agg: SampleAgg
  value: number | null
  n: number
  rawPayloadId: string
}

export interface MapSamplesInput {
  dataType: DataType
  body: string
  personId: string
  sourceId: string
  rawPayloadId: string
}

export function mapSamples(input: MapSamplesInput): SampleRow[] {
  const t = input.dataType
  if (t.target !== 'samples') throw new Error(`${t.id} is not a sample type`)

  // Deferred types are fetched and archived but carry a sub-dimension a flat sample row cannot
  // hold. M2 derives them from tier 1, so mapping them here would silently drop all but one
  // point per interval.
  if (t.mappingDeferred) return []

  let parsed: { dataPoints?: unknown[] }
  try {
    parsed = JSON.parse(input.body) as { dataPoints?: unknown[] }
  } catch {
    return []
  }

  const rows: SampleRow[] = []
  for (const point of parsed.dataPoints ?? []) {
    const payload = valueAt(point, t.payloadKey)
    if (payload === undefined) continue

    const value = parseNumeric(valueAt(payload, t.valuePath))
    // A point with no value is a point the device did not record. Writing a zero here is the
    // single easiest way to turn a gap into a fabricated measurement. Spec invariant 2.
    if (value === null) continue

    const instant = parseInstant(valueAt(payload, 'sampleTime'))
      ?? parseInstant(valueAt(payload, 'interval'))
    const civil = parseCivilDate(valueAt(payload, 'date'))

    let utcMs: number
    let tzOffsetMinutes: number
    if (instant) {
      utcMs = instant.utcMs
      tzOffsetMinutes = instant.tzOffsetMinutes
    } else if (civil) {
      utcMs = Date.parse(`${civil}T00:00:00Z`)
      tzOffsetMinutes = 0
    } else {
      continue
    }

    rows.push({
      personId: input.personId,
      sourceId: input.sourceId,
      metric: t.metric,
      utcMs,
      tzOffsetMinutes,
      agg: t.agg,
      value,
      n: 1,
      rawPayloadId: input.rawPayloadId,
    })
  }

  return rows
}
