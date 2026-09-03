import { chartVar, semanticVar, type ChartToken, type SemanticToken } from '@haelan/tokens'

// Token names are imported (satisfies catches a rename as a type error); values are read late via getComputedStyle so a theme switch reaches the charts.
const CHART_SOURCES = {
  stageDeep: 'stage-deep',
  stageLight: 'stage-light',
  stageRem: 'stage-rem',
  stageAwake: 'stage-awake',
  series: 'series',
  // Reintroduced for IntradayHeartRate, which draws one mean line per source and needs a second
  // colour so a two device day reads as two lines rather than one line overdrawn on itself. It was
  // removed once before, when the corrected mark on the three by-day charts, its only reader at
  // the time, went away with OverrideStore.validate refusing a day scoped correction.
  // readChartTokens throws on any name in this map the stylesheet does not define and reads every
  // one of them on every render, so a name stays out until some chart actually asks for it.
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

// Low value first: charts consume the whole ramp, so this can't quietly become a two-stop scale.
export function scaleStops(t: ChartTokens): string[] {
  return [t.scale1, t.scale2, t.scale3, t.scale4, t.scale5]
}
