import { chartVar, semanticVar, type ChartToken, type SemanticToken } from '@vitals/tokens'

// The app imports token *names* from the package that defines them and resolves
// their *values* from getComputedStyle at render time. Names are compile-time
// facts, so `satisfies` makes a rename in @vitals/tokens a type error here
// rather than a blank string at first paint; values must stay late-bound or a
// theme switch would not reach the charts.
const CHART_SOURCES = {
  stageDeep: 'stage-deep',
  stageLight: 'stage-light',
  stageRem: 'stage-rem',
  stageAwake: 'stage-awake',
  series: 'series',
  seriesAlt: 'series-alt',
  grid: 'grid',
  axis: 'axis',
  band: 'band-baseline',
  excluded: 'state-excluded',
  noData: 'state-no-data',
  tooltipBg: 'tooltip-bg',
  scale1: 'scale-1',
  scale2: 'scale-2',
  scale3: 'scale-3',
  scale4: 'scale-4',
  scale5: 'scale-5',
} as const satisfies Record<string, ChartToken>

const SEMANTIC_SOURCES = {
  muted: 'text-muted',
  surface: 'surface-card',
} as const satisfies Record<string, SemanticToken>

export type ChartTokens = Record<keyof typeof CHART_SOURCES | keyof typeof SEMANTIC_SOURCES, string>

// One author for both the property list and the field mapping: they cannot
// drift apart because they are the same object read twice.
const KEYS: [keyof ChartTokens, string][] = [
  ...Object.entries(CHART_SOURCES).map(([k, t]) => [k, chartVar(t)] as [keyof ChartTokens, string]),
  ...Object.entries(SEMANTIC_SOURCES).map(([k, t]) => [k, semanticVar(t)] as [keyof ChartTokens, string]),
]

export const CHART_VARS: readonly string[] = KEYS.map(([, variable]) => variable)

export function readChartTokens(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): ChartTokens {
  const out = {} as ChartTokens
  for (const [key, variable] of KEYS) {
    const value = style.getPropertyValue(variable).trim()
    if (!value) throw new Error(`missing chart token ${variable}`)
    out[key] = value
  }
  return out
}

export function currentChartTokens(): ChartTokens {
  return readChartTokens(getComputedStyle(document.documentElement))
}

// Low value first. Charts take the whole ramp rather than picking stops, so a
// heatmap cannot quietly reintroduce a two-stop scale.
export function scaleStops(t: ChartTokens): string[] {
  return [t.scale1, t.scale2, t.scale3, t.scale4, t.scale5]
}
