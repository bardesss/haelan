import { lookup, type Theme } from './semantic.js'

export const STAGE_KEYS = ['stage-deep', 'stage-light', 'stage-rem', 'stage-awake'] as const

// Sleep depth reads as colour depth, and the blue to amber axis survives every
// common dichromacy. See spec section 17, track D1.
export const chartTokens: Record<Theme, Record<string, string>> = {
  dark: {
    'stage-deep': 'blue.800',
    'stage-light': 'blue.500',
    'stage-rem': 'blue.300',
    'stage-awake': 'amber.500',
    series: 'blue.500',
    grid: 'slate.800',
    axis: 'slate.600',
    'band-baseline': 'blue.900',
    'state-excluded': 'slate.600',
    'state-no-data': 'slate.noDataDark',
  },
  light: {
    'stage-deep': 'blue.700',
    'stage-light': 'blue.400',
    'stage-rem': 'blue.200',
    'stage-awake': 'amber.700',
    series: 'blue.400',
    grid: 'slate.200',
    axis: 'slate.600',
    'band-baseline': 'blue.100',
    'state-excluded': 'slate.600',
    'state-no-data': 'slate.noDataLight',
  },
}

export function resolveChart(theme: Theme): Record<string, string> {
  return Object.fromEntries(Object.entries(chartTokens[theme]).map(([k, v]) => [k, lookup(v)]))
}
