import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The release workflow's ordering is load bearing and nothing else checks it. Release Please
// writes the release as a draft, and a draft carries no git tag until it is published, so the
// step that publishes it is what makes the release exist. Everything that could fail has to come
// before that step: a release pointing at an image that never reached the registry looks like the
// tag succeeded, and sends the first person following the README to a 404.
const yaml = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const lines = yaml.split(/\r?\n/)

// The publish job only. Scoping matters now that the file has two jobs: a line based search
// across the whole file would happily compare a step in one against a step in the other.
const publishSteps = (() => {
  const start = lines.findIndex(line => /^ {2}publish:/.test(line))
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end))
    .filter(line => /^ {6}- (name|uses|run|id):/.test(line))
    .map(line => line.replace(/^ {6}- (name|uses|run|id):\s*/, ''))
})()

const indexOf = (needle: string) => publishSteps.findIndex(step => step.includes(needle))

describe('the release workflow', () => {
  it('parses out the publish job it is asserting against', () => {
    // Without this every assertion below passes vacuously on -1 === -1 if the file's shape moves
    // and the parse quietly returns nothing.
    expect(publishSteps.length).toBeGreaterThan(5)
  })

  it('publishes the release only after the image is pushed', () => {
    const push = indexOf('Push both architectures')
    const release = indexOf('Publish the release')
    expect(push).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThan(push)
  })

  it('boots both architectures before pushing either', () => {
    const push = indexOf('Push both architectures')
    for (const arch of ['haelan:release-amd64', 'haelan:release-arm64']) {
      const boot = publishSteps.findIndex(s => s.includes('check-image-boots.sh') && s.includes(arch))
      expect(boot).toBeGreaterThanOrEqual(0)
      expect(boot).toBeLessThan(push)
    }
  })

  it('runs the test suite before anything is pushed', () => {
    // Both indices asserted present before they are compared. A missing step makes indexOf
    // return -1, and -1 is less than every real index, so the ordering assertion alone would
    // have reported success for a workflow that had stopped running the suite at all.
    const test = indexOf('pnpm test')
    const push = indexOf('Push both architectures')
    expect(test).toBeGreaterThanOrEqual(0)
    expect(push).toBeGreaterThanOrEqual(0)
    expect(test).toBeLessThan(push)
  })

  it('only publishes when Release Please cut a release', () => {
    // Without the guard every push to master would build and push an image over `latest`, since
    // the workflow's trigger is a branch now rather than a tag.
    expect(yaml).toContain("if: needs.release-please.outputs.released == 'true'")
  })

  it('asks metadata-action for the bare version, never the tag', () => {
    // metadata-action parses the value as semver and emits nothing when it cannot, so feeding it
    // `v1.2.3` produces an image carrying only `latest` with the job still green.
    expect(yaml).toContain('value=${{ needs.release-please.outputs.version }}')
    expect(yaml).not.toContain('value=${{ needs.release-please.outputs.tag }}')
  })
})
