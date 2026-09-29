import { describe, expect, it } from 'vitest'
import { periodBounds, stepPeriod, earlierBlocks, weeksIn, yearEarlierDate, daysIn, datesIn } from '../src/query/periodBounds.ts'

describe('periodBounds', () => {
  it('week runs Monday to Sunday, a Sunday belonging to the week before it', () => {
    expect(periodBounds('week', '2026-09-30')).toEqual({ from: '2026-09-28', to: '2026-10-04' })
    expect(periodBounds('week', '2026-10-04')).toEqual({ from: '2026-09-28', to: '2026-10-04' })
  })
  it('month is the calendar month, February in a leap year included', () => {
    expect(periodBounds('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
  it('3months is the anchor month and the two before it, across a year end', () => {
    expect(periodBounds('3months', '2026-01-15')).toEqual({ from: '2025-11-01', to: '2026-01-31' })
  })
  it('year is the calendar year', () => {
    expect(periodBounds('year', '2026-06-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })
})

describe('stepPeriod', () => {
  it('clamps a month step onto the shorter month', () => {
    expect(stepPeriod('month', '2026-03-31', -1)).toBe('2026-02-28')
  })
  it('steps 3months by three months and year by twelve', () => {
    expect(stepPeriod('3months', '2026-05-10', -1)).toBe('2026-02-10')
    expect(stepPeriod('year', '2026-05-10', 1)).toBe('2027-05-10')
  })
  it('steps a week by seven days', () => {
    expect(stepPeriod('week', '2026-09-30', 1)).toBe('2026-10-07')
    expect(stepPeriod('week', '2026-09-30', -1)).toBe('2026-09-23')
  })
})

describe('earlierBlocks', () => {
  it('week: the twelve weeks before, oldest first, each Monday to Sunday', () => {
    const { unit, blocks } = earlierBlocks('week', periodBounds('week', '2026-09-30'))
    expect(unit).toBe('week')
    expect(blocks).toHaveLength(12)
    expect(blocks[11]).toEqual({ from: '2026-09-21', to: '2026-09-27' })
    expect(blocks[0]).toEqual({ from: '2026-07-06', to: '2026-07-12' })
  })
  it('month: the twelve calendar months before', () => {
    const { unit, blocks } = earlierBlocks('month', periodBounds('month', '2026-03-05'))
    expect(unit).toBe('month')
    expect(blocks).toHaveLength(12)
    expect(blocks[11]).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(blocks[0]).toEqual({ from: '2025-03-01', to: '2025-03-31' })
  })
  it('3months: four blocks of three months covering the twelve months before', () => {
    const { unit, blocks } = earlierBlocks('3months', periodBounds('3months', '2026-03-05'))
    expect(unit).toBe('quarter')
    expect(blocks).toEqual([
      { from: '2025-01-01', to: '2025-03-31' }, { from: '2025-04-01', to: '2025-06-30' },
      { from: '2025-07-01', to: '2025-09-30' }, { from: '2025-10-01', to: '2025-12-31' },
    ])
  })
  it('year: the previous year in its four quarters', () => {
    const { unit, blocks } = earlierBlocks('year', periodBounds('year', '2026-06-01'))
    expect(unit).toBe('year')
    expect(blocks.map((b) => b.from)).toEqual(['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01'])
    expect(blocks.map((b) => b.to)).toEqual(['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'])
  })
})

describe('weeksIn', () => {
  it('clips the first and last week to the span', () => {
    expect(weeksIn({ from: '2026-09-01', to: '2026-09-09' })).toEqual([
      { from: '2026-09-01', to: '2026-09-06' }, { from: '2026-09-07', to: '2026-09-09' },
    ])
  })
  it('a span of one whole week is one block', () => {
    expect(weeksIn({ from: '2026-09-28', to: '2026-10-04' })).toEqual([{ from: '2026-09-28', to: '2026-10-04' }])
  })
})

describe('small helpers', () => {
  it('yearEarlierDate drops a leap day onto 28 February', () => {
    expect(yearEarlierDate('2028-02-29')).toBe('2027-02-28')
    expect(yearEarlierDate('2026-09-30')).toBe('2025-09-30')
  })
  it('daysIn and datesIn count both ends', () => {
    expect(daysIn({ from: '2026-09-28', to: '2026-10-04' })).toBe(7)
    expect(datesIn({ from: '2026-12-31', to: '2027-01-01' })).toEqual(['2026-12-31', '2027-01-01'])
  })
})
