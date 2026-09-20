import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

// android-release-version.test.ts proves the arithmetic. This proves something the arithmetic test
// cannot: that a raw `node --experimental-strip-types` process, on the pinned version
// android-release.yml actually runs, can load this .mjs file and its static `.ts` import at all.
// Nothing else exercises that combination -- tools-doc-drift.test.ts calls generate-tools-doc.mjs's
// exported render() through vitest's own loader, and neither `pnpm check:enums` nor
// `pnpm docs:tools` is a CI step -- so without this test the exact command the workflow depends on
// has no coverage on any leg of the matrix.
function run(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'scripts/print-android-release-version.mjs', ...args], {
    encoding: 'utf8',
  })
}

describe('print-android-release-version.mjs, run the way the release workflow runs it', () => {
  it('prints exactly the two lines the workflow\'s >> "$GITHUB_OUTPUT" depends on', () => {
    const result = run(['android-v1.39.2'])
    expect(result.status).toBe(0)
    // The full line, not a substring: toContain('code=1039002') would still pass if the script
    // started emitting `code=1039002\r` or a third line, either of which would break the workflow's
    // GITHUB_OUTPUT parsing while this test stayed green.
    expect(result.stdout).toBe('name=1.39.2\ncode=1039002\n')
  })

  it('exits non-zero and prints nothing on stdout for a tag the function refuses', () => {
    const result = run(['not-a-tag'])
    expect(result.status).not.toBe(0)
    // Empty stdout is load-bearing, not incidental: android-release.yml's guard step fails the job
    // on an empty version output specifically because that is what distinguishes "the version step
    // never ran the function successfully" from "it did, and printed nothing else along with it."
    expect(result.stdout).toBe('')
  })

  it('exits non-zero when called with no tag at all', () => {
    const result = run([])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
  })
})
