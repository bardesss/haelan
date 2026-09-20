import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The same reasoning release-workflow-order.test.ts records for the server: everything that can
// fail has to come before the step that creates the release. A release that exists while its APK
// does not looks like the tag succeeded, and an Android release is worse than a container one,
// because the fix is a new version code rather than a re-run.
const yaml = readFileSync(new URL('../../.github/workflows/android-release.yml', import.meta.url), 'utf8')
const at = (label: string): number => {
  const found = yaml.indexOf(`- name: ${label}`)
  expect(found, `step "${label}" is missing`).toBeGreaterThan(-1)
  return found
}

describe('the android release workflow', () => {
  it('tests, assembles and verifies before it creates the release', () => {
    for (const before of ['Unit tests', 'Lint', 'Assemble the signed APK', 'Verify the APK is signed']) {
      expect(at(before), `${before} must run before the release exists`).toBeLessThan(at('Create the release'))
    }
  })

  it('verifies the signature after assembling and not before', () => {
    expect(at('Assemble the signed APK')).toBeLessThan(at('Verify the APK is signed'))
  })

  it('leaves release-please holding the repository\'s latest release', () => {
    // App releases interleave with server ones. Marking an app release latest would point every
    // reader of the repository at the app rather than at haelan itself.
    expect(yaml).toContain('--latest=false')
  })

  it('titles the release so the Obtainium filter can find it', () => {
    // Obtainium filters on the release title, not the tag, so the two are coupled: this title and
    // the ^Android regex in the README's button have to agree.
    expect(yaml).toContain('--title "Android ${{ steps.version.outputs.name }}"')
  })

  it('runs only on an android tag, never on a branch', () => {
    expect(yaml).toContain("tags: ['android-v*']")
    expect(yaml).not.toContain('branches:')
  })
})
