import type { DataType } from './catalogue.ts'
import type { SampleAgg } from '../db/schema/derived.ts'
import { parseInstant, parseCivilDate, parseNumeric, parseIntervalMinutes, valueAt } from './parse.ts'
import { downsampleToMinute } from './downsample.ts'
import { ConfigError } from '../errors.ts'

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
  // A type may write here as its primary target, or as an extra one named in alsoTargets (Task
  // 8's ECG payload does both) - either is "mine", and only neither is a foreign type.
  if (t.target !== 'samples' && !t.alsoTargets?.includes('samples')) {
    throw new ConfigError(`${t.id} is not a sample type`)
  }

  // Deferred types are fetched and archived, but their shape is not yet confirmed against a
  // real payload, so a valuePath would be a guess rather than a measurement.
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

  // The source a page names for all of its points. The companion route archives the one identity
  // a request carries here rather than inside every point (ingest.ts), and a rebuild has nothing
  // but the archive to read: without this fallback every row of such a page replays under
  // `unknown`, an identity no describe() would ever have produced for it.
  const pageSource = (parsed as { dataSource?: unknown }).dataSource

  const rows: SampleRow[] = []
  for (const point of points) {
    const payload = valueAt(point, t.payloadKey)
    if (payload === undefined) continue

    // The interval or sample instant is the row's clock for both an ordinary type and a
    // sub-dimension type, so it is resolved once here rather than twice.
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

    const sub = t.subDimension

    // The ordinary row and the sub-dimension rows below are additive, not a choice: a
    // sub-dimension type with no valuePath of its own (every one the catalogue declares today)
    // skips this branch exactly as it always has, since parsing an empty valuePath would only
    // resolve to nothing anyway. A type declaring both - Task 7's nutrition log, a top-level
    // EnergyQuantity beside an array of macronutrients - writes an ordinary row here and then
    // its sub-dimension rows below, from the same point.
    if (!sub || t.valuePath !== '') {
      // A duration type's value is the interval's own length: some of these carry no other
      // field to read at all.
      const value = t.durationMinutes
        ? parseIntervalMinutes(valueAt(payload, 'interval'))
        : parseNumeric(valueAt(payload, t.valuePath))
      // A point with no value is a point the device did not record. Writing a zero here is the
      // single easiest way to turn a gap into a fabricated measurement. Spec invariant 2.
      if (value !== null) {
        // Per point, not once per call: a single payload carries more than one platform, and
        // spec invariant 4 requires every row to keep its own source. A point that names none
        // belongs to the page's name, which is the only source such a body carries.
        const sourceId = input.resolveSource(valueAt(point, 'dataSource') ?? pageSource)
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
    }

    if (sub) {
      const arrayValue = sub.arrayPath ? valueAt(payload, sub.arrayPath) : undefined
      const elements = sub.arrayPath ? (Array.isArray(arrayValue) ? arrayValue : []) : [payload]
      // One source per point, not per element: every element in this loop comes from the same
      // point, so resolving it once outside the loop is both correct and cheaper.
      const sourceId = input.resolveSource(valueAt(point, 'dataSource') ?? pageSource)
      for (const element of elements) {
        const key = valueAt(element, sub.keyPath)
        const metric = typeof key === 'string' ? sub.metricByKey[key] : undefined
        // A key the field map never recorded is schema drift, not a new metric. Writing it
        // anyway would put a series on a chart that no catalogue entry describes, silently.
        if (metric === undefined) continue
        // Both value fields are int64 and arrive as JSON strings, same as an ordinary type -
        // except a duration sub-dimension, whose value is the interval's own length.
        const minutes = sub.durationMinutes
          ? parseIntervalMinutes(valueAt(payload, 'interval'))
          : parseNumeric(valueAt(element, sub.valuePath))
        if (minutes === null) continue
        rows.push({
          personId: input.personId,
          sourceId,
          metric,
          utcMs,
          tzOffsetMinutes,
          agg: 'raw',
          value: minutes,
          n: 1,
          rawPayloadId: input.rawPayloadId,
        })
      }
    }
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
