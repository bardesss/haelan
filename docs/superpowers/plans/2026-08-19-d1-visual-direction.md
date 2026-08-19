# D1: Visual Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the token system, the chart styling specification and two static reference pages, so that M3 implements a design rather than inventing one.

**Architecture:** A pnpm workspace whose `packages/tokens` is the single source of truth for every colour, space and type value. Tokens are authored in TypeScript, emitted as CSS custom properties for the app and as a typed object for charts. Colour accessibility is enforced by tests that simulate three forms of colour blindness and assert perceptual separation and WCAG contrast, so breaking the palette fails the build. The web app renders two pages from hardcoded fixtures with no data layer and no network access.

**Tech Stack:** Node 22, pnpm, TypeScript, Vitest, Vite, React 19, ECharts 5.

**Spec:** `docs/superpowers/specs/2026-08-18-self-hosted-health-dashboard-design.md` (sections 11, 16, 17 track D1, 19)

## Global Constraints

- **No em dashes** in prose, code, comments, UI copy or commit messages.
- **Comments are sparse** and record why, never what. Public interfaces documented at their boundary.
- Node 22.13 or later (the floor comes from pnpm 11, not from our own code), pnpm as package manager.
- **No CDN, no external font host, no network at runtime.** The app must render fully offline. Typography uses a system font stack so no font files are shipped or fetched.
- **Components never reference primitive tokens.** They use semantic or component tokens only.
- **Charts resolve colours from CSS custom properties at render time**, never from hardcoded values in chart option objects.
- **Palette changes are tested, not eyeballed.** The accessibility suite is not optional and not skippable.
- This track owns the workspace root scaffolding. M1 adds `packages/core` and `packages/server` to the same workspace.

## Recommended skills during execution

When building the reference pages in Tasks 10, invoke the `frontend-design` skill; for chart form and colour decisions, invoke the `dataviz` skill. Both apply directly and neither is loaded by this plan.

---

