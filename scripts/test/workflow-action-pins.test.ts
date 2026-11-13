import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('../../', import.meta.url)
const WORKFLOWS = readdirSync(new URL('.github/workflows/', root))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => `.github/workflows/${name}`)
describe('every workflow runs pinned actions', () => {
  it('finds the workflow files', () => {
    expect(WORKFLOWS.length).toBeGreaterThan(0)
  })
  it.each(WORKFLOWS)('%s pins every action to a commit', (path) => {
    const text = readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n')
    const uses = [...text.matchAll(/^\s+(?:- )?uses: (\S+)@(\S+)(.*)$/gm)]
    const mentions = text.split('\n').filter((line) => line.includes('uses:')).length
    expect(uses.length, `${path}: a uses: line did not parse`).toBe(mentions)
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
