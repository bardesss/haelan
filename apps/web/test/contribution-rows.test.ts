import { describe, it, expect } from 'vitest'
import { contributionRows } from '../src/pages/recovery/contributionRows.js'

describe('contributionRows', () => {
  it('orders inputs by how much they moved the score, largest first', () => {
    const rows = contributionRows([
      { key: 'hrv', weight: 0.35, points: 2, contribution: 0.1 },
      { key: 'restingHeartRate', weight: 0.30, points: -11, contribution: -0.6 },
      { key: 'sleep', weight: 0.25, points: 1, contribution: 0.05 },
    ])
    expect(rows.map((row) => row.key)).toEqual(['restingHeartRate', 'hrv', 'sleep'])
  })

  it('rounds points to whole numbers, because a tenth of a point means nothing', () => {
    const rows = contributionRows([{ key: 'hrv', weight: 1, points: -11.4, contribution: -0.5 }])
    expect(rows[0]?.points).toBe(-11)
  })
})
