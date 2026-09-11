import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { render } from '../../../scripts/generate-tools-doc.mjs'

// A test rather than a script, deliberately, unlike scripts/check-enum-drift.mjs — that one is a
// script because, in its own words, "a test that needs the network is a test that fails on a
// train". This asks a question about the code and needs none: `render()` is the same function
// `pnpm docs:tools` calls to write TOOLS.md, so comparing its output against the checked-in file
// is comparing the catalogue against itself with nothing fetched and nothing spawned.
describe('TOOLS.md', () => {
  it('matches what generate-tools-doc.mjs renders from the catalogue that ships', () => {
    const checkedIn = readFileSync(new URL('../../../TOOLS.md', import.meta.url), 'utf8')

    expect(render()).toBe(checkedIn)
  })
})
