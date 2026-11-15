import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, afterEach } from 'vitest'

// android-release-workflow.test.ts asserts that the release workflow's steps are present, ordered
// and shaped the way the plan described them. That is not the same fact as those steps working,
// and the difference cost a release: build-tools 37 relabelled `apksigner verify --print-certs`
// output from `Signer #1 certificate SHA-256 digest:` to one line per signature scheme
// (`V2 Signer: certificate SHA-256 digest:`), the step's sed matched nothing, and android-v0.12.0
// failed its own guard with "apksigner printed no SHA-256 digest for the APK's signer" after a
// successful build. Nothing shipped, and Obtainium went on offering 0.11.0 as the latest.
//
// So this file runs the steps' actual shell, lifted out of the workflow file, against recorded
// input. A string assertion about a sed pattern could not have caught that; only running it could.
const yaml = readFileSync(new URL('../../.github/workflows/android-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const VERSION = '0.12.0'
const TAG = `android-v${VERSION}`
const KEY = '4f067233b9a6181ec54847908f2efe968204b96c86c8c8166059ff7e88109a95'
const OTHER = '1111111111111111111111111111111111111111111111111111111111111111'

/** The `run:` body of a named step, dedented, with the workflow expressions it carries filled in. */
function stepScript(label: string): string {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.includes(`- name: ${label}`))
  expect(start, `step "${label}" is missing`).toBeGreaterThan(-1)
  // Bounded by the next step, so a step that loses its run block borrows a later step's rather
  // than silently testing the wrong shell.
  const after = lines.slice(start + 1)
  const next = after.findIndex((line) => /^ {6}- (name|uses):/.test(line))
  const within = next === -1 ? after : after.slice(0, next)
  const run = within.findIndex((line) => /^ {8}run: \|/.test(line))
  expect(run, `step "${label}" has no literal run block`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of within.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    body.push(line.slice(10))
  }
  const script = body.join('\n').replace(/\$\{\{ steps\.version\.outputs\.name \}\}/g, VERSION)
  // A workflow expression this harness does not know how to fill would reach bash as literal
  // `${{ ... }}` and expand to nothing, quietly turning every case below into a test of the wrong
  // script. Better to fail here, naming the step, than to go green against it.
  expect(script, `the step "${label}" grew a workflow expression this test does not substitute`).not.toContain('${{')
  return script
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-release-'))
  dirs.push(dir)
  return dir
}

/** bash leaves `status: null` and sets `error` when it never ran, which `not.toBe(0)` would read
 *  as the step refusing. Asserting it keeps every case about the step's own verdict. */
function verdict(result: ReturnType<typeof spawnSync>): { status: number | null, output: string } {
  expect(result.error, 'bash must be on PATH for these tests to mean anything').toBeUndefined()
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * Runs the signing check against a fake apksigner that prints `certs`. The fake lives where the
 * step looks for it - the highest-sorting build-tools directory under $ANDROID_HOME - so the
 * step's own discovery is exercised too, rather than bypassed.
 */
function runSignerCheck(certs: string, expected: string = KEY): { status: number | null, output: string } {
  const dir = workspace()
  mkdirSync(join(dir, 'apps', 'android'), { recursive: true })
  mkdirSync(join(dir, 'sdk', 'build-tools', '37.0.0'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'android', 'release-signing-cert.sha256'), `${expected}\n`)
  writeFileSync(join(dir, `haelan-${VERSION}.apk`), 'not really an apk')
  writeFileSync(join(dir, 'certs.txt'), certs)
  writeFileSync(join(dir, 'sdk', 'build-tools', '37.0.0', 'apksigner'), '#!/bin/sh\ncat "$(dirname "$0")/../../../certs.txt"\n')
  writeFileSync(join(dir, 'step.sh'), stepScript('The APK is signed by the release key'))

  return verdict(spawnSync('bash', ['-e', '-c', 'chmod +x "$ANDROID_HOME"/build-tools/*/apksigner && exec bash -e step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ANDROID_HOME: join(dir, 'sdk') },
  }))
}

/**
 * Runs the tag guard with `TAG` set and a `gh` that reports `released` as the one tag that already
 * has a release. `gh` is replaced with a shell function rather than a file on PATH so the test
 * does not depend on how this platform's bash resolves an added PATH entry.
 */
function runTagGuard(tag: string, released = ''): { status: number | null, output: string } {
  const dir = workspace()
  writeFileSync(join(dir, 'step.sh'), stepScript('The tag is an unreleased android-v tag'))
  // `gh release view <tag>` is $1 $2 $3; exit 0 means the release exists.
  const prelude = 'gh() { [ "$1" = "release" ] && [ "$2" = "view" ] && [ "$3" = "$RELEASED" ]; }\n. ./step.sh\n'
  writeFileSync(join(dir, 'harness.sh'), prelude)

  return verdict(spawnSync('bash', ['-e', 'harness.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, TAG: tag, RELEASED: released },
  }))
}

describe('the step that proves the APK carries the release key', () => {
  it('reads the digest out of build-tools 36 output', () => {
    const { status } = runSignerCheck([
      'Signer #1 certificate DN: CN=Haelan',
      `Signer #1 certificate SHA-256 digest: ${KEY}`,
      'Signer #1 certificate SHA-1 digest: 0000000000000000000000000000000000000000',
      'Signer #1 certificate MD5 digest: 00000000000000000000000000000000',
      '',
    ].join('\n'))
    expect(status).toBe(0)
  })

  // The regression itself: this is the shape the runner printed for android-v0.12.0.
  it('reads the digest out of build-tools 37 output', () => {
    const { status } = runSignerCheck([
      'V2 Signer: certificate DN: CN=Haelan',
      `V2 Signer: certificate SHA-256 digest: ${KEY}`,
      'V2 Signer: certificate SHA-1 digest: 0000000000000000000000000000000000000000',
      'V2 Signer: certificate MD5 digest: 00000000000000000000000000000000',
      '',
    ].join('\n'))
    expect(status).toBe(0)
  })

  // 37 prints one block per scheme. One key signing under both is one signer, not two, and must
  // not read as the multiple-signer failure.
  it('counts one key listed under several schemes as one signer', () => {
    const { status } = runSignerCheck([
      `V2 Signer: certificate SHA-256 digest: ${KEY}`,
      `V3.0 Signer: certificate SHA-256 digest: ${KEY}`,
      '',
    ].join('\n'))
    expect(status).toBe(0)
  })

  it('refuses an APK whose schemes carry two different keys', () => {
    const { status, output } = runSignerCheck([
      `V2 Signer: certificate SHA-256 digest: ${KEY}`,
      `V3.0 Signer: certificate SHA-256 digest: ${OTHER}`,
      '',
    ].join('\n'))
    expect(status).not.toBe(0)
    expect(output).toContain('more than one signer')
  })

  it('still refuses a second signer in build-tools 36 output', () => {
    const { status, output } = runSignerCheck([
      `Signer #1 certificate SHA-256 digest: ${KEY}`,
      `Signer #2 certificate SHA-256 digest: ${OTHER}`,
      '',
    ].join('\n'))
    expect(status).not.toBe(0)
    expect(output).toContain('more than one signer')
  })

  // A source stamp is a separate certificate printed with the same suffix, and it is not a signer.
  // Counting it would fail an APK that carries exactly the release key.
  it('ignores the source stamp certificate', () => {
    const { status } = runSignerCheck([
      `V2 Signer: certificate SHA-256 digest: ${KEY}`,
      `Source Stamp Signer certificate SHA-256 digest: ${OTHER}`,
      '',
    ].join('\n'))
    expect(status).toBe(0)
  })

  it('refuses an APK signed by some other key', () => {
    const { status, output } = runSignerCheck(`V2 Signer: certificate SHA-256 digest: ${OTHER}\n`)
    expect(status).not.toBe(0)
    expect(output).toContain('the release key is')
  })

  // The guard that did fire in November, kept: a format nobody anticipated has to stop the release
  // rather than compare two empty strings and pass.
  it('refuses output it cannot read a digest out of at all', () => {
    const { status, output } = runSignerCheck('Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\n')
    expect(status).not.toBe(0)
    expect(output).toContain('no SHA-256 digest')
  })

  it('refuses a committed fingerprint that is not a lowercase digest', () => {
    const { status, output } = runSignerCheck(`V2 Signer: certificate SHA-256 digest: ${KEY}\n`, KEY.toUpperCase())
    expect(status).not.toBe(0)
    expect(output).toContain('does not hold a lowercase SHA-256 digest')
  })
})

// workflow_dispatch exists so a tag whose release failed for a reason outside the APK can be built
// again from a fixed workflow. It also makes the tag an argument, and an argument can be anything:
// a branch name would build master and release it under whatever version the input claimed, and a
// tag that already shipped would run the whole pipeline to reach a gh release create that refuses
// to replace it. Both are cheap to refuse here and expensive to discover at the end.
describe('the guard on the tag the run was handed', () => {
  it('accepts an android-v tag with no release yet', () => {
    const { status } = runTagGuard(TAG)
    expect(status).toBe(0)
  })

  it('refuses a tag that already has a release', () => {
    const { status, output } = runTagGuard(TAG, TAG)
    expect(status).not.toBe(0)
    expect(output).toContain('already has a release')
  })

  it('refuses a branch name', () => {
    const { status, output } = runTagGuard('master')
    expect(status).not.toBe(0)
    expect(output).toContain('is not an android-v tag')
  })

  it('refuses a server release tag', () => {
    const { status, output } = runTagGuard('v2.24.1')
    expect(status).not.toBe(0)
    expect(output).toContain('is not an android-v tag')
  })

  // An empty TAG is what a dispatch whose input never reached the env would produce, and it must
  // not read as a tag whose prefix happens not to match anything in particular.
  it('refuses an empty tag', () => {
    const { status, output } = runTagGuard('')
    expect(status).not.toBe(0)
    expect(output).toContain('is not an android-v tag')
  })
})
