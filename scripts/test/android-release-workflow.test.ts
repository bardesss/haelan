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
    expect(yaml).toContain('git fetch --force origin "refs/tags/${TAG}:refs/tags/${TAG}"')
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
    // Long enough that re-running only the release job a day or two later still finds it.
    expect(jobBody('check')).toMatch(/^ {10}retention-days: 7$/m)
  })

  it('keeps the write token and the shared Gradle cache away from the signing build', () => {
    const release = jobBody('release')
    // A persisted token would sit in .git/config, readable by every build script Gradle runs.
    // Not pinned as the first key under `with:` any more, because `ref:` is there too now; what
    // matters is that this checkout carries it at all, whatever else it carries.
    expect(release).toMatch(/actions\/checkout@[0-9a-f]{40} # v\d+\n {8}with:\n(?: {10}\S.*\n)*? {10}persist-credentials: false$/m)
    // The default-branch cache is written by android.yml, whose job runs pnpm install lifecycle
    // scripts; restoring it here would hand that job's output to the build that holds the keystore.
    expect(release).toMatch(/gradle\/actions\/setup-gradle@[0-9a-f]{40} # v\d+\n {8}with:\n(?: {10}\S.*\n)*? {10}cache-disabled: true$/m)
  })
  it('refuses an APK signed by any key but the release key', () => {
    const step = at('The APK is signed by the release key')
    expect(step).toBeGreaterThan(at('Verify the APK is signed'))
    expect(step).toBeLessThan(at('Create the release'))
    expect(yaml).toContain('--print-certs')
    expect(yaml).toContain('apps/android/release-signing-cert.sha256')
    expect(yaml).toContain('if [ "$FOUND" != "$EXPECTED" ]')
    // Two empty strings compare equal, so a missing or blank cert file and an apksigner that
    // printed no digest would pass the comparison above.
    expect(yaml).toContain(`if ! echo "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$'; then`)
    expect(yaml).toContain('if [ "$SIGNERS" -eq 0 ]; then')
    expect(yaml.indexOf(`grep -Eq '^[0-9a-f]{64}$'`)).toBeLessThan(yaml.indexOf('if [ "$FOUND" != "$EXPECTED" ]'))
    expect(yaml.indexOf('if [ "$SIGNERS" -eq 0 ]; then')).toBeLessThan(yaml.indexOf('if [ "$FOUND" != "$EXPECTED" ]'))
    // Whatever the shape of the parse, more than one signing certificate has to stop the release
    // rather than pick one. android-release-signer-check.test.ts runs this step against recorded
    // apksigner output from both build-tools 36 and 37 and proves it does.
    expect(yaml).toContain('if [ "$SIGNERS" -gt 1 ]; then')
    const committed = readFileSync(new URL('../../apps/android/release-signing-cert.sha256', import.meta.url), 'utf8').trim()
    expect(committed, 'lowercase hex, no colons, as apksigner prints it').toMatch(/^[0-9a-f]{64}$/)
  })

  // A release that failed for a reason outside the APK used to have no way back: re-running a push
  // event uses the workflow file at the commit the tag points to, so a fix landed on master could
  // not reach it, and android-v0.12.0 sat unreleased for exactly that reason. The dispatch is the
  // way back. It also turns the tag into an argument, which is what the rest of this is about.
  it('can be dispatched for a tag, and builds that tag rather than the branch', () => {
    expect(yaml).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}\S.*\n)*? {8}required: true$/m)
    // One name, resolved once, for both triggers.
    expect(yaml).toMatch(/^env:\n {2}TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}$/m)
    // github.ref_name is the branch under a dispatch, so a step still reading it would test, build
    // and release master under whatever version the input named: a correctly signed APK carrying a
    // tree nobody tagged, and no later check could tell, because every one of them reads the same
    // wrong tag. Comments may discuss the name; no step may read it.
    const code = yaml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    expect(code).not.toContain('GITHUB_REF_NAME')
    // And the raw expression only where the fallback is being written, never at a point of use.
    const refName = code.split('\n').filter((line) => line.includes('github.ref_name'))
    expect(refName).toHaveLength(2)
    for (const line of refName) expect(line).toContain('inputs.tag ||')
    // Both jobs. The check job is what proves the tests and the lint, the release job is what
    // builds the APK, and either one defaulting to the branch would be about the wrong tree.
    expect(jobBody('check')).toContain('ref: ${{ env.TAG }}')
    expect(jobBody('release')).toContain('ref: ${{ env.TAG }}')
    // Two runs releasing one tag at once is the collision that matters. Keyed on github.ref, every
    // dispatch shared one group while a dispatch and a push of the same tag sat in different ones.
    expect(yaml).toMatch(/^ {2}group: android-release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}$/m)
  })

  it('refuses a bad or already released tag before it spends a runner on it', () => {
    const guard = at('The tag is an unreleased android-v tag')
    for (const after of ['Unit tests', 'Lint', 'Assemble the signed APK', 'Create the release']) {
      expect(guard, `the guard has to come before "${after}"`).toBeLessThan(at(after))
    }
    // In the check job: it runs first, and it holds no keystore.
    expect(jobBody('check')).toContain('- name: The tag is an unreleased android-v tag')
    // android-release-steps.test.ts runs this step's own shell against both refusals and the
    // accept; these two strings are what that test reads the verdict out of.
    expect(yaml).toContain('is not an android-v tag')
    expect(yaml).toContain('already has a release; its APK is not replaced')
  })

  it('checks the Gradle distribution it downloads', () => {
    const props = readFileSync(new URL('../../apps/android/gradle/wrapper/gradle-wrapper.properties', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(props).toContain('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip')
    expect(props).toMatch(/^distributionSha256Sum=f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6$/m)
  })
})
