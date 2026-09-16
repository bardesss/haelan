import { describe, it, expect } from 'vitest'
import { eddingtonOf } from '../src/api/eddington.ts'

describe('eddingtonOf', () => {
  it('is the largest E with E days at or above E thousand', () => {
    // Three days at 3000 or more, and not four at 4000 or more.
    expect(eddingtonOf([5000, 4000, 3000, 1000], 1000)).toBe(3)
  })

  it('does not move when days below it are added', () => {
    // The property measured against the real archive: E is decided at the top of the
    // distribution, so a coverage gate - which removes quiet days from the bottom - cannot
    // change it. That measurement is why this function takes no filter at all.
    const busy = [12000, 11000, 10000, 9000, 8000]
    expect(eddingtonOf([...busy, 100, 200, 300], 1000)).toBe(eddingtonOf(busy, 1000))
  })

  it('counts a day that exactly meets the threshold', () => {
    expect(eddingtonOf([2000, 2000], 1000)).toBe(2)
  })

  it('is zero for no days at all', () => {
    expect(eddingtonOf([], 1000)).toBe(0)
  })

  it('is zero when no day reaches even one unit', () => {
    // Not one: a person who walked 900 steps twice has an Eddington number of zero, and
    // rounding that up to one would be the first lie on a page built to avoid them.
    expect(eddingtonOf([900, 900, 900], 1000)).toBe(0)
  })

  it('takes the values unsorted', () => {
    expect(eddingtonOf([1000, 5000, 3000, 4000], 1000)).toBe(3)
  })
})
