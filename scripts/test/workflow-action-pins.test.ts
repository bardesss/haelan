import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('../../', import.meta.url)
const WORKFLOWS = [
  '.github/workflows/android-release.yml',
  '.github/workflows/android-tag.yml',
  '.github/workflows/release.yml',
  '.github/workflows/pages.yml',
]
describe('workflows that hold a secret or a write token run pinned actions', () => {
  it.each(WORKFLOWS)('%s pins every action to a commit', (path) => {
    const text = readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n')
    const uses = [...text.matchAll(/^\s+(?:- )?uses: (\S+)@(\S+)(.*)$/gm)]
    expect(uses.length, `${path}: no uses: lines parsed`).toBeGreaterThan(0)
    for (const [line, action, ref, rest] of uses) {
      expect(ref, `${path}: '${line.trim()}' is pinned to a movable ref. Resolve it with `
        + `gh api repos/<owner>/<repo>/commits/${ref} --jq .sha and write ${action}@<sha> # ${ref}.`)
        .toMatch(/^[0-9a-f]{40}$/)
      expect(rest, `${path}: '${line.trim()}' needs a '# vN' comment so Dependabot and a reader know the version`)
        .toMatch(/^ # v\d+(\.\d+)*$/)
    }
  })
  it('keeps Dependabot updating those pins', () => {
    const dependabot = readFileSync(new URL('.github/dependabot.yml', root), 'utf8')
    expect(dependabot).toContain('package-ecosystem: github-actions')
  })
})
