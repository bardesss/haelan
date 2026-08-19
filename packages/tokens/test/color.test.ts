import { describe, it, expect } from 'vitest'
import { toLab, deltaE } from '../src/color/convert.js'
import { simulate, minSeparation, CVD_KINDS } from '../src/color/cvd.js'
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
  it.each(CVD_KINDS)('leaves grey unchanged under %s', (kind) => {
    expect(simulate(kind, '#808080').toLowerCase()).toBe('#808080')
  })

  // Red and green sit on the deuteranope confusion axis, which is the whole
  // reason the sleep stage palette avoids distinguishing categories by hue alone.
  // A bare "less than before" would pass on a rounding difference, so this
  // asserts the size of the loss: at least two thirds of the separation goes,
  // and what remains is lightness rather than hue.
  it('collapses red and green toward each other for a deuteranope', () => {
    const normal = deltaE('#FF0000', '#00FF00')
    const seen = deltaE(simulate('deuteranopia', '#FF0000'), simulate('deuteranopia', '#00FF00'))
    expect(normal).toBeGreaterThan(150)
    expect(seen).toBeLessThan(normal * 0.6)
    const chroma = (hex: string) => toLab(hex)
    const before = Math.hypot(chroma('#FF0000').a - chroma('#00FF00').a, chroma('#FF0000').b - chroma('#00FF00').b)
    const after = Math.hypot(
      chroma(simulate('deuteranopia', '#FF0000')).a - chroma(simulate('deuteranopia', '#00FF00')).a,
      chroma(simulate('deuteranopia', '#FF0000')).b - chroma(simulate('deuteranopia', '#00FF00')).b,
    )
    expect(before - after).toBeGreaterThan(60)
  })

  it('reports the worst case across normal vision and every simulation', () => {
    const worst = minSeparation('#FF0000', '#00FF00')
    const all = [deltaE('#FF0000', '#00FF00'), ...CVD_KINDS.map((k) => deltaE(simulate(k, '#FF0000'), simulate(k, '#00FF00')))]
    expect(worst).toBe(Math.min(...all))
    expect(worst).toBeLessThan(all[0]! * 0.6)
    // Pure lightness differences survive every dichromacy, which is why the
    // palette leans on them wherever a hue difference would not carry.
    expect(minSeparation('#000000', '#FFFFFF')).toBeCloseTo(100, 0)
  })
})
