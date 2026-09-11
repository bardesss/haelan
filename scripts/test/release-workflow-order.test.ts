import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The release workflow's step order is load bearing and nothing else checks it. Resolving the
// changelog section is a file read that costs milliseconds; pushing the image is irreversible and
// moves `latest`. When the read ran after the push -- as it did through v1.0.0 -- a tag with no
// changelog entry failed only once both architectures were public and `latest` already pointed at
// a version that had no release. The order below is the fix, and this pins it.
const steps = (() => {
  const yaml = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  return yaml
    .split(/\r?\n/)
    .filter(line => /^ {6}- (name|uses|run|id):/.test(line))
    .map(line => line.replace(/^ {6}- (name|uses|run|id):\s*/, ''))
})()

const indexOf = (needle: string) => steps.findIndex(step => step.includes(needle))

describe('the release workflow', () => {
  it('parses out the step list it is asserting against', () => {
    // Without this the assertions below pass vacuously on -1 === -1 if the shape of the file moves.
    expect(steps.length).toBeGreaterThan(5)
  })

  it('resolves the release notes before pushing the image', () => {
    const notes = indexOf('Resolve release notes')
    const push = indexOf('Push both architectures')
    expect(notes).toBeGreaterThanOrEqual(0)
    expect(push).toBeGreaterThanOrEqual(0)
    expect(notes).toBeLessThan(push)
  })

  it('creates the GitHub Release after pushing the image', () => {
    // The other half of the same decision: a release pointing at an image that never published
    // looks like the tag succeeded.
    const push = indexOf('Push both architectures')
    const release = indexOf('Create GitHub Release')
    expect(release).toBeGreaterThan(push)
  })

  it('boots both architectures before pushing either', () => {
    const push = indexOf('Push both architectures')
    for (const arch of ['haelan:release-amd64', 'haelan:release-arm64']) {
      const boot = steps.findIndex(step => step.includes('check-image-boots.sh') && step.includes(arch))
      expect(boot).toBeGreaterThanOrEqual(0)
      expect(boot).toBeLessThan(push)
    }
  })
})
