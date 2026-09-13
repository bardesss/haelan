import { describe, expect, it } from 'vitest'
import { deriveCardioLoadDay } from '../src/derive/cardioLoad.ts'
import type { DailyRow } from '../src/derive/rollup.ts'
import { MERGED_SOURCE } from '../src/derive/rollup.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

const LOCAL_DATE = '2026-09-12'

const zoneRow = (source: string, zone: string, value: number): DailyRow => ({
  personId: 'p1',
  localDate: LOCAL_DATE,
  metric: `time_in_heart_rate_zone_${zone}_minutes`,
  agg: 'sum',
  source,
  value,
  coverage: null,
  sourceMix: null,
  derivationVersion: DERIVATION_VERSION,
})

const derive = (rows: DailyRow[]) =>
  deriveCardioLoadDay({ personId: 'p1', localDate: LOCAL_DATE, rows })

describe('the daily cardio load row', () => {
  it('writes one row per source that recorded a zone', () => {
    const rows = derive([
      zoneRow('watch', 'light', 10),
      zoneRow('watch', 'moderate', 10),
      zoneRow('phone', 'light', 5),
    ])
    expect(rows.map((r) => [r.source, r.value])).toEqual([['watch', 30], ['phone', 5]])
  })

  it('writes a merged row from the merged zone rows', () => {
    const rows = derive([
      zoneRow('watch', 'light', 10),
      zoneRow(MERGED_SOURCE, 'light', 10),
      zoneRow(MERGED_SOURCE, 'peak', 5),
    ])
    const merged = rows.find((r) => r.source === MERGED_SOURCE)
    expect(merged?.value).toBe(30)
  })

  it('names the metric and the aggregate the catalogue declares', () => {
    const [row] = derive([zoneRow('watch', 'vigorous', 4)])
    expect(row?.metric).toBe('cardio_load_edwards')
    expect(row?.agg).toBe('sum')
    expect(row?.value).toBe(12)
  })

  // A load has no samples of its own underneath it, so the fraction of the day's hours carrying
  // one is not a question this row can answer - the same reasoning derive/exercise.ts gives.
  it('carries no coverage and no source mix', () => {
    const [row] = derive([zoneRow(MERGED_SOURCE, 'light', 10)])
    expect(row?.coverage).toBeNull()
    expect(row?.sourceMix).toBeNull()
  })

  it('stamps the current derivation version', () => {
    const [row] = derive([zoneRow('watch', 'light', 10)])
    expect(row?.derivationVersion).toBe(DERIVATION_VERSION)
  })

  // Absence is the whole answer, exactly as it is for a day with no workouts.
  it('writes nothing at all for a day with no zone rows', () => {
    expect(derive([])).toEqual([])
    expect(derive([{ ...zoneRow('watch', 'light', 10), metric: 'steps' }])).toEqual([])
  })

  // Only the day's zone-minute totals. A zone ceiling is a threshold, not time spent anywhere.
  it('ignores a zone ceiling metric', () => {
    const ceiling: DailyRow = {
      ...zoneRow('watch', 'light', 150), metric: 'heart_rate_zone_light_max_bpm', agg: 'last',
    }
    expect(derive([ceiling])).toEqual([])
  })
})
