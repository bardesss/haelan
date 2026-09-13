import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The release workflow's ordering is load bearing and nothing else checks it. Release Please
// writes the release as a draft, so until something publishes that draft the release does not
// exist for anyone who is not a maintainer. Everything that can fail has to come before the step
// that publishes it: a release pointing at an image that never reached the registry looks like
// the tag succeeded, and sends the first person following the README to a 404. That is not
// hypothetical -- it happened to 1.14.1, whose publish job died on a segfaulting test worker
// after the release had already been cut.
const yaml = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const lines = yaml.split(/\r?\n/)

// The publish job only. Scoping matters now that the file has two jobs: a line based search
// across the whole file would happily compare a step in one against a step in the other.
//
// Steps are collected as blocks rather than as bare label lines, because one assertion below
// needs to know which steps only run on failure, and that lives on an `if:` line inside the
// block rather than on the line that names it.
const publishSteps = (() => {
  const start = lines.findIndex(line => /^ {2}publish:/.test(line))
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  const body = end === -1 ? rest : rest.slice(0, end)

  const steps: { label: string; onlyOnFailure: boolean }[] = []
  for (const line of body) {
    const opener = /^ {6}- (?:name|uses|run|id):\s*(.*)$/.exec(line)
    if (opener) {
      steps.push({ label: opener[1], onlyOnFailure: false })
    } else if (steps.length > 0 && /^ {8}if:\s*failure\(\)\s*$/.test(line)) {
      steps[steps.length - 1].onlyOnFailure = true
    }
  }
  return steps
})()

const indexOf = (needle: string) => publishSteps.findIndex(step => step.label.includes(needle))

const releaseConfig = JSON.parse(
  readFileSync(new URL('../../release-please-config.json', import.meta.url), 'utf8'),
) as { packages: Record<string, { draft?: boolean; 'force-tag-creation'?: boolean }> }

describe('the release workflow', () => {
  it('parses out the publish job it is asserting against', () => {
    // Without this every assertion below passes vacuously on -1 === -1 if the file's shape moves
    // and the parse quietly returns nothing.
    expect(publishSteps.length).toBeGreaterThan(5)
  })

  it('asks release-please to draft the release, and to create the tag anyway', () => {
    // These two settings are one mechanism and neither is safe alone. Read them together.
    //
    // `draft` is what buys the ordering guarantee: the release exists, but nobody browsing sees
    // it, until the publish job has pushed and booted the image.
    //
    // `force-tag-creation` is what stops that guarantee costing the version numbers. GitHub does
    // not create a draft's git tag until the draft is published, and release-please drops every
    // release whose tag does not resolve -- its release search is literally
    // `releases.filter(release => !!release.tagCommit)`, and the fallback that recovers a release
    // the search missed looks it up by tag as well. Drafting alone therefore hid every previous
    // release from release-please: it backfilled one from the manifest with `sha: ''`, never
    // matched that sha while walking history, and recomputed the version from all 217 commits in
    // this repository. That history always holds a `feat:`, so every run proposed a minor bump
    // and merging a release opened another release for no changes. 1.2.0, 1.3.0 and a proposed
    // 1.4.0 came out that way, each containing only its own release commit. That is #127, and
    // #135 reverted it by dropping the draft.
    //
    // `force-tag-creation` makes release-please create the tag itself, with an explicit
    // createRef, before it creates the release, which is why the draft can come back. Upstream
    // documents the option for exactly this case. So: pinned as a pair, because re-adding the
    // draft without it repeats #127 exactly, and removing it while the draft stays would too.
    const root = releaseConfig.packages['.']
    expect(root).toBeDefined()
    expect(root?.draft).toBe(true)
    expect(root?.['force-tag-creation']).toBe(true)
  })

  it('publishes the draft only after the image is pushed and booted', () => {
    // The whole point of the drafting above. Both indices asserted present before they are
    // compared: a missing step makes indexOf return -1, and -1 is less than every real index, so
    // the ordering assertion alone would report success for a workflow that had stopped
    // publishing the release at all.
    const publishDraft = indexOf('The release stops being a draft')
    expect(publishDraft).toBeGreaterThanOrEqual(0)

    for (const earlier of [
      'pnpm test',
      'check-image-boots.sh haelan:release-amd64',
      'check-image-boots.sh haelan:release-arm64',
      'Push both architectures',
    ]) {
      const step = indexOf(earlier)
      expect(step, `${earlier} is missing from the publish job`).toBeGreaterThanOrEqual(0)
      expect(step, `${earlier} runs after the release is published`).toBeLessThan(publishDraft)
    }
  })

  it('has nothing after the publishing step that could still fail', () => {
    // Stronger than the ordering assertion above and the one that actually holds the guarantee:
    // it is not enough that today's failure-prone steps precede the publish, because tomorrow's
    // step will be appended to the end of the job where every other step was appended. Anything
    // added after the publish can fail with the release already public, which is the bug this
    // file exists to prevent.
    //
    // Steps that only run on failure are exempt: they cannot run before the publish step has
    // already been reached, and they publish nothing.
    const publishDraft = indexOf('The release stops being a draft')
    const after = publishSteps.slice(publishDraft + 1).filter(step => !step.onlyOnFailure)
    expect(after.map(step => step.label)).toEqual([])
  })

  it('leaves a readable trace when the publish fails', () => {
    // A failure is loud to whoever gets the mail and silent to everyone else: the draft stays
    // invisible, so the Releases page looks like nothing happened. What makes it worth a step of
    // its own is that the tempting recovery is the wrong one. Publishing the draft by hand from
    // the Releases UI produces exactly the release-pointing-at-a-missing-image that the ordering
    // above is for, and it is two clicks away.
    const trace = indexOf('Say what a failure left behind')
    expect(trace).toBeGreaterThanOrEqual(0)
    expect(publishSteps[trace].onlyOnFailure).toBe(true)
    expect(yaml).toContain('GITHUB_STEP_SUMMARY')
  })

  it('boots both architectures before pushing either', () => {
    const push = indexOf('Push both architectures')
    for (const arch of ['haelan:release-amd64', 'haelan:release-arm64']) {
      const boot = publishSteps.findIndex(
        s => s.label.includes('check-image-boots.sh') && s.label.includes(arch),
      )
      expect(boot).toBeGreaterThanOrEqual(0)
      expect(boot).toBeLessThan(push)
    }
  })

  it('runs the test suite before anything is pushed', () => {
    // Both indices asserted present before they are compared, for the reason given above.
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

  it('names the release by id rather than by tag when publishing it', () => {
    // `repos/{owner}/{repo}/releases/tags/{tag}` does not return draft releases, so every way of
    // finding this release by its tag name fails for exactly as long as the release is a draft --
    // which is the entire window in which the publishing step has to find it. release-please
    // outputs the numeric id; the job carries it across as an output for this one use.
    expect(yaml).toContain('release_id: ${{ steps.rp.outputs.id }}')
    expect(yaml).toContain('RELEASE_ID: ${{ needs.release-please.outputs.release_id }}')
  })
})
