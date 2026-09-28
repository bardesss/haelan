import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { SEED_KINDS } from '../../packages/core/src/api/eventKinds.ts'

// The seed chips exist twice: in packages/core, which the server answers with and the web labels,
// and in the phone's LogSheetState, which decides which kinds it looks up a name for and offers
// as suggestions. A kind added to one list and not the other shows on the phone as its raw id, or
// never shows as a suggestion there. Nothing but this guard holds the two together, the same idiom
// as companion-stale-source-drift.test.ts: read the real Kotlin file rather than trust a comment.
const ANDROID_PATH = 'apps/android/app/src/main/java/com/haelan/android/glance/LogSheetState.kt'

function androidSeedKinds(): string[] {
  const source = readFileSync(new URL(`../../${ANDROID_PATH}`, import.meta.url), 'utf8')
  const match = /val SEED_KINDS = listOf\(([^)]*)\)/.exec(source)
  expect(match, `${ANDROID_PATH}: SEED_KINDS = listOf(...) not found - has the declaration moved or been renamed?`).not.toBeNull()
  return [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

describe('SEED_KINDS, one list spelled in two languages', () => {
  it('is the same kinds in the same order on the phone as in core', () => {
    expect(androidSeedKinds()).toEqual([...SEED_KINDS])
  })
})
