import { lookup, type Theme } from './semantic.js'
import type { ColorPath } from './primitives.js'

export const STAGE_KEYS = ['stage-deep', 'stage-light', 'stage-rem', 'stage-awake'] as const

// Low value first; each theme walks the ramp in the opposite direction so "more" moves away from its own card.
export const SCALE_KEYS = ['scale-1', 'scale-2', 'scale-3', 'scale-4', 'scale-5'] as const

// Chart roles: sleep depth reads as colour depth; the blue-to-amber axis survives common dichromacy (spec section 17, track D1).
export const chartTokens = {
  dark: {
    'stage-deep': 'blue.800',
    'stage-light': 'blue.500',
    'stage-rem': 'blue.100',
    'stage-awake': 'amber.500',
    series: 'blue.500',
    'series-alt': 'blue.200',
    grid: 'slate.925',
    axis: 'slate.500',
    'band-baseline': 'blue.900',
    'state-excluded': 'slate.600',
    'state-no-data': 'plum.300',
    'tooltip-bg': 'slate.850',
    'scale-1': 'azure.900',
    'scale-2': 'azure.700',
    'scale-3': 'azure.500',
    'scale-4': 'azure.300',
    'scale-5': 'azure.100',
  },
  light: {
    'stage-deep': 'blue.900',
    'stage-light': 'blue.600',
    'stage-rem': 'blue.100',
    'stage-awake': 'amber.700',
    series: 'blue.600',
    'series-alt': 'blue.800',
    grid: 'slate.200',
    axis: 'slate.650',
    'band-baseline': 'blue.200',
    'state-excluded': 'slate.600',
    'state-no-data': 'plum.800',
    'tooltip-bg': 'slate.150',
    'scale-1': 'azure.100',
    'scale-2': 'azure.300',
    'scale-3': 'azure.500',
    'scale-4': 'azure.700',
    'scale-5': 'azure.900',
  },
} satisfies Record<Theme, Record<string, ColorPath>>

export type ChartToken = keyof (typeof chartTokens)['dark']
export const CHART_KEYS = Object.keys(chartTokens.dark) as ChartToken[]

export function resolveChart(theme: Theme): Record<ChartToken, string> {
  const entries = Object.entries(chartTokens[theme]).map(([k, v]) => [k, lookup(v)])
  return Object.fromEntries(entries) as Record<ChartToken, string>
}
