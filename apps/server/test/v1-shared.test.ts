import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const V1_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../src/routes/v1')

// shared.ts exists because a bug fixed in one copy of a helper must not be able to survive in
// another. Two byte identical copies behave identically right up to the moment one of them is
// fixed, so no assertion about a response can tell them apart and only the source can: this reads
// the route files and refuses a second declaration of a helper shared.ts already exports.
// personQueryOf, requireString and optionalPositiveInt each had one, in four files that were
// written in the order the milestone's tasks landed rather than all at once.
const SHARED_HELPERS = [
  'personQueryOf',
  'requireString',
  'optionalPositiveInt',
  'metricsFrom',
  'requireBoundedRange',
  'sendHashed',
  'roundMetricValueOrNull',
  'roundSeriesResult',
] as const

function filesDeclaring(name: string): string[] {
  const declaration = new RegExp(String.raw`^(export )?function ${name}\b`, 'm')
  return readdirSync(V1_ROOT)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => declaration.test(readFileSync(join(V1_ROOT, file), 'utf8')))
}

describe('the versioned surface shares its helpers rather than copying them', () => {
  it.each(SHARED_HELPERS)('declares %s in shared.ts and nowhere else under routes/v1', (name) => {
    expect(filesDeclaring(name)).toEqual(['shared.ts'])
  })

  // roundMetricValue moved out of shared.ts into packages/core, because the MCP tools round with
  // it too and a tool should not import an HTTP route module to do so. The rule it was listed
  // under still holds, so it is split into its two halves: one declaration, in core, and none
  // under routes/v1 - shared.ts only re-exports it, so route files keep their import and no copy
  // can appear beside it.
  it('declares roundMetricValue in core and nowhere under routes/v1', () => {
    expect(filesDeclaring('roundMetricValue')).toEqual([])
    const core = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/src/derive/metrics.ts'), 'utf8')
    expect(core).toMatch(/^export function roundMetricValue\b/m)
  })

  it('re-exports roundMetricValue from @haelan/core in shared.ts', () => {
    const shared = readFileSync(join(V1_ROOT, 'shared.ts'), 'utf8')
    const imported = /import\s*\{[^}]*\broundMetricValue\b[^}]*\}\s*from\s*'@haelan\/core'/.test(shared)
    expect(imported).toBe(true)
    expect(shared).toMatch(/^export \{ roundMetricValue \}$/m)
  })
})
