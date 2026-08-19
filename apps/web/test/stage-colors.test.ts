import { describe, it, expect } from 'vitest'
import { stageColor } from '../src/charts/stage.js'
import type { ChartTokens } from '../src/charts/tokens.js'

const tokens = {
  stageDeep: '#111111', stageLight: '#222222', stageRem: '#333333', stageAwake: '#444444',
} as ChartTokens

describe('stage colour mapping', () => {
  it('maps every stage to its own token', () => {
    expect(stageColor('deep', tokens)).toBe('#111111')
    expect(stageColor('light', tokens)).toBe('#222222')
    expect(stageColor('rem', tokens)).toBe('#333333')
    expect(stageColor('awake', tokens)).toBe('#444444')
  })

  it('never returns the same colour for two different stages', () => {
    const used = (['deep', 'light', 'rem', 'awake'] as const).map((s) => stageColor(s, tokens))
    expect(new Set(used).size).toBe(4)
  })
})
