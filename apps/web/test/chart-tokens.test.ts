import { describe, it, expect } from 'vitest'
import { emitCss } from '@haelan/tokens'
import { readChartTokens, CHART_VARS, scaleStops } from '../src/charts/tokens.js'

function styleWith(values: Record<string, string>) {
  return { getPropertyValue: (name: string) => values[name] ?? '' }
}

describe('chart token resolution', () => {
  const full = Object.fromEntries(CHART_VARS.map((v, i) => [v, `#00000${i % 10}`]))

  it('reads every chart colour from custom properties at render time', () => {
    const tokens = readChartTokens(styleWith(full))
    expect(tokens.stageDeep).toBe(full['--chart-stage-deep'])
    expect(tokens.grid).toBe(full['--chart-grid'])
    expect(tokens.tooltipBg).toBe(full['--chart-tooltip-bg'])
  })

  it('fails loudly when a token is missing rather than falling back to a default', () => {
    const partial = { ...full }
    delete partial['--chart-stage-rem']
    expect(() => readChartTokens(styleWith(partial))).toThrow(/--chart-stage-rem/)
  })

  it('hands the sequential scale over in low-to-high order', () => {
    const tokens = readChartTokens(styleWith(full))
    expect(scaleStops(tokens)).toEqual([tokens.scale1, tokens.scale2, tokens.scale3, tokens.scale4, tokens.scale5])
  })

  // The app reads names it does not define. Without this, renaming a token in
  // @haelan/tokens leaves every test passing and the first render throwing.
  it('reads only custom properties the generated stylesheet defines', () => {
    const css = emitCss()
    for (const variable of CHART_VARS) {
      expect(css, `${variable} is read by the app but never emitted`).toContain(`${variable}: `)
    }
  })
})
