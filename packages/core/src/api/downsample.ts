import type { SampleRow } from './mapSamples.ts'

const MINUTE_MS = 60_000

// M0 measured heart rate arriving every 2 seconds: 13.6M rows per person-year and 95 percent of
// all rows. The 2 second payload stays in raw_payloads, so this is a resolution choice in a
// cache and a later rebuild can widen it without re-fetching. See probe/findings/volume.md.
export function downsampleToMinute(rows: SampleRow[]): SampleRow[] {
  const buckets = new Map<string, SampleRow[]>()

  for (const row of rows) {
    if (row.value === null) continue
    const minuteMs = Math.floor(row.utcMs / MINUTE_MS) * MINUTE_MS
    // Grouped by source as well as minute: two devices reporting the same minute are chosen
    // between at derivation, never averaged into a number no device measured. Spec section 9.
    const key = `${row.personId} ${row.sourceId} ${row.metric} ${minuteMs}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const out: SampleRow[] = []
  for (const bucket of buckets.values()) {
    const first = bucket[0]
    if (!first) continue
    const values = bucket.map((r) => r.value as number)
    const minuteMs = Math.floor(first.utcMs / MINUTE_MS) * MINUTE_MS
    const base = {
      personId: first.personId,
      sourceId: first.sourceId,
      metric: first.metric,
      utcMs: minuteMs,
      tzOffsetMinutes: first.tzOffsetMinutes,
      n: bucket.length,
      rawPayloadId: first.rawPayloadId,
    }
    out.push(
      { ...base, agg: 'min', value: Math.min(...values) },
      { ...base, agg: 'mean', value: values.reduce((a, b) => a + b, 0) / values.length },
      { ...base, agg: 'max', value: Math.max(...values) },
      // The daily count aggregate feeds from raw and count only, and a downsampled minute has no
      // raw row left, so without this heart rate is the one metric that cannot say how many
      // readings a day held.
      { ...base, agg: 'count', value: values.length },
    )
  }

  return out
}