### Task 1: Workspace scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.editorconfig`, `vitest.config.ts`
- Create: `packages/tokens/package.json`, `packages/tokens/tsconfig.json`, `packages/tokens/src/index.ts`, `packages/tokens/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a workspace where `pnpm -r test` runs; `@vitals/tokens` resolvable by other packages

- [ ] **Step 1: Write the failing test**

`packages/tokens/test/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('tokens package', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/tokens`
Expected: FAIL, cannot resolve `../src/index.js`.

- [ ] **Step 3: Write the scaffolding**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`package.json`:

```json
{
  "name": "vitals",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "dev": "pnpm --filter @vitals/web dev"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'] },
})
```

`packages/tokens/package.json`:

```json
{
  "name": "@vitals/tokens",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/tokens/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/tokens/src/index.ts`:

```typescript
export const VERSION = '0.1.0'
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
```

- [ ] **Step 4: Install and run the test**

Run: `pnpm install && pnpm vitest run packages/tokens`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .editorconfig packages/tokens
git commit -m "chore: pnpm workspace with tokens package and vitest"
```

---

### Task 2: Colour maths

**Files:**
- Create: `packages/tokens/src/color/convert.ts`, `packages/tokens/src/color/cvd.ts`, `packages/tokens/src/color/contrast.ts`
- Test: `packages/tokens/test/color.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `hexToRgb(hex: string): [number, number, number]`, `toLab(hex: string): {L: number, a: number, b: number}`, `deltaE(hexA: string, hexB: string): number`, `simulate(kind: 'deuteranopia' | 'protanopia' | 'tritanopia', hex: string): string`, `contrast(hexA: string, hexB: string): number`

- [ ] **Step 1: Write the failing test**

`packages/tokens/test/color.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { toLab, deltaE } from '../src/color/convert.js'
import { simulate } from '../src/color/cvd.js'
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
  it.each(['deuteranopia', 'protanopia', 'tritanopia'] as const)('leaves grey unchanged under %s', (kind) => {
    expect(simulate(kind, '#808080').toLowerCase()).toBe('#808080')
  })

  it('collapses green and orange toward each other for a deuteranope', () => {
    const normal = deltaE('#34D399', '#FBBF24')
    const seen = deltaE(simulate('deuteranopia', '#34D399'), simulate('deuteranopia', '#FBBF24'))
    expect(seen).toBeLessThan(normal)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/tokens`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write convert.ts**

```typescript
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function fromLinear(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return c * 255
}

export function toLab(hex: string): { L: number; a: number; b: number } {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / 95.047)
  const fy = f(y / 100)
  const fz = f(z / 108.883)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

export function deltaE(hexA: string, hexB: string): number {
  const x = toLab(hexA)
  const y = toLab(hexB)
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b)
}
```

- [ ] **Step 4: Write cvd.ts**

```typescript
import { hexToRgb, rgbToHex, toLinear, fromLinear } from './convert.js'

type Matrix = [number[], number[], number[]]

// Vienot 1999 dichromat simulation, applied in linear RGB.
const MATRICES: Record<string, Matrix> = {
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
}

export type CvdKind = keyof typeof MATRICES

export function simulate(kind: CvdKind, hex: string): string {
  const m = MATRICES[kind]
  if (!m) throw new Error(`unknown simulation: ${kind}`)
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  const out = m.map((row) => (row[0] ?? 0) * r + (row[1] ?? 0) * g + (row[2] ?? 0) * b)
  return rgbToHex(out.map(fromLinear) as [number, number, number])
}
```

- [ ] **Step 5: Write contrast.ts**

```typescript
import { hexToRgb, toLinear } from './convert.js'

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(hexA: string, hexB: string): number {
  const a = luminance(hexA)
  const b = luminance(hexB)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/tokens`
Expected: PASS, all colour tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/tokens/src/color packages/tokens/test/color.test.ts
git commit -m "feat(tokens): colour conversion, cvd simulation and contrast"
```

---

### Task 3: Primitive and semantic token layers

**Files:**
- Create: `packages/tokens/src/primitives.ts`, `packages/tokens/src/semantic.ts`
- Modify: `packages/tokens/src/index.ts`
- Test: `packages/tokens/test/layering.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `primitives` (nested record of raw values), `semantic: Record<Theme, Record<string, string>>` where every value is a primitive path such as `'blue.500'`, `type Theme = 'dark' | 'light'`, and `resolveSemantic(theme: Theme): Record<string, string>` returning resolved hex values

- [ ] **Step 1: Write the failing test**

`packages/tokens/test/layering.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { semantic, resolveSemantic, THEMES } from '../src/semantic.js'

describe('token layering', () => {
  // The layering rule is what keeps retheming a value swap instead of a rewrite.
  it.each(THEMES)('defines %s semantics only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(semantic[theme])) {
      expect(value, `${theme}.${name} must reference a primitive, not a literal`).not.toMatch(/^(#|rgb|hsl)/)
    }
  })

  it.each(THEMES)('resolves every %s semantic token to a hex value', (theme) => {
    for (const [name, value] of Object.entries(resolveSemantic(theme))) {
      expect(value, `${theme}.${name}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('defines the same token names in both themes', () => {
    expect(Object.keys(semantic.dark).sort()).toEqual(Object.keys(semantic.light).sort())
  })

  it('throws when a semantic token points at a missing primitive', () => {
    expect(() => resolveSemantic('dark', { broken: 'blue.999' })).toThrow(/blue\.999/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/tokens`
Expected: FAIL, `../src/semantic.js` not found.

- [ ] **Step 3: Write primitives.ts**

```typescript
export const primitives = {
  blue: {
    900: '#1E2A78',
    800: '#3730A3',
    700: '#312E81',
    500: '#4F8FF7',
    400: '#3B82F6',
    300: '#93D9F7',
    200: '#7DD3FC',
    100: '#BFD5F9',
  },
  amber: { 700: '#B45309', 500: '#F0A202' },
  slate: {
    950: '#0A0E17',
    900: '#0C111C',
    850: '#121926',
    800: '#0E1520',
    600: '#5A6880',
    500: '#7F8DA8',
    300: '#A9B6CE',
    200: '#E3E8EF',
    100: '#F5F7FB',
    50: '#FFFFFF',
    ink: '#0F172A',
    inkSoft: '#334155',
    paper: '#EAF0FB',
  },
  signal: { positive: '#5EC9A0', negative: '#E8846B', positiveDark: '#166F52', negativeDark: '#B4472C' },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px' },
  radius: { sm: '3px', md: '8px', lg: '11px', xl: '14px' },
  text: { xs: '10.5px', sm: '12px', md: '13px', lg: '18px', xl: '26px' },
  font: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  },
} as const
```

- [ ] **Step 4: Write semantic.ts**

```typescript
import { primitives } from './primitives.js'

export type Theme = 'dark' | 'light'
export const THEMES: Theme[] = ['dark', 'light']

export const semantic: Record<Theme, Record<string, string>> = {
  dark: {
    'surface-page': 'slate.950',
    'surface-card': 'slate.850',
    'surface-inset': 'slate.800',
    'surface-rail': 'slate.900',
    'text-primary': 'slate.paper',
    'text-secondary': 'slate.300',
    'text-muted': 'slate.500',
    'text-faint': 'slate.600',
    accent: 'blue.500',
    'accent-soft': 'blue.100',
    focus: 'blue.300',
    positive: 'signal.positive',
    negative: 'signal.negative',
  },
  light: {
    'surface-page': 'slate.100',
    'surface-card': 'slate.50',
    'surface-inset': 'slate.200',
    'surface-rail': 'slate.50',
    'text-primary': 'slate.ink',
    'text-secondary': 'slate.inkSoft',
    'text-muted': 'slate.600',
    'text-faint': 'slate.500',
    accent: 'blue.400',
    'accent-soft': 'blue.900',
    focus: 'blue.400',
    positive: 'signal.positiveDark',
    negative: 'signal.negativeDark',
  },
}

export function lookup(path: string): string {
  const [group, key] = path.split('.')
  const value = (primitives as Record<string, Record<string, string>>)[group ?? '']?.[key ?? '']
  if (!value) throw new Error(`unknown primitive: ${path}`)
  return value
}

export function resolveSemantic(theme: Theme, extra?: Record<string, string>): Record<string, string> {
  const source = extra ?? semantic[theme]
  return Object.fromEntries(Object.entries(source).map(([name, path]) => [name, lookup(path)]))
}
```

- [ ] **Step 5: Re-export from index.ts**

```typescript
export const VERSION = '0.1.0'
export { primitives } from './primitives.js'
export { semantic, resolveSemantic, lookup, THEMES, type Theme } from './semantic.js'
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/tokens`
Expected: PASS, layering tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/tokens/src packages/tokens/test/layering.test.ts
git commit -m "feat(tokens): primitive and semantic layers for both themes"
```

---

### Task 4: Chart tokens and the accessibility suite

**Files:**
- Create: `packages/tokens/src/chart.ts`
- Modify: `packages/tokens/src/index.ts`
- Test: `packages/tokens/test/accessibility.test.ts`

**Interfaces:**
- Consumes: `resolveSemantic`, `lookup`, `deltaE`, `simulate`, `contrast`
- Produces: `chartTokens: Record<Theme, Record<string, string>>` including `stage-deep`, `stage-light`, `stage-rem`, `stage-awake`, `grid`, `axis`, `band-baseline`, `state-excluded`, `state-no-data`; `resolveChart(theme: Theme): Record<string, string>`; `STAGE_KEYS: readonly string[]`

This task implements the spec rule that palette accessibility is a test rather than a review. A future colour change that breaks it fails the build.

- [ ] **Step 1: Write the failing test**

`packages/tokens/test/accessibility.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveChart, STAGE_KEYS } from '../src/chart.js'
import { resolveSemantic } from '../src/semantic.js'
import { deltaE } from '../src/color/convert.js'
import { simulate, type CvdKind } from '../src/color/cvd.js'
import { contrast } from '../src/color/contrast.js'
import { THEMES } from '../src/semantic.js'

const CVD: CvdKind[] = ['deuteranopia', 'protanopia', 'tritanopia']
const MIN_NORMAL = 25
const MIN_SIMULATED = 18

function pairs(values: string[]): [string, string][] {
  return values.flatMap((a, i) => values.slice(i + 1).map((b) => [a, b] as [string, string]))
}

describe.each(THEMES)('%s palette accessibility', (theme) => {
  const chart = resolveChart(theme)
  const stages = STAGE_KEYS.map((k) => chart[k]!)
  const s = resolveSemantic(theme)

  it('separates the sleep stages in normal vision', () => {
    for (const [a, b] of pairs(stages)) {
      expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_NORMAL)
    }
  })

  it.each(CVD)('keeps the sleep stages separable under %s', (kind) => {
    for (const [a, b] of pairs(stages.map((hex) => simulate(kind, hex)))) {
      expect(deltaE(a, b), `${a} vs ${b} under ${kind}`).toBeGreaterThanOrEqual(MIN_SIMULATED)
    }
  })

  it('meets WCAG contrast for text on cards', () => {
    expect(contrast(s['text-primary']!, s['surface-card']!)).toBeGreaterThanOrEqual(7)
    expect(contrast(s['text-secondary']!, s['surface-card']!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(s['text-muted']!, s['surface-card']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('meets non-text contrast for the accent on cards', () => {
    expect(contrast(s.accent!, s['surface-card']!)).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/tokens`
Expected: FAIL, `../src/chart.js` not found.

- [ ] **Step 3: Write chart.ts**

```typescript
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
    'state-no-data': 'slate.800',
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
    'state-no-data': 'slate.200',
  },
}

export function resolveChart(theme: Theme): Record<string, string> {
  return Object.fromEntries(Object.entries(chartTokens[theme]).map(([k, v]) => [k, lookup(v)]))
}
```

- [ ] **Step 4: Export from index.ts**

Add to `packages/tokens/src/index.ts`:

```typescript
export { chartTokens, resolveChart, STAGE_KEYS } from './chart.js'
```

- [ ] **Step 5: Run the accessibility suite**

Run: `pnpm vitest run packages/tokens`
Expected: PASS. If a pair falls below threshold, adjust the primitive it points at until it passes. Do not lower the threshold, and do not skip the test.

- [ ] **Step 6: Prove the guard actually guards**

Temporarily change `stage-rem` in the dark theme to `blue.500` so it duplicates `stage-light`, run the suite, and confirm it fails with a readable message naming the two colours. Then revert.

Run: `pnpm vitest run packages/tokens`
Expected: FAIL naming the duplicate pair, then PASS after reverting.

- [ ] **Step 7: Commit**

```bash
git add packages/tokens/src/chart.ts packages/tokens/src/index.ts packages/tokens/test/accessibility.test.ts
git commit -m "feat(tokens): chart tokens with enforced colour blindness and contrast checks"
```

---

### Task 5: CSS emitter

**Files:**
- Create: `packages/tokens/src/emit.ts`, `packages/tokens/scripts/build-css.ts`
- Modify: `packages/tokens/package.json`
- Test: `packages/tokens/test/emit.test.ts`

**Interfaces:**
- Consumes: `resolveSemantic`, `resolveChart`, `primitives`
- Produces: `emitCss(): string` returning a stylesheet with `:root` holding dark values and `[data-theme='light']` overriding them; a `pnpm --filter @vitals/tokens build:css` script writing `apps/web/src/theme.generated.css`

- [ ] **Step 1: Write the failing test**

`packages/tokens/test/emit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { emitCss } from '../src/emit.js'

describe('css emitter', () => {
  const css = emitCss()

  it('defines dark values on :root', () => {
    expect(css).toMatch(/:root\s*\{/)
    expect(css).toContain('--surface-card: #121926;')
    expect(css).toContain('--chart-stage-deep: #3730A3;')
  })

  it('overrides only the semantic layer for the light theme', () => {
    expect(css).toMatch(/\[data-theme='light'\]\s*\{/)
    expect(css).toContain('--surface-card: #FFFFFF;')
  })

  it('emits spacing and type scales', () => {
    expect(css).toContain('--space-4: 16px;')
    expect(css).toContain('--text-xl: 26px;')
  })

  it('records that the file is generated', () => {
    expect(css.startsWith('/* generated by @vitals/tokens')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/tokens`
Expected: FAIL, `../src/emit.js` not found.

- [ ] **Step 3: Write emit.ts**

```typescript
import { primitives } from './primitives.js'
import { resolveSemantic } from './semantic.js'
import { resolveChart } from './chart.js'

function block(selector: string, lines: string[]): string {
  return `${selector} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}\n`
}

function scales(): string[] {
  return [
    ...Object.entries(primitives.space).map(([k, v]) => `--space-${k}: ${v};`),
    ...Object.entries(primitives.radius).map(([k, v]) => `--radius-${k}: ${v};`),
    ...Object.entries(primitives.text).map(([k, v]) => `--text-${k}: ${v};`),
    `--font-sans: ${primitives.font.sans};`,
    `--font-mono: ${primitives.font.mono};`,
  ]
}

function themeLines(theme: 'dark' | 'light'): string[] {
  return [
    ...Object.entries(resolveSemantic(theme)).map(([k, v]) => `--${k}: ${v};`),
    ...Object.entries(resolveChart(theme)).map(([k, v]) => `--chart-${k}: ${v};`),
  ]
}

export function emitCss(): string {
  return (
    '/* generated by @vitals/tokens, do not edit by hand */\n' +
    block(':root', [...scales(), ...themeLines('dark')]) +
    block("[data-theme='light']", themeLines('light'))
  )
}
```

- [ ] **Step 4: Write the build script**

`packages/tokens/scripts/build-css.ts`:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { emitCss } from '../src/emit.js'

const out = new URL('../../../apps/web/src/theme.generated.css', import.meta.url)
mkdirSync(dirname(out.pathname), { recursive: true })
writeFileSync(out, emitCss())
console.log('wrote', out.pathname)
```

Add to `packages/tokens/package.json`:

```json
"scripts": { "build:css": "node --experimental-strip-types scripts/build-css.ts" }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/tokens`
Expected: PASS, four emitter tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/tokens
git commit -m "feat(tokens): emit css custom properties for both themes"
```

---

### Task 6: Web app shell

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/app.css` (`main.tsx` is written in Task 10, once there are pages for it to mount)
- Create: `apps/web/src/components/Sidebar.tsx`, `ControlRow.tsx`, `Card.tsx`, `StatTile.tsx`, `EmptyState.tsx`
- Test: `apps/web/test/no-raw-color.test.ts`

**Interfaces:**
- Consumes: `apps/web/src/theme.generated.css` from Task 5
- Produces: `<Sidebar active="dashboard" />`, `<ControlRow range="month" label="July 2026" sources="2/2" syncedAgo="4 min ago" />`, `<Card span={3} label="Steps">`, `<StatTile label value unit basis delta />`, `<EmptyState title detail />`

- [ ] **Step 1: Write the failing test**

`apps/web/test/no-raw-color.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const ALLOWED = ['theme.generated.css', 'fixtures']
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

describe('colour discipline', () => {
  // Components must reach for semantic tokens so a theme change stays a value swap.
  it('has no literal colours outside the generated stylesheet', () => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.some((a) => f.includes(a)))
      .filter((f) => COLOR.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web`
Expected: FAIL, `apps/web/src` does not exist.

- [ ] **Step 3: Scaffold the app**

`apps/web/package.json`:

```json
{
  "name": "@vitals/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0", "echarts": "^5.5.0" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.0", "vite": "^5.4.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" }
}
```

`apps/web/vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()] })
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vitals</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM"] }, "include": ["src", "test"] }
```

- [ ] **Step 4: Write app.css using only tokens**

```css
@import './theme.generated.css';

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--surface-page);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.layout { display: flex; min-height: 100vh; }

.rail { width: 186px; flex: none; background: var(--surface-rail); padding: var(--space-4) var(--space-3); }
.rail-group { font-size: 9px; letter-spacing: .15em; text-transform: uppercase; color: var(--text-faint); padding: var(--space-3) var(--space-3) var(--space-1); }
.rail-item { display: flex; align-items: center; gap: var(--space-2); padding: 7px var(--space-3); border-radius: 7px; font-size: var(--text-sm); color: var(--text-secondary); }
.rail-item[aria-current='page'] { background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent-soft); font-weight: 600; }
.rail-item[aria-current='page'] .rail-icon { color: var(--accent); opacity: 1; }
.rail-icon { width: 13px; height: 13px; border-radius: var(--radius-sm); background: currentColor; opacity: .5; }

.main { flex: 1; padding: var(--space-5); min-width: 0; }
.grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--space-3); }
.card { background: var(--surface-card); border: 1px solid color-mix(in srgb, var(--text-primary) 7%, transparent); border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); min-width: 0; }

.label { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
.value { font-size: var(--text-xl); font-weight: 700; letter-spacing: -.02em; margin-top: var(--space-1); }
.basis { font-size: var(--text-xs); color: var(--text-muted); margin-top: var(--space-1); line-height: 1.4; }
.delta { font-size: var(--text-xs); padding: 2px 7px; border-radius: 20px; background: color-mix(in srgb, var(--text-primary) 6%, transparent); }
.delta[data-dir='up'] { color: var(--positive); }
.delta[data-dir='down'] { color: var(--negative); }
.empty { color: var(--text-muted); font-size: var(--text-sm); line-height: 1.5; padding: var(--space-4) 0 var(--space-1); }
.empty small { color: var(--text-faint); }

@media (max-width: 900px) { .grid > * { grid-column: span 12 !important; } }
```

- [ ] **Step 5: Write the components**

`Card.tsx`:

```tsx
export function Card({ span, children }: { span: number; children: React.ReactNode }) {
  return <section className="card" style={{ gridColumn: `span ${span}` }}>{children}</section>
}
```

`StatTile.tsx`:

```tsx
type Delta = { text: string; dir: 'up' | 'down' | 'flat' }

export function StatTile({ label, value, unit, basis, delta, children }: {
  label: string
  value: string
  unit?: string
  basis: string
  delta?: Delta
  children?: React.ReactNode
}) {
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">{label}</span>
        {delta && <span className="delta" data-dir={delta.dir}>{delta.text}</span>}
      </header>
      <div className="value">{value}{unit && <span style={{ fontSize: 'var(--text-lg)', color: 'var(--text-muted)' }}> {unit}</span>}</div>
      <p className="basis">{basis}</p>
      {children}
    </>
  )
}
```

`EmptyState.tsx`:

```tsx
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <p className="empty">{title}<br /><small>{detail}</small></p>
}
```

`Sidebar.tsx`:

```tsx
const GROUPS = [
  { label: 'Overview', items: [['dashboard', 'Dashboard']] },
  { label: 'Tracking', items: [['activity', 'Activity'], ['sleep', 'Sleep'], ['recovery', 'Recovery'], ['health', 'Health'], ['weight', 'Weight'], ['nutrition', 'Nutrition'], ['notes', 'Notes']] },
  { label: 'Resources', items: [['docs', 'Docs'], ['changelog', 'Changelog']] },
] as const

export function Sidebar({ active, onNavigate }: { active: string; onNavigate: (id: string) => void }) {
  return (
    <nav className="rail" aria-label="Sections">
      <div style={{ fontWeight: 700, padding: '4px 12px 16px' }}>Vitals</div>
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="rail-group">{g.label}</div>
          {g.items.map(([id, name]) => (
            <a key={id} className="rail-item" href={`#${id}`} aria-current={active === id ? 'page' : undefined}
               onClick={() => onNavigate(id)}>
              <i className="rail-icon" />{name}
            </a>
          ))}
        </div>
      ))}
    </nav>
  )
}
```

`ControlRow.tsx`:

```tsx
const RANGES = ['Day', 'Week', 'Month', '3 months', 'Year'] as const

export function ControlRow({ range, label, sources, syncedAgo }: {
  range: string
  label: string
  sources: string
  syncedAgo: string
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', background: 'var(--surface-inset)', borderRadius: 'var(--radius-md)', padding: 2 }}>
        {RANGES.map((r) => (
          <span key={r} className="basis" style={{ padding: '4px 10px', borderRadius: 6, margin: 0,
            background: r === range ? 'var(--surface-card)' : undefined,
            color: r === range ? 'var(--text-primary)' : undefined }}>{r}</span>
        ))}
      </div>
      <div className="basis" style={{ margin: 0, padding: '4px 10px' }}>&lsaquo; {label} &rsaquo;</div>
      <div className="basis" style={{ margin: 0, marginLeft: 'auto' }}>Sources {sources}</div>
      <div className="basis" style={{ margin: 0 }}>Download raw</div>
      <div className="basis" style={{ margin: 0 }}>Sync</div>
      <div className="basis" style={{ margin: 0, color: 'var(--text-faint)' }}>{syncedAgo}</div>
    </div>
  )
}
```

- [ ] **Step 6: Generate the stylesheet and run the guard test**

Run: `pnpm --filter @vitals/tokens build:css && pnpm vitest run apps/web`
Expected: PASS. If it fails, the offending file paths are listed. Replace each literal with a token.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): app shell built from semantic tokens only"
```

---

### Task 7: Chart token resolver

**Files:**
- Create: `apps/web/src/charts/tokens.ts`, `apps/web/src/charts/useChart.ts`
- Test: `apps/web/test/chart-tokens.test.ts`

**Interfaces:**
- Consumes: CSS custom properties emitted in Task 5
- Produces: `readChartTokens(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): ChartTokens` and `useChart(option, deps)` returning a ref callback that mounts an ECharts instance and re-renders on theme change

- [ ] **Step 1: Write the failing test**

`apps/web/test/chart-tokens.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web`
Expected: FAIL, `../src/charts/tokens.js` not found.

- [ ] **Step 3: Write tokens.ts**

```typescript
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
```

- [ ] **Step 4: Write useChart.ts**

```typescript
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { currentChartTokens, type ChartTokens } from './tokens.js'

export function useChart(build: (t: ChartTokens) => echarts.EChartsOption, height: number) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const chart = echarts.init(host.current, undefined, { renderer: 'svg' })
    const render = () => chart.setOption(build(currentChartTokens()), true)
    render()

    const observer = new MutationObserver(render)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      chart.dispose()
    }
  }, [build])

  return { host, style: { width: '100%', height } }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/web`
Expected: PASS, both resolver tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/charts apps/web/test/chart-tokens.test.ts
git commit -m "feat(web): resolve chart colours from tokens at render time"
```

---

### Task 8: Fixtures and the trend charts

**Files:**
- Create: `apps/web/src/fixtures/july.ts`
- Create: `apps/web/src/charts/Sparkline.tsx`, `apps/web/src/charts/HeartRateRange.tsx`
- Test: `apps/web/test/fixtures.test.ts`

**Interfaces:**
- Consumes: `useChart`, `ChartTokens`
- Produces: `july` fixture object with `days: DayRow[]` where `DayRow = {date: string, steps: number | null, hrMin: number | null, hrMean: number | null, hrMax: number | null, sleepMinutes: number | null, worn: boolean}`, plus `hypnogram`, `schedule`, `events`, `baselines`; `<Sparkline values={(number|null)[]} />`, `<HeartRateRange days={DayRow[]} baseline={{low, high}} annotations={Event[]} excluded={string[]} />`

- [ ] **Step 1: Write the failing test**

`apps/web/test/fixtures.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { july } from '../src/fixtures/july.js'

describe('july fixtures', () => {
  it('covers a full month', () => {
    expect(july.days).toHaveLength(31)
  })

  // Gap days must be null rather than zero so the UI can tell absence from a real zero.
  it('marks unworn days as null rather than zero', () => {
    const unworn = july.days.filter((d) => !d.worn)
    expect(unworn.length).toBeGreaterThan(0)
    for (const day of unworn) {
      expect(day.steps).toBeNull()
      expect(day.hrMean).toBeNull()
    }
  })

  it('is deterministic across imports', async () => {
    const again = (await import('../src/fixtures/july.js')).july
    expect(again.days).toEqual(july.days)
  })

  it('provides one night of stages and a month of schedule spans', () => {
    expect(july.hypnogram.length).toBeGreaterThan(10)
    expect(july.schedule).toHaveLength(31)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web`
Expected: FAIL, fixtures not found.

- [ ] **Step 3: Write the fixtures**

```typescript
export type DayRow = {
  date: string
  steps: number | null
  hrMin: number | null
  hrMean: number | null
  hrMax: number | null
  sleepMinutes: number | null
  worn: boolean
}

export type Stage = 'deep' | 'light' | 'rem' | 'awake'

// Seeded so screenshots, tests and review all see identical data.
function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

const rnd = lcg(20260701)
const UNWORN = new Set([5, 6, 20, 24])

const days: DayRow[] = Array.from({ length: 31 }, (_, i) => {
  const date = `2026-07-${String(i + 1).padStart(2, '0')}`
  if (UNWORN.has(i + 1)) {
    return { date, steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: false }
  }
  const ill = i + 1 >= 26 && i + 1 <= 29
  const hrMean = Math.round(72 + Math.sin(i / 3.4) * 6 + rnd() * 6 + (ill ? 11 : 0))
  return {
    date,
    steps: Math.round(9000 + rnd() * 9000),
    hrMin: hrMean - Math.round(16 + rnd() * 6),
    hrMean,
    hrMax: hrMean + Math.round(48 + rnd() * 14),
    sleepMinutes: Math.round(415 + rnd() * 90 - (ill ? 35 : 0)),
    worn: true,
  }
})

const hypnogram: { stage: Stage; from: number; to: number }[] = [
  { stage: 'awake', from: 0, to: 14 }, { stage: 'light', from: 14, to: 58 },
  { stage: 'deep', from: 58, to: 92 }, { stage: 'light', from: 92, to: 120 },
  { stage: 'rem', from: 120, to: 156 }, { stage: 'light', from: 156, to: 196 },
  { stage: 'deep', from: 196, to: 226 }, { stage: 'light', from: 226, to: 262 },
  { stage: 'rem', from: 262, to: 302 }, { stage: 'light', from: 302, to: 338 },
  { stage: 'deep', from: 338, to: 362 }, { stage: 'light', from: 362, to: 404 },
  { stage: 'rem', from: 404, to: 446 }, { stage: 'light', from: 446, to: 470 },
  { stage: 'awake', from: 470, to: 488 },
]

const schedule = days.map((d, i) => {
  if (!d.worn) return { date: d.date, bed: null, wake: null, naps: [] as number[] }
  const bed = 23 * 60 + Math.round(rnd() * 70)
  return {
    date: d.date,
    bed,
    wake: bed + (d.sleepMinutes ?? 440) + Math.round(rnd() * 20),
    naps: rnd() > 0.86 ? [13 * 60 + Math.round(rnd() * 180)] : [],
  }
})

export const july = {
  days,
  hypnogram,
  schedule,
  baselines: { hrMean: { low: 68, high: 84 }, sleepMinutes: { low: 420, high: 480 } },
  excluded: ['2026-07-10'],
  events: [
    { date: '2026-07-26', endDate: '2026-07-29', type: 'illness', text: 'Head cold' },
    { date: '2026-07-18', type: 'travel', text: 'Flight to Chicago' },
    { date: '2026-07-12', type: 'alcohol', text: 'Three glasses of wine' },
  ],
}
```

- [ ] **Step 4: Write Sparkline.tsx**

```tsx
import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'

export function Sparkline({ values, height = 34 }: { values: (number | null)[]; height?: number }) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, scale: true },
    series: [{ type: 'line' as const, data: values, showSymbol: false, connectNulls: false,
      lineStyle: { width: 1.6, color: t.series } }],
  }), [values])

  const { host, style } = useChart(build, height)
  return <div ref={host} style={style} />
}
```

- [ ] **Step 5: Write HeartRateRange.tsx**

```tsx
import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { DayRow } from '../fixtures/july.js'

type Props = {
  days: DayRow[]
  baseline: { low: number; high: number }
  annotations: { date: string; text: string }[]
  excluded: string[]
}

export function HeartRateRange({ days, baseline, annotations, excluded }: Props) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 34, right: 12, top: 18, bottom: 24 },
    tooltip: { trigger: 'axis' as const, backgroundColor: t.surface, borderColor: t.grid, textStyle: { color: t.muted } },
    xAxis: { type: 'category' as const, data: days.map((d) => d.date.slice(8)),
      axisLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.axis, fontSize: 9 } },
    yAxis: { type: 'value' as const, scale: true, splitLine: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.axis, fontSize: 9 } },
    series: [
      { name: 'min', type: 'line' as const, data: days.map((d) => d.hrMin), showSymbol: false, connectNulls: false,
        lineStyle: { opacity: 0 }, stack: 'range', areaStyle: { opacity: 0 } },
      { name: 'range', type: 'line' as const, data: days.map((d) => (d.hrMax !== null && d.hrMin !== null ? d.hrMax - d.hrMin : null)),
        showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 }, stack: 'range',
        areaStyle: { color: t.stageLight, opacity: 0.22 } },
      { name: 'mean', type: 'line' as const, data: days.map((d) => d.hrMean), showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.9, color: t.series },
        markArea: { silent: true, itemStyle: { color: t.band, opacity: 0.5 },
          data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] },
        markPoint: { symbolSize: 7, itemStyle: { color: t.excluded },
          data: excluded.map((date) => ({ name: 'excluded', xAxis: date.slice(8), yAxis: 0 })) },
        markLine: { symbol: 'circle', lineStyle: { color: t.stageAwake, type: 'dashed' as const },
          label: { color: t.stageAwake, fontSize: 9, formatter: (p: { name: string }) => p.name },
          data: annotations.map((a) => ({ name: a.text, xAxis: a.date.slice(8) })) } },
    ],
  }), [days, baseline, annotations, excluded])

  const { host, style } = useChart(build, 170)
  return <div ref={host} style={style} />
}
```

- [ ] **Step 6: Run the tests and the colour guard**

Run: `pnpm vitest run`
Expected: PASS, including `no-raw-color` which now scans the new chart files.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/fixtures apps/web/src/charts apps/web/test/fixtures.test.ts
git commit -m "feat(web): deterministic fixtures, sparkline and heart rate range chart"
```

---

### Task 9: Sleep and activity charts

**Files:**
- Create: `apps/web/src/charts/Hypnogram.tsx`, `apps/web/src/charts/SleepSchedule.tsx`, `apps/web/src/charts/ActivityHeatmap.tsx`
- Test: `apps/web/test/stage-colors.test.ts`

**Interfaces:**
- Consumes: `useChart`, `ChartTokens`, `july` fixtures
- Produces: `<Hypnogram segments={july.hypnogram} />`, `<SleepSchedule nights={july.schedule} />`, `<ActivityHeatmap days={DayRow[]} />`, and `stageColor(stage: Stage, t: ChartTokens): string`

- [ ] **Step 1: Write the failing test**

`apps/web/test/stage-colors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { stageColor } from '../src/charts/Hypnogram.js'
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web`
Expected: FAIL, `Hypnogram` not found.

- [ ] **Step 3: Write Hypnogram.tsx**

```tsx
import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'

const LANES: Stage[] = ['awake', 'rem', 'light', 'deep']

export function stageColor(stage: Stage, t: ChartTokens): string {
  return { deep: t.stageDeep, light: t.stageLight, rem: t.stageRem, awake: t.stageAwake }[stage]
}

export function Hypnogram({ segments, startLabel }: {
  segments: { stage: Stage; from: number; to: number }[]
  startLabel: string
}) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 46, right: 12, top: 10, bottom: 24 },
    xAxis: { type: 'value' as const, min: 0, max: segments.at(-1)?.to ?? 480,
      axisLabel: { color: t.axis, fontSize: 9, formatter: (v: number) => `${Math.floor(v / 60)}h` },
      splitLine: { lineStyle: { color: t.grid } } },
    yAxis: { type: 'category' as const, data: [...LANES].reverse(),
      axisLabel: { color: t.axis, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'custom' as const,
      renderItem: (_p: unknown, api: { value: (i: number) => number; coord: (v: [number, number]) => number[]; size: (v: [number, number]) => number[] }) => {
        const stage = LANES[LANES.length - 1 - api.value(2)] ?? 'light'
        const start = api.coord([api.value(0), api.value(2)])
        const end = api.coord([api.value(1), api.value(2)])
        const height = (api.size([0, 1])[1] ?? 20) * 0.45
        return {
          type: 'rect',
          shape: { x: start[0] ?? 0, y: (start[1] ?? 0) - height / 2, width: (end[0] ?? 0) - (start[0] ?? 0), height },
          style: { fill: stageColor(stage as Stage, t) },
        }
      },
      encode: { x: [0, 1], y: 2 },
      data: segments.map((s) => [s.from, s.to, LANES.length - 1 - LANES.indexOf(s.stage)]),
    }],
    graphic: [{ type: 'text' as const, left: 46, top: 0, style: { text: startLabel, fill: t.muted, fontSize: 9 } }],
  }), [segments, startLabel])

  const { host, style } = useChart(build, 130)
  return <div ref={host} style={style} />
}
```

- [ ] **Step 4: Write SleepSchedule.tsx**

```tsx
import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'

type Night = { date: string; bed: number | null; wake: number | null; naps: number[] }

export function SleepSchedule({ nights }: { nights: Night[] }) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 40, right: 12, top: 12, bottom: 24 },
    xAxis: { type: 'category' as const, data: nights.map((n) => n.date.slice(8)),
      axisLabel: { color: t.axis, fontSize: 9, interval: 4 }, axisLine: { lineStyle: { color: t.grid } } },
    yAxis: { type: 'value' as const, min: 18 * 60, max: 42 * 60, inverse: false,
      axisLabel: { color: t.axis, fontSize: 9, formatter: (v: number) => `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:00` },
      splitLine: { lineStyle: { color: t.grid } } },
    series: [
      { type: 'custom' as const,
        renderItem: (params: { dataIndex: number }, api: { value: (i: number) => number; coord: (v: [number, number]) => number[] }) => {
          const night = nights[params.dataIndex]
          if (!night || night.bed === null || night.wake === null) return { type: 'group' as const, children: [] }
          const top = api.coord([api.value(0), night.bed])
          const bottom = api.coord([api.value(0), night.wake])
          return {
            type: 'line',
            shape: { x1: top[0] ?? 0, y1: top[1] ?? 0, x2: bottom[0] ?? 0, y2: bottom[1] ?? 0 },
            style: { stroke: t.stageLight, lineWidth: 5, lineCap: 'round' },
          }
        },
        encode: { x: 0 },
        data: nights.map((n, i) => [i, n.bed ?? 0]) },
      { type: 'scatter' as const, symbolSize: 6, itemStyle: { color: t.stageAwake },
        data: nights.flatMap((n, i) => n.naps.map((nap) => [i, nap])) },
    ],
  }), [nights])

  const { host, style } = useChart(build, 150)
  return <div ref={host} style={style} />
}
```

- [ ] **Step 5: Write ActivityHeatmap.tsx**

```tsx
import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { DayRow } from '../fixtures/july.js'

export function ActivityHeatmap({ days }: { days: DayRow[] }) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 30, right: 12, top: 10, bottom: 20 },
    tooltip: { backgroundColor: t.surface, borderColor: t.grid, textStyle: { color: t.muted } },
    xAxis: { type: 'category' as const, data: days.map((_, i) => Math.floor(i / 7)),
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } },
    yAxis: { type: 'category' as const, data: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
      axisLabel: { color: t.axis, fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    visualMap: { min: 0, max: 18000, show: false, inRange: { color: [t.band, t.stageLight, t.stageRem] } },
    series: [{
      type: 'heatmap' as const,
      data: days.map((d, i) => [Math.floor(i / 7), i % 7, d.steps]),
      itemStyle: { borderRadius: 2, borderWidth: 1, borderColor: t.surface },
      emphasis: { itemStyle: { borderColor: t.axis } },
    }],
  }), [days])

  const { host, style } = useChart(build, 110)
  return <div ref={host} style={style} />
}
```

Days with `steps: null` render as gaps because ECharts skips null values in a heatmap, which is the behaviour the spec requires: absent, not zero.

- [ ] **Step 6: Run the full suite**

Run: `pnpm vitest run`
Expected: PASS across both packages, including the colour guard.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/charts apps/web/test/stage-colors.test.ts
git commit -m "feat(web): hypnogram, sleep schedule and activity heatmap"
```

---

### Task 10: Reference pages and the chart styling specification

**Files:**
- Create: `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/pages/Sleep.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `docs/superpowers/design/chart-styling.md`
- Create: `apps/web/README.md`

**Interfaces:**
- Consumes: every component and chart from Tasks 6 to 9
- Produces: a running reference app at `pnpm dev`, and the written chart styling specification that M3 implements against

Invoke the `frontend-design` skill before writing the pages and the `dataviz` skill before finalising chart form choices.

- [ ] **Step 1: Write main.tsx with a theme switch for review purposes**

```tsx
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Dashboard } from './pages/Dashboard.js'
import { Sleep } from './pages/Sleep.js'
import './app.css'

function App() {
  const [page, setPage] = useState('dashboard')
  return (
    <div className="layout">
      <Sidebar active={page} onNavigate={setPage} />
      <main className="main">{page === 'sleep' ? <Sleep /> : <Dashboard />}</main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 2: Write Dashboard.tsx**

Compose: `ControlRow`, four `StatTile` cards with `Sparkline`, a `HeartRateRange` card spanning 8 columns, an insight card spanning 4 with the recovery list, `Hypnogram` spanning 7, `SleepSchedule` spanning 5, `ActivityHeatmap` spanning 8, and two `EmptyState` cards.

Every tile states its basis, taken from the fixtures rather than hardcoded prose:

```tsx
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { july } from '../fixtures/july.js'

const worn = july.days.filter((d) => d.worn)
const totalSteps = worn.reduce((sum, d) => sum + (d.steps ?? 0), 0)

export function Dashboard() {
  return (
    <>
      <h1 style={{ fontSize: 'var(--text-lg)', margin: '0 0 var(--space-3)' }}>Dashboard</h1>
      <ControlRow range="Month" label="July 2026" sources="2/2" syncedAgo="4 min ago" />
      <div className="grid">
        <Card span={3}>
          <StatTile label="Steps" value={totalSteps.toLocaleString('en-GB')}
            basis={`sum, ${worn.length} of ${july.days.length} days, ${july.days.length - worn.length} days not worn`}
            delta={{ text: 'up 9%', dir: 'up' }}>
            <Sparkline values={july.days.map((d) => d.steps)} />
          </StatTile>
        </Card>
        {/* remaining tiles follow the same shape: value, basis, delta, sparkline */}
        <Card span={8}>
          <span className="label">Heart rate</span>
          <p className="basis">daily minimum, mean and maximum, shaded band is the 60 day baseline</p>
          <HeartRateRange days={july.days} baseline={july.baselines.hrMean}
            annotations={july.events.map((e) => ({ date: e.date, text: e.text }))} excluded={july.excluded} />
        </Card>
        <Card span={5}>
          <span className="label">Naps</span>
          <EmptyState title="No naps detected in July."
            detail={`Device was worn on ${worn.length} of ${july.days.length} days, so this is a real absence rather than missing data.`} />
        </Card>
      </div>
    </>
  )
}
```

Complete the remaining tiles and cards in the same shape.

- [ ] **Step 3: Write Sleep.tsx**

A day view: last night tile, `Hypnogram` with per stage totals in a legend, nap empty state, and the month `SleepSchedule` beneath, each card stating its basis.

- [ ] **Step 4: Run the app and check both themes**

Run: `pnpm --filter @vitals/tokens build:css && pnpm dev`
Then in the browser console: `document.documentElement.dataset.theme = 'light'`
Expected: every surface, text colour and chart series updates with no reload and no missing colours. If a chart keeps its dark colours, it is reading tokens once rather than at render time, which Task 7's `MutationObserver` exists to prevent.

- [ ] **Step 5: Write docs/superpowers/design/chart-styling.md**

Record, with the values now in code: grid and axis treatment, tick density, series stroke widths, the baseline band, tooltip styling, the basis line convention, empty state wording patterns, the excluded point treatment, gap rendering per chart type, the stage colour mapping, and the rule that charts read tokens at render time. This document plus `packages/tokens` is what M3 implements against.

- [ ] **Step 6: Write apps/web/README.md**

```markdown
# @vitals/web

Reference pages for the visual direction. Fixtures only, no data layer, no network.

    pnpm --filter @vitals/tokens build:css
    pnpm dev

Colours come from `theme.generated.css`. Never write a literal colour in this package:
`apps/web/test/no-raw-color.test.ts` fails the build if you do. To change a colour, edit
`packages/tokens` and regenerate.
```

- [ ] **Step 7: Run everything and commit**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web docs/superpowers/design/chart-styling.md
git commit -m "feat(web): dashboard and sleep reference pages with styling spec"
```

---

## Self-review notes

**Spec coverage.** Section 11 UI conventions map to Tasks 6, 8 and 10 (basis lines in `StatTile`, empty states in `EmptyState`, card level controls in `ControlRow`, no leading stripe in `app.css`). Section 17 track D1 deliverables map to Tasks 3 to 5 (tokens both themes), 10 (chart styling spec, two reference pages). Section 19 conventions are in Global Constraints and enforced by review. Section 16 offline is satisfied by the system font stack and the absence of any runtime fetch, verified because the app has no network code at all.

**Deferred to M3 deliberately:** responsive behaviour beyond the single 900px breakpoint, keyboard navigation and focus states, real routing, and icons. D1 answers what it should look like, not how the production app is wired.

**Known gap to raise at execution time:** `HeartRateRange` uses a stacked area to draw the min to max band, which is the standard ECharts approach but makes the tooltip report the stacked delta rather than the maximum. If the tooltip reads wrong in Task 8 Step 6, add a `tooltip.formatter` that reconstructs the true values from `july.days` rather than reworking the series.
