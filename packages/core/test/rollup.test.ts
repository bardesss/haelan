import { describe, expect, it } from 'vitest'
import { rollUpDay, DERIVATION_VERSION } from '../src/derive/rollup.ts'
import type { SampleLike } from '../src/derive/rollup.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const LOCAL_DATE = '2026-08-22'

const sample = (o: Partial<SampleLike> & { metric: string, value: number | null }): SampleLike => ({
  sourceId: 'watch',
  utcMs: MIDNIGHT_UTC + 9 * 3_600_000,
  tzOffsetMinutes: OFFSET,
  agg: 'raw',
  n: 1,
  ...o,
})

const valueOf = (rows: ReturnType<typeof rollUpDay>, agg: string, source = 'watch') =>
  rows.find((r) => r.agg === agg && r.source === source)?.value

describe('rollUpDay', () => {
  it('sums a total metric within a source', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'steps', value: 400 }),
        sample({ metric: 'steps', value: 600, utcMs: MIDNIGHT_UTC + 10 * 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'sum')).toBe(1000)
  })

  it('never adds two sources together, because that is the classic double count', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'steps', value: 400, sourceId: 'watch' }),
        sample({ metric: 'steps', value: 900, sourceId: 'phone' }),
      ],
    })
    expect(valueOf(rows, 'sum', 'watch')).toBe(400)
    expect(valueOf(rows, 'sum', 'phone')).toBe(900)
    expect(rows.find((r) => r.source === 'merged')).toBeUndefined()
  })

  it('takes min and max from the downsampled rows that carry them', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'heart_rate', value: 52, agg: 'min', n: 30 }),
        sample({ metric: 'heart_rate', value: 61, agg: 'mean', n: 30 }),
        sample({ metric: 'heart_rate', value: 88, agg: 'max', n: 30 }),
        sample({ metric: 'heart_rate', value: 47, agg: 'min', n: 30, utcMs: MIDNIGHT_UTC + 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'min')).toBe(47)
    expect(valueOf(rows, 'max')).toBe(88)
  })

  it('never derives min or max from mean rows, because a day of means has no floor or ceiling to report', () => {
    // A mean can never fall outside its own minute's min and max, so no fixture mixing mean
    // with min/max rows can catch mean leaking into FEEDS.min or FEEDS.max. This fixture has no
    // min or max rows at all, so leaking mean in would be the only way to produce one.
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [55, 57, 59].map((value, i) => sample({
        metric: 'heart_rate', value, agg: 'mean', n: 30, utcMs: MIDNIGHT_UTC + i * 3_600_000,
      })),
    })
    expect(rows.map((r) => r.agg).sort()).toEqual(['mean', 'p50'])
    expect(valueOf(rows, 'min')).toBeUndefined()
    expect(valueOf(rows, 'max')).toBeUndefined()
  })

  it('weights a mean by how many readings each row collapsed', () => {
    // The failure this prevents: averaging two minute rows equally when one collapsed thirty
    // readings and the other collapsed two.
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'heart_rate', value: 60, agg: 'mean', n: 30 }),
        sample({ metric: 'heart_rate', value: 100, agg: 'mean', n: 10, utcMs: MIDNIGHT_UTC + 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'mean')).toBeCloseTo((60 * 30 + 100 * 10) / 40)
  })

  it('takes last from the latest reading of the day', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'weight', value: 81.2, utcMs: MIDNIGHT_UTC + 7 * 3_600_000 }),
        sample({ metric: 'weight', value: 80.9, utcMs: MIDNIGHT_UTC + 20 * 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'last')).toBe(80.9)
  })

  it('breaks a last tie on utcMs toward the raw row, regardless of input order', () => {
    const tiedUtcMs = MIDNIGHT_UTC + 5 * 3_600_000
    const raw = sample({ metric: 'weight', value: 81.4, agg: 'raw', utcMs: tiedUtcMs })
    const mean = sample({ metric: 'weight', value: 79.0, agg: 'mean', utcMs: tiedUtcMs })
    const forward = rollUpDay({ personId: 'p1', localDate: LOCAL_DATE, rows: [raw, mean] })
    const reversed = rollUpDay({ personId: 'p1', localDate: LOCAL_DATE, rows: [mean, raw] })
    expect(valueOf(forward, 'last')).toBe(81.4)
    expect(valueOf(reversed, 'last')).toBe(81.4)
  })

  it('computes a median that one bad hour cannot drag', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [55, 57, 59, 210].map((value, i) => sample({
        metric: 'heart_rate', value, agg: 'mean', utcMs: MIDNIGHT_UTC + i * 3_600_000,
      })),
    })
    expect(valueOf(rows, 'p50')).toBe(58)
  })

  it('writes only the aggregates the metric declares', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE, rows: [sample({ metric: 'steps', value: 400 })],
    })
    expect(rows.map((r) => r.agg).sort()).toEqual(['sum'])
  })

  it('skips a null value rather than counting it as zero', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'steps', value: null }),
        sample({ metric: 'steps', value: 250, utcMs: MIDNIGHT_UTC + 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'sum')).toBe(250)
  })

  it('excludes a null from the mean rather than averaging it in as zero', () => {
    // Sum can't tell null-skipped from null-as-zero here (both give 250 above), because adding
    // zero doesn't change a sum. Mean can: averaging a real 60 with a fabricated zero gives 30,
    // while excluding the null gives 60. This is the test that actually discriminates.
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE,
      rows: [
        sample({ metric: 'heart_rate', value: 60, agg: 'mean', n: 1 }),
        sample({ metric: 'heart_rate', value: null, agg: 'mean', utcMs: MIDNIGHT_UTC + 3_600_000 }),
      ],
    })
    expect(valueOf(rows, 'mean')).toBe(60)
  })

  it('writes no row at all for a metric with nothing but nulls', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE, rows: [sample({ metric: 'steps', value: null })],
    })
    expect(rows).toEqual([])
  })

  it('carries coverage and the derivation version on every row', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE, rows: [sample({ metric: 'steps', value: 400 })],
    })
    expect(rows[0]?.coverage).toBeCloseTo(1 / 24)
    expect(rows[0]?.derivationVersion).toBe(DERIVATION_VERSION)
  })

  it('ignores a metric the catalogue does not declare, rather than inventing aggregates', () => {
    const rows = rollUpDay({
      personId: 'p1', localDate: LOCAL_DATE, rows: [sample({ metric: 'not_a_metric', value: 1 })],
    })
    expect(rows).toEqual([])
  })
})
