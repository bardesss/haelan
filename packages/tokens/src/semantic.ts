import { primitives, COLOR_GROUPS, type ColorPath } from './primitives.js'

export type Theme = 'dark' | 'light'
export const THEMES = ['dark', 'light'] as const satisfies readonly Theme[]

// `satisfies` rather than a type annotation, so the key union below is derived from what's actually here, not widened to `string`.
export const semantic = {
  dark: {
    'surface-page': 'slate.975',
    'surface-card': 'slate.900',
    'surface-inset': 'slate.925',
    'surface-rail': 'slate.950',
    'border-subtle': 'slate.850',
    'text-primary': 'slate.150',
    'text-secondary': 'slate.300',
    'text-muted': 'slate.400',
    'text-faint': 'slate.500',
    accent: 'blue.500',
    'accent-soft': 'blue.200',
    focus: 'blue.100',
    positive: 'mint.400',
    negative: 'coral.400',
    'surface-hover': 'slate.850',
    'surface-selected': 'blue.950',
    'surface-accent': 'blue.950',
    'surface-accent-hover': 'blue.900',
    'surface-disabled': 'slate.900',
    'border-accent': 'blue.800',
    'text-disabled': 'slate.600',
    // .choice:has(input:checked) and .setup-horizon's chosen button share these two (review
    // finding 1): the state is "this option is picked", not a component. Both paint directly on
    // surface-page (setup-shell/-column/-step set no background of their own), not surface-card.
    // 8% accent over surface-page (0.08 x blue.500 + 0.92 x slate.975) computes to #101829, which
    // sits deltaE 5.92 from the existing blue.950 - under the ramp's 6-point distinctness floor,
    // so a fresh adjacent step would fail layering.test.ts. Reusing blue.950 is the honest answer:
    // the two composites are indistinguishable at this ramp's resolution.
    'surface-chosen': 'blue.950',
    // 44% accent over surface-page (0.44 x blue.500 + 0.56 x slate.975) computes to #28477A, far
    // enough from every existing step (deltaE 40+ on both sides) to need a genuine new one: blue.750.
    'border-chosen': 'blue.750',
  },
  light: {
    'surface-page': 'slate.100',
    'surface-card': 'slate.50',
    'surface-inset': 'slate.200',
    'surface-rail': 'slate.50',
    'border-subtle': 'slate.200',
    'text-primary': 'slate.900',
    'text-secondary': 'slate.800',
    'text-muted': 'slate.700',
    'text-faint': 'slate.650',
    accent: 'blue.600',
    'accent-soft': 'blue.900',
    focus: 'blue.600',
    positive: 'mint.700',
    negative: 'coral.700',
    'surface-hover': 'slate.200',
    'surface-selected': 'blue.50',
    'surface-accent': 'blue.50',
    'surface-accent-hover': 'blue.100',
    'surface-disabled': 'slate.200',
    'border-accent': 'blue.200',
    // slate.500 (the brief's value) measures 2.95:1 against surface-disabled (slate.200),
    // under the 3:1 floor this project holds disabled text to even though WCAG exempts it.
    // slate.600 clears it at 3.90:1 without changing surface-disabled.
    'text-disabled': 'slate.600',
    // Same reasoning as the dark entries above: 8% accent over surface-page (0.08 x blue.500 +
    // 0.92 x slate.100) computes to #E8EFFB, deltaE 1.12 from the existing blue.50 - reused rather
    // than minting an indistinguishable neighbour that would fail the distinctness floor.
    'surface-chosen': 'blue.50',
    // 44% accent over surface-page (0.44 x blue.500 + 0.56 x slate.100) computes to #ACC9F9, a
    // genuine new step: blue.350.
    'border-chosen': 'blue.350',
  },
} satisfies Record<Theme, Record<string, ColorPath>>

export type SemanticToken = keyof (typeof semantic)['dark']
export const SEMANTIC_KEYS = Object.keys(semantic.dark) as SemanticToken[]

export const SURFACE_KEYS = ['surface-page', 'surface-card', 'surface-inset', 'surface-rail'] as const satisfies readonly SemanticToken[]
export const TEXT_KEYS = ['text-primary', 'text-secondary', 'text-muted', 'text-faint'] as const satisfies readonly SemanticToken[]

export function lookup(path: ColorPath): string {
  const [group, key] = path.split('.')
  if (!COLOR_GROUPS.includes(group as never)) throw new Error(`unknown primitive: ${path}`)
  const value = (primitives as Record<string, Record<string, string>>)[group ?? '']?.[key ?? '']
  if (!value) throw new Error(`unknown primitive: ${path}`)
  return value
}

export function resolveSemantic(theme: Theme): Record<SemanticToken, string> {
  const entries = Object.entries(semantic[theme]).map(([name, path]) => [name, lookup(path)])
  return Object.fromEntries(entries) as Record<SemanticToken, string>
}
