import { describe, expect, it } from 'vitest'
import { localMinuteOf } from '../src/derive/localDay.ts'
import { mergeDay, selectHourWinners } from '../src/derive/merge.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SampleLike } from '../src/derive/rollup.ts'

const priority = priorityFrom({
  lists: new Map([['steps', ['watch', 'phone']]]),
  sources: [{ id: 'watch', kind: 'device' }, { id: 'phone', kind: 'app' }],
})
const at = (iso: string) => Date.parse(iso)
const step = (sourceId: string, iso: string, value: number, tz = 0): SampleLike =>
  ({ sourceId, metric: 'steps', utcMs: at(iso), tzOffsetMinutes: tz, agg: 'raw', value, n: 1 })

describe('localMinuteOf', () => {
  it('is the minute of the local day under the row\'s own offset', () => {
    expect(localMinuteOf(at('2026-09-24T12:05:00Z'), 120)).toBe(14 * 60 + 5)
    expect(localMinuteOf(at('2026-09-24T23:30:00Z'), 60)).toBe(30)
  })
})

describe('selectHourWinners', () => {
  it('keeps one source per hour by priority, so a phone and a watch are never added together', () => {
    const rows = [step('watch', '2026-09-24T08:10:00Z', 100), step('phone', '2026-09-24T08:20:00Z', 90),
      step('phone', '2026-09-24T09:10:00Z', 40)]
    const { winning, mixes } = selectHourWinners(rows, priority)
    expect(winning.map((r) => r.value)).toEqual([100, 40])
    expect(winning.every((r) => r.sourceId === 'merged')).toBe(true)
    expect([...mixes.get('steps')!]).toEqual([['watch', 1], ['phone', 1]])
  })

  it('is exactly what mergeDay sums, so pace and the daily total cannot drift apart', () => {
    const rows = [step('watch', '2026-09-24T08:10:00Z', 100), step('phone', '2026-09-24T08:20:00Z', 90),
      step('phone', '2026-09-24T09:10:00Z', 40)]
    const total = selectHourWinners(rows, priority).winning.reduce((s, r) => s + (r.value ?? 0), 0)
    const daily = mergeDay({ personId: 'p1', localDate: '2026-09-24', rows, priority })
      .find((r) => r.metric === 'steps' && r.agg === 'sum')!
    expect(total).toBe(daily.value)
  })
})
