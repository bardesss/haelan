import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// STALE_SOURCE_MS exists twice, once per language, because the phone and the server each decide
// on their own when a silent source stops holding a (type, source) minimum back. Nothing but this
// guard holds the two copies together. See scripts/test/cross-surface.test.ts and
// scripts/test/app-version-define.test.ts for the same idiom: read both real files rather than
// trusting a comment to keep them in step.
const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const SERVER_PATH = 'apps/server/src/routes/v1/companion.ts'
const ANDROID_PATH = 'apps/android/app/src/main/java/com/haelan/android/SyncCursors.kt'

/**
 * Pulls the millisecond value out of a `STALE_SOURCE_MS = <arithmetic>` declaration, tolerant of
 * a trailing `L` on every Kotlin long literal.
 *
 * Evaluated as arithmetic rather than compared as text: `14 * 24 * 60 * 60 * 1000` and
 * `14L * 24L * 60L * 60L * 1000L` are the same number spelled for two different type systems, and
 * a text diff would flag that spelling difference as though it were the drift this guard exists
 * to catch.
 */
function staleSourceMs(source: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(source)
  expect(match, `${label}: STALE_SOURCE_MS not found where this guard expects it - has the declaration moved or been renamed?`).not.toBeNull()
  const expr = match![1]!.replaceAll('L', '').trim()
  expect(expr, `${label}: STALE_SOURCE_MS's value '${match![1]}' is not plain digits and '*', so this guard cannot evaluate it safely`).toMatch(/^[\d\s*]+$/)
  // eslint-disable-next-line no-new-func -- expr is validated above to be only digits, whitespace and '*'
  return Function(`return (${expr})`)() as number
}

describe('STALE_SOURCE_MS, the same threshold spelled in two languages', () => {
  it('agrees between the server and the phone', () => {
    const server = staleSourceMs(
      read(SERVER_PATH),
      /export const STALE_SOURCE_MS = ([^\n]+)/,
      SERVER_PATH,
    )
    const android = staleSourceMs(
      read(ANDROID_PATH),
      /const val STALE_SOURCE_MS: Long = ([^\n]+)/,
      ANDROID_PATH,
    )

    expect(
      android,
      `${ANDROID_PATH}'s STALE_SOURCE_MS is ${android}ms; ${SERVER_PATH}'s is ${server}ms. `
      + 'They must be the same number of milliseconds. If the phone\'s threshold is SHORTER than '
      + 'the server\'s, the phone ages a source out of a sync minimum while the server still '
      + 'expects that source held back, reads a narrower window than the server believes it has '
      + 'covered, and silently loses readings - the exact bug this pair of constants exists to '
      + `prevent. Change whichever of the two files is now stale so both read ${server}ms.`,
    ).toBe(server)
  })
})
