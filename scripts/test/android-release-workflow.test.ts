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
// Step labels in file order, for assertions about what comes after a given step rather than just
// what comes before it: "before" alone would not catch a step appended past the end of the job.
const stepLabels = [...yaml.matchAll(/- name: (.+)/g)].map(m => m[1])
const lines = yaml.replace(/\r\n/g, '\n').split('\n')
const jobBody = (name: string): string => {
  const start = lines.findIndex(line => new RegExp(`^ {2}${name}:`).test(line))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}
const topLevelPermissions = (): string[] => {
  const start = lines.findIndex(line => /^permissions:/.test(line))
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^\S/.test(line))
  return rest.slice(0, end).filter(line => /^ {2}[a-z-]+: /.test(line)).map(line => line.trim())
}

describe('the android release workflow', () => {
  it('tests, assembles and verifies before it creates the release', () => {
    for (const before of [
      'Unit tests',
      'Lint',
      'Assemble the signed APK',
      'Verify the APK is signed',
      'The APK carries the version from the tag',
    ]) {
      expect(at(before), `${before} must run before the release exists`).toBeLessThan(at('Create the release'))
    }
  })

  it('has nothing after the release is created', () => {
    // Stronger than "must run before the release": a step appended to the end of the job, after
    // Create the release, would pass every "before" assertion above while still running with the
    // release already public.
    const releaseIndex = stepLabels.indexOf('Create the release')
    expect(releaseIndex, 'Create the release step is missing').toBeGreaterThanOrEqual(0)
    expect(stepLabels.slice(releaseIndex + 1)).toEqual([])
  })

  it('restores the tag annotation before deriving the version from it', () => {
    // actions/checkout leaves a lightweight tag in the runner's clone, so --notes-from-tag falls
    // back to the commit message unless the annotation is fetched back before anything reads the
    // tag. It only has to run before the version step actually consumes $GITHUB_REF_NAME as a tag.
    expect(at('Restore the tag annotation')).toBeLessThan(at('Read the version from the tag'))
    expect(yaml).toContain('git fetch --force origin "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"')
  })

  it('refuses to build on an empty version output', () => {
    // Asserted on the condition text, not just the step's name and position: a step named "The
    // version outputs are not empty" that checked nothing would pass a name-only assertion, and
    // that is exactly the gap this guard exists to close for versionCode itself.
    const guard = at('The version outputs are not empty')
    expect(guard, 'the guard must run before the assemble step').toBeLessThan(at('Assemble the signed APK'))
    expect(yaml).toContain('if [ -z "${{ steps.version.outputs.name }}" ]')
    expect(yaml).toContain('if [ -z "${{ steps.version.outputs.code }}" ]')
  })

  it('hands the derived version to Gradle under the names build.gradle.kts reads', () => {
    // The static half of the guarantee: the read-back test below proves the finished APK carries
    // the right value, and this proves the wiring that gets it there is spelled the way the
    // Gradle side expects.
    expect(yaml).toContain('HAELAN_APP_VERSION: ${{ steps.version.outputs.name }}')
    expect(yaml).toContain('HAELAN_APP_VERSION_CODE: ${{ steps.version.outputs.code }}')
  })

  it('reads the version back out of the finished APK before the release is created', () => {
    // The only check in this pipeline that looks at the irreversible value after it has been
    // written, rather than at an intermediate output that merely feeds it.
    const readback = at('The APK carries the version from the tag')
    expect(readback, 'the read-back must run after the APK is assembled')
      .toBeGreaterThan(at('Assemble the signed APK'))
    expect(readback, 'the read-back must run before the release is created').toBeLessThan(at('Create the release'))
    expect(yaml).toContain('dump badging')
    // On the comparison itself, not merely on the outputs appearing somewhere in the file: both
    // also appear in the release title and the env: block, so a bare toContain on the output
    // expression alone would pass even if the read-back compared against nothing.
    expect(yaml).toContain('if [ "$FOUND_CODE" != "${{ steps.version.outputs.code }}" ]')
    expect(yaml).toContain('if [ "$FOUND_NAME" != "${{ steps.version.outputs.name }}" ]')
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

  it('tests and lints in a job that never sees the keystore', () => {
    const check = jobBody('check')
    const release = jobBody('release')
    expect(check, 'there is no check job').not.toBe('')
    expect(release).toMatch(/^ {4}needs: check$/m)
    expect(check).toContain('./gradlew testDebugUnitTest')
    expect(check).toContain('./gradlew lintDebug')
    expect(check).not.toContain('secrets.')
    expect(release).toContain('HAELAN_KEYSTORE_BASE64: ${{ secrets.HAELAN_KEYSTORE_BASE64 }}')
    expect(release).not.toContain('testDebugUnitTest')
    expect(release).not.toContain('lintDebug')
    expect(release, 'dependency install scripts must not run beside the keystore').not.toContain('pnpm install')
    expect(topLevelPermissions()).toEqual(['contents: read'])
    expect(release).toMatch(/^ {4}permissions:\n {6}contents: write$/m)
  })

  it('hands the generated palette from the check job to the release job', () => {
    expect(jobBody('check')).toMatch(/name: token-palette\n\s+path: apps\/android\/app\/build\/haelan-tokens\//)
    expect(jobBody('release')).toMatch(/name: token-palette\n\s+path: apps\/android\/app\/build\/haelan-tokens\//)
  })
  it('refuses an APK signed by any key but the release key', () => {
    const step = at('The APK is signed by the release key')
    expect(step).toBeGreaterThan(at('Verify the APK is signed'))
    expect(step).toBeLessThan(at('Create the release'))
    expect(yaml).toContain('--print-certs')
    expect(yaml).toContain('apps/android/release-signing-cert.sha256')
    expect(yaml).toContain('if [ "$FOUND" != "$EXPECTED" ]')
    const committed = readFileSync(new URL('../../apps/android/release-signing-cert.sha256', import.meta.url), 'utf8').trim()
    expect(committed, 'lowercase hex, no colons, as apksigner prints it').toMatch(/^[0-9a-f]{64}$/)
  })

  it('checks the Gradle distribution it downloads', () => {
    const props = readFileSync(new URL('../../apps/android/gradle/wrapper/gradle-wrapper.properties', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(props).toContain('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip')
    expect(props).toMatch(/^distributionSha256Sum=f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6$/m)
  })
})
