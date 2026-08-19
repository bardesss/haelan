export const CHART_VARS = [
  '--chart-stage-deep', '--chart-stage-light', '--chart-stage-rem', '--chart-stage-awake',
  '--chart-series', '--chart-grid', '--chart-axis', '--chart-band-baseline',
  '--chart-state-excluded', '--chart-state-no-data',
  '--text-muted', '--surface-card',
] as const

export type ChartTokens = {
  stageDeep: string; stageLight: string; stageRem: string; stageAwake: string
  series: string; grid: string; axis: string; band: string
  excluded: string; noData: string; muted: string; surface: string
}

const KEYS: [keyof ChartTokens, (typeof CHART_VARS)[number]][] = [
  ['stageDeep', '--chart-stage-deep'], ['stageLight', '--chart-stage-light'],
  ['stageRem', '--chart-stage-rem'], ['stageAwake', '--chart-stage-awake'],
  ['series', '--chart-series'], ['grid', '--chart-grid'], ['axis', '--chart-axis'],
  ['band', '--chart-band-baseline'], ['excluded', '--chart-state-excluded'],
  ['noData', '--chart-state-no-data'], ['muted', '--text-muted'], ['surface', '--surface-card'],
]

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
