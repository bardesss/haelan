import { describe, it, expect } from 'vitest'
import { balanceZeroLine, balanceOf } from '../src/api/sleepBalance.ts'

describe('balanceZeroLine', () => {
  it('follows the usual when asked to and it is not thin', () => {
    expect(balanceZeroLine({ center: 420, thin: false }, true, 480)).toEqual({ minutes: 420, source: 'baseline' })
  })
  it('falls back to the target on a thin usual, no usual, or when the person chose the target', () => {
    expect(balanceZeroLine({ center: 420, thin: true }, true, 480)).toEqual({ minutes: 480, source: 'target' })
    expect(balanceZeroLine(null, true, 450)).toEqual({ minutes: 450, source: 'target' })
    expect(balanceZeroLine({ center: 420, thin: false }, false, 480)).toEqual({ minutes: 480, source: 'target' })
  })
})

describe('balanceOf', () => {
  it('signs each night against the zero line, keeps absent nights absent, and sums what is there', () => {
    expect(balanceOf([400, null, 500], 450)).toEqual({ values: [-50, null, 50], total: 0 })
  })
})
