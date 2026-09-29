import { describe, it, expect } from 'vitest'
import { elapsedInterval, formatElapsed } from '../src/charts/elapsed.js'

describe('formatElapsed', () => {
  it('reads minutes and seconds under an hour, hours beyond', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(300_000)).toBe('5:00')
    expect(formatElapsed(28 * 60_000 + 4_000)).toBe('28:04')
    expect(formatElapsed(3_905_000)).toBe('1:05:05')
  })
})

// M10a-1's final review: the elapsed axis fell on clock boundaries, so a run started at 18:02
// read 3:00, 8:00, 13:00. The step is a whole number of minutes from the start instead, the
// smallest of 1, 2, 5, 10, 15, 30 and 60 that keeps the axis to seven steps or fewer.
describe('elapsedInterval', () => {
  const minutes = (n: number) => n * 60_000
  it('steps a run of half an hour in fives, and longer sessions in tens and fifteens', () => {
    expect(elapsedInterval(minutes(28) + 4_000)).toBe(minutes(5))
    expect(elapsedInterval(minutes(34))).toBe(minutes(5))
    expect(elapsedInterval(minutes(50))).toBe(minutes(10))
    expect(elapsedInterval(minutes(100))).toBe(minutes(15))
    expect(elapsedInterval(minutes(180))).toBe(minutes(30))
  })

  it('steps a short session in single minutes, and a very long one in whole hours', () => {
    expect(elapsedInterval(minutes(6))).toBe(minutes(1))
    expect(elapsedInterval(minutes(12))).toBe(minutes(2))
    expect(elapsedInterval(minutes(7 * 60))).toBe(minutes(60))
    expect(elapsedInterval(minutes(10 * 60))).toBe(minutes(120))
  })

  it('answers a step for a session of no length rather than dividing by zero', () => {
    expect(elapsedInterval(0)).toBe(minutes(1))
  })
})
