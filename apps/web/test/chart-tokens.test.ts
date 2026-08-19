import { describe, it, expect } from 'vitest'
import { readChartTokens, CHART_VARS } from '../src/charts/tokens.js'

function styleWith(values: Record<string, string>) {
  return { getPropertyValue: (name: string) => values[name] ?? '' }
}

describe('chart token resolution', () => {
  const full = Object.fromEntries(CHART_VARS.map((v, i) => [v, `#00000${i}`]))

  it('reads every chart colour from custom properties at render time', () => {
    const tokens = readChartTokens(styleWith(full))
    expect(tokens.stageDeep).toBe(full['--chart-stage-deep'])
    expect(tokens.grid).toBe(full['--chart-grid'])
  })

  it('fails loudly when a token is missing rather than falling back to a default', () => {
    const partial = { ...full }
    delete partial['--chart-stage-rem']
    expect(() => readChartTokens(styleWith(partial))).toThrow(/--chart-stage-rem/)
  })
})
