import type { DataType } from './catalogue.ts'
import type { SampleAgg } from '../db/schema/derived.ts'
import { parseInstant, parseCivilDate, parseNumeric, valueAt } from './parse.ts'
import { downsampleToMinute } from './downsample.ts'

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
  resolveSource: (dataSource: unknown) => string
  rawPayloadId: string
}

export function mapSamples(input: MapSamplesInput): SampleRow[] {
  const t = input.dataType
  if (t.target !== 'samples') throw new Error(`${t.id} is not a sample type`)

  // Deferred types are fetched and archived but carry a sub-dimension a flat sample row cannot
  // hold. M2 derives them from tier 1, so mapping them here would silently drop all but one
  // point per interval.
  if (t.mappingDeferred) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch {
    return []
  }

  // JSON.parse accepts "null", "42", and other scalars without throwing, so the type still
  // needs checking before anything reaches into it for dataPoints.
  if (typeof parsed !== 'object' || parsed === null) return []

  const dataPoints = (parsed as { dataPoints?: unknown }).dataPoints
  // A drifted payload might carry dataPoints as a number or a cursor-keyed object rather than
  // an array. Iterating that throws "not iterable"; treating it as no data does not.
  const points = Array.isArray(dataPoints) ? dataPoints : []

  const rows: SampleRow[] = []
  for (const point of points) {
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
      // This 0 is an absence of offset, not an observed one: daily types carry no zone at all,
      // the source's own local clock already resolved which day this is, and the pair
      // reconstructs the reported calendar date exactly. It is not comparable to the measured
      // offsets on sample-time rows in this same column.
      tzOffsetMinutes = 0
    } else {
      continue
    }

    // Per point, not once per call: a single payload carries more than one platform, and spec
    // invariant 4 requires every row to keep its own source.
    const sourceId = input.resolveSource(valueAt(point, 'dataSource'))

    rows.push({
      personId: input.personId,
      sourceId,
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

export interface MapWindowSamplesInput {
  dataType: DataType
  personId: string
  resolveSource: (dataSource: unknown) => string
  pages: { body: string, rawPayloadId: string }[]
}

// A minute can straddle a page boundary. Downsampling inside mapSamples only ever sees one
// page, so a split minute would produce two aggregates under the one natural key that has no
// room to tell them apart. Mapping every page first and downsampling once over the union keeps
// the key one aggregate per minute regardless of how the window was paginated.
export function mapWindowSamples(input: MapWindowSamplesInput): SampleRow[] {
  const t = input.dataType
  const rows = input.pages.flatMap((page) => mapSamples({
    dataType: t,
    body: page.body,
    personId: input.personId,
    resolveSource: input.resolveSource,
    rawPayloadId: page.rawPayloadId,
  }))
  return t.downsampleToMinute ? downsampleToMinute(rows) : rows
}
