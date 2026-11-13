import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DATA_TYPES } from '../../packages/core/src/api/catalogue.ts'

// The phone cuts an upload on minute boundaries for exactly the types the server downsamples to
// a minute (downsampleToMinute), because the server aggregates each request's minute in
// isolation and a minute split over two requests is overwritten by its second half. The Kotlin
// set is a hand copy of the catalogue flag; this keeps the two from drifting.
const root = new URL('../../', import.meta.url)
const SYNC_ENGINE_PATH = 'apps/android/app/src/main/java/com/haelan/android/SyncEngine.kt'
const source = readFileSync(new URL(SYNC_ENGINE_PATH, root), 'utf8')

function kotlinMinuteAlignedIds(): string[] {
  const declared = /MINUTE_ALIGNED_TYPES\s*:\s*Set<String>\s*=\s*setOf\(([^)]*)\)/.exec(source)
  expect(declared, `${SYNC_ENGINE_PATH}: MINUTE_ALIGNED_TYPES = setOf(...) not found - has it moved or been renamed?`).not.toBeNull()
  return [...declared![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort()
}

describe('minute aligned upload types', () => {
  it('are exactly the catalogue types the server downsamples to a minute', () => {
    const catalogue = DATA_TYPES.filter((t) => t.downsampleToMinute === true).map((t) => t.id).sort()
    expect(kotlinMinuteAlignedIds()).toEqual(catalogue)
  })
})
