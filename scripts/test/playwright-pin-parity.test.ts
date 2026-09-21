import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The layout job runs inside Microsoft's own Playwright image, because `playwright install` hangs
// here while it unpacks - ci.yml's own comment measures it at ten minutes. The image already has
// the browsers at /ms-playwright, so the job installs nothing, and the price of that is a version
// pinned in TWO files that nothing kept in step.
//
// It drifted the first time it could. A dependency bump moved `playwright` from 1.56.0 to 1.63.0
// and could not touch a workflow, so the job launched a 1.63.0 client against 1.56.0 browsers and
// failed with "Executable doesn't exist at /ms-playwright/chromium_headless_shell-1243". Loud
// rather than silent, which is the good case, but it costs a full CI round trip on a job that
// takes minutes, and it would happen again on every future bump.
//
// Same idiom as the other cross-file guards here: read both real files and compare them in a test
// that runs in seconds, so the answer arrives before CI rather than from it.
const root = new URL('../../', import.meta.url)
const WORKFLOW_PATH = '.github/workflows/ci.yml'
const MANIFEST_PATH = 'package.json'
const workflow = readFileSync(new URL(WORKFLOW_PATH, root), 'utf8')
const manifest = JSON.parse(readFileSync(new URL(MANIFEST_PATH, root), 'utf8')) as {
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

describe('the Playwright image is pinned to the Playwright dependency', () => {
  it('runs the layout job on the image matching the installed version', () => {
    const declared = manifest.devDependencies?.playwright ?? manifest.dependencies?.playwright
    expect(
      declared,
      `${MANIFEST_PATH}: no 'playwright' dependency found. If the layout check no longer drives `
      + 'Playwright, delete this guard with it; otherwise the guard has lost its subject and must '
      + 'say so rather than compare nothing.',
    ).toBeDefined()
    // Playwright pins its browsers to an exact build, so the dependency has to be exact too: a
    // caret would let a lockfile refresh move the client under an image that cannot move with it.
    const version = declared!.replace(/^[\^~]/, '')
    expect(
      declared,
      `${MANIFEST_PATH}: 'playwright' is declared as '${declared}', which is a range. It has to be `
      + 'an exact version, because the browsers it drives live in a container tagged with one.',
    ).toBe(version)

    const pinned = /image:\s*mcr\.microsoft\.com\/playwright:v([0-9.]+)-/.exec(workflow)
    expect(
      pinned,
      `${WORKFLOW_PATH}: no 'mcr.microsoft.com/playwright:v<version>-' image pin found. Has the `
      + 'layout job stopped using the prebuilt image? If so it downloads browsers itself now, '
      + 'which is the ten-minute unpack that image exists to avoid.',
    ).not.toBeNull()

    expect(
      pinned![1],
      `${WORKFLOW_PATH} pins mcr.microsoft.com/playwright:v${pinned![1]} while ${MANIFEST_PATH} `
      + `installs playwright ${version}. Playwright refuses to drive browsers from a different `
      + "build, so the layout job fails at launch with \"Executable doesn't exist at "
      + `/ms-playwright/...". Move the image tag with the dependency: it should be `
      + `mcr.microsoft.com/playwright:v${version}-noble.`,
    ).toBe(version)
  })
})
