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
  'roundMetricValue',
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
})
