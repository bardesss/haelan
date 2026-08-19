import { describe, it, expect } from 'vitest'
import { toLab, deltaE } from '../src/color/convert.js'
import { simulate } from '../src/color/cvd.js'
import { contrast } from '../src/color/contrast.js'

describe('colour maths', () => {
  it('puts white and black at the ends of the lightness axis', () => {
    expect(toLab('#ffffff').L).toBeCloseTo(100, 1)
    expect(toLab('#000000').L).toBeCloseTo(0, 1)
  })

  it('gives white on black the maximum contrast ratio', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1)
  })

  it('reports no difference between a colour and itself', () => {
    expect(deltaE('#4F8FF7', '#4F8FF7')).toBeCloseTo(0, 5)
  })

  // Every simulation matrix has rows summing to 1, so achromatic input is unchanged.
  it.each(['deuteranopia', 'protanopia', 'tritanopia'] as const)('leaves grey unchanged under %s', (kind) => {
    expect(simulate(kind, '#808080').toLowerCase()).toBe('#808080')
  })

  // Red and green sit on the deuteranope confusion axis, which is the whole
  // reason the sleep stage palette avoids distinguishing categories by hue alone.
  it('collapses red and green toward each other for a deuteranope', () => {
    const normal = deltaE('#FF0000', '#00FF00')
    const seen = deltaE(simulate('deuteranopia', '#FF0000'), simulate('deuteranopia', '#00FF00'))
    expect(seen).toBeLessThan(normal)
  })
})
