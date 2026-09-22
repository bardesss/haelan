import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// What this exists to stop, stated as the thing that actually went wrong rather than as a rule.
//
// release-please flips a merged release pull request from `autorelease: pending` to
// `autorelease: tagged` as part of cutting the GitHub release for it. A package configured with
// `skip-github-release` never reaches that step, so its release pull request stays `pending`
// forever - and release-please treats a merged-but-pending release pull request as an untagged
// release outstanding, which aborts the entire run for EVERY package, not just that one:
//
//   ⚠ There are untagged, merged release PRs outstanding - aborting
//
// So a single Android release silently stops every release pull request in the repository. #315
// and #319 were unstuck by stripping their labels by hand; #329 was not, and the root package went
// eight merges without a release pull request before anyone asked why. The fix is that whatever
// takes over the release for a skipped package also takes over the label, and this is what keeps
// those two facts attached to each other.
//
// Keyed on the config rather than on a list of workflow files: adding a second package with
// `skip-github-release` and no relabel behind it is the same defect, and a test naming
// apps/android specifically would pass straight through it. That is the difference between a
// guard that catches asymmetry and one that catches absence.
const config = JSON.parse(
  readFileSync(new URL('../../release-please-config.json', import.meta.url), 'utf8'),
) as { packages: Record<string, { component?: string, 'skip-github-release'?: boolean }> }

// Every workflow that could be doing the relabelling, read as text. The question asked below is
// whether SOMETHING closes the loop, not which file does - a later refactor moving the step from
// android-tag.yml into android-release.yml should not fail this.
const WORKFLOW_DIR = new URL('../../.github/workflows/', import.meta.url)
const WORKFLOWS = ['android-tag.yml', 'android-release.yml', 'release.yml']
const workflowText = WORKFLOWS
  .map((name) => readFileSync(new URL(name, WORKFLOW_DIR), 'utf8'))
  .join('\n')

const skipped = Object.entries(config.packages)
  .filter(([, pkg]) => pkg['skip-github-release'] === true)

describe('the autorelease label loop', () => {
  // If this ever goes to zero the rest of the file is vacuous, so say so out loud rather than
  // let every assertion below pass over an empty list.
  it('still has a package whose GitHub release release-please skips', () => {
    expect(skipped.length, 'no package sets skip-github-release; is this file still needed?')
      .toBeGreaterThan(0)
  })

  it.each(skipped)('closes the label loop for %s', (path) => {
    expect(
      workflowText,
      `${path} sets skip-github-release, so release-please never marks its merged release pull `
      + 'request tagged. Something in the workflows has to, or the next release of this package '
      + 'blocks every release pull request in the repository.',
    ).toContain('autorelease: tagged')
    expect(
      workflowText,
      `${path}: the relabel has to clear the pending label as well, not merely add the tagged `
      + 'one. release-please looks for `autorelease: pending`, so a pull request carrying both is '
      + 'still an outstanding release to it.',
    ).toContain('--remove-label "autorelease: pending"')
  })

  // The relabel runs on a PAT rather than the workflow's own GITHUB_TOKEN, and that is not
  // incidental: android-tag.yml already requires RELEASE_PLEASE_TOKEN for the tag push (a push
  // made with GITHUB_TOKEN triggers no workflow, which its own comment explains), and the step
  // would need `pull-requests: write` it is not granted otherwise. Pinned because the failure is
  // a 403 in a step nobody watches, which puts the label right back where it was.
  it('runs the relabel on the release token', () => {
    const tag = readFileSync(new URL('android-tag.yml', WORKFLOW_DIR), 'utf8')
    const step = tag.slice(tag.indexOf('Tell release-please this one is done with'))
    expect(step, 'the relabel step should exist in android-tag.yml').not.toBe('')
    expect(step.slice(0, 400)).toContain('RELEASE_PLEASE_TOKEN')
  })
})
