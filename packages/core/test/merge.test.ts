import { describe, expect, it } from 'vitest'
import { mergeDay, encodeMix } from '../src/derive/merge.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import type { SampleLike } from '../src/derive/rollup.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const LOCAL_DATE = '2026-08-22'

const SOURCES: SourceFacts[] = [
  { id: 'watch', kind: 'device' },
  { id: 'phone', kind: 'app' },
]

const sample = (o: {
  metric: string, value: number | null, hour: number, sourceId: string,
  agg?: SampleLike['agg'], n?: number,
}): SampleLike => ({
  sourceId: o.sourceId,
  metric: o.metric,
  utcMs: MIDNIGHT_UTC + o.hour * 3_600_000,
  tzOffsetMinutes: OFFSET,
  agg: o.agg ?? 'raw',
  value: o.value,
  n: o.n ?? 1,
})

const merge = (rows: SampleLike[], lists: Map<string, readonly string[]> = new Map()) =>
  mergeDay({
    personId: 'p1',
    localDate: LOCAL_DATE,
    rows,
    priority: priorityFrom({ lists, sources: SOURCES }),
  })

const rowFor = (rows: ReturnType<typeof merge>, metric: string, agg: string) =>
  rows.find((r) => r.metric === metric && r.agg === agg)

describe('mergeDay', () => {
  it('files every row it produces under the merged source', () => {
    const rows = merge([sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })])
    expect(rows.every((r) => r.source === 'merged')).toBe(true)
  })

  it('gives an hour to one source only, which is the double counted steps this exists to prevent', () => {
    const rows = merge([
      sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' }),
    ])
    // The watch is a device and the phone an app, so the fallback picks the watch. 1300 would be
    // the corruption: one pair of legs, two counters, added.
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(400)
  })

  it('fills the hours the winner has nothing for, from the next source down', () => {
    // The watch died at noon. The afternoon is the phone's, and the day is the two together
    // without either hour being counted twice.
    const rows = merge([
      sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 100, hour: 9, sourceId: 'phone' }),
      sample({ metric: 'steps', value: 900, hour: 15, sourceId: 'phone' }),
    ])
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(1300)
  })

  it('records the mix, hours descending, so the merge can be inspected', () => {
    const rows = merge([
      sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 400, hour: 10, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 900, hour: 15, sourceId: 'phone' }),
    ])
    expect(rowFor(rows, 'steps', 'sum')?.sourceMix).toBe(
      '[{"source":"watch","hours":2},{"source":"phone","hours":1}]',
    )
  })

  it('obeys a configured list over the kind fallback', () => {
    const rows = merge(
      [
        sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
        sample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' }),
      ],
      new Map([['steps', ['phone', 'watch']]]),
    )
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(900)
    expect(rowFor(rows, 'steps', 'sum')?.sourceMix).toBe('[{"source":"phone","hours":1}]')
  })

  it('writes a merged row even when only one source has data, so a reader never has to ask', () => {
    const rows = merge([sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })])
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(400)
    expect(rowFor(rows, 'steps', 'sum')?.sourceMix).toBe('[{"source":"watch","hours":1}]')
  })

  it('measures coverage over the hours it kept, not the hours it saw', () => {
    const rows = merge([
      sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 100, hour: 9, sourceId: 'phone' }),
      sample({ metric: 'steps', value: 900, hour: 15, sourceId: 'phone' }),
    ])
    expect(rowFor(rows, 'steps', 'sum')?.coverage).toBeCloseTo(2 / 24, 10)
  })

  it('ignores a null value, so an hour a source reported nothing in is not an hour it won', () => {
    const rows = merge([
      sample({ metric: 'steps', value: null, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' }),
    ])
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(900)
    expect(rowFor(rows, 'steps', 'sum')?.sourceMix).toBe('[{"source":"phone","hours":1}]')
  })

  it('chooses per metric, so a source can win steps and lose heart rate', () => {
    const rows = merge(
      [
        sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
        sample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' }),
        sample({ metric: 'heart_rate', value: 60, hour: 9, sourceId: 'watch' }),
        sample({ metric: 'heart_rate', value: 90, hour: 9, sourceId: 'phone' }),
      ],
      new Map([['steps', ['phone', 'watch']], ['heart_rate', ['watch', 'phone']]]),
    )
    expect(rowFor(rows, 'steps', 'sum')?.value).toBe(900)
    expect(rowFor(rows, 'heart_rate', 'mean')?.value).toBe(60)
  })

  it('does not depend on the order the rows arrived in', () => {
    const rows: SampleLike[] = [
      sample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' }),
      sample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' }),
      sample({ metric: 'steps', value: 100, hour: 15, sourceId: 'phone' }),
    ]
    expect(merge(rows)).toEqual(merge([...rows].reverse()))
  })
})

describe('encodeMix', () => {
  it('orders by hours descending then source, so the string is stable', () => {
    expect(encodeMix([
      { source: 'b', hours: 1 },
      { source: 'a', hours: 1 },
      { source: 'c', hours: 5 },
    ])).toBe('[{"source":"c","hours":5},{"source":"a","hours":1},{"source":"b","hours":1}]')
  })
})
