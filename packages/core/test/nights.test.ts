import { describe, expect, it } from 'vitest'
import { oneNightPerDate } from '../src/api/nights.ts'

const night = (localDate: string, startMs: number, endMs: number, sourceId: string) => ({ localDate, startMs, endMs, sourceId })

describe('oneNightPerDate', () => {
  it('keeps the longest recording of each date and sorts by date', () => {
    const nights = [
      night('2026-08-02', 0, 100, 'phone'),
      night('2026-08-01', 0, 50, 'watch'),
      night('2026-08-02', 0, 400, 'watch'),
    ]
    expect(oneNightPerDate(nights).map((n) => [n.localDate, n.sourceId])).toEqual([
      ['2026-08-01', 'watch'], ['2026-08-02', 'watch'],
    ])
  })

  it('keeps the first of two equally long recordings, as the web copy did', () => {
    const nights = [night('2026-08-01', 0, 100, 'a'), night('2026-08-01', 0, 100, 'b')]
    expect(oneNightPerDate(nights)[0]!.sourceId).toBe('a')
  })
})
