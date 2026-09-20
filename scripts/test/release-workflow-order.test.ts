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
const jobBody = (name: string): string[] => {
  const start = lines.findIndex(line => new RegExp(`^ {2}${name}:`).test(line))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

const stepsOf = (name: string): { label: string; onlyOnFailure: boolean }[] => {
  const steps: { label: string; onlyOnFailure: boolean }[] = []
  for (const line of jobBody(name)) {
    const opener = /^ {6}- (?:name|uses|run|id):\s*(.*)$/.exec(line)
    if (opener) {
      steps.push({ label: opener[1], onlyOnFailure: false })
    } else if (steps.length > 0 && /^ {8}if:\s*failure\(\)\s*$/.test(line)) {
      steps[steps.length - 1].onlyOnFailure = true
    }
  }
  return steps
}

const publishSteps = stepsOf('publish')
const verifySteps = stepsOf('verify')
const imageSteps = stepsOf('image')

const indexIn = (steps: { label: string }[], needle: string) =>
  steps.findIndex(step => step.label.includes(needle))
const indexOf = (needle: string) => indexIn(publishSteps, needle)

// The release-please job, as raw text. Scoped for the same reason the publish job is: the two
// release-please invocations below differ only in two lines each, and a file-wide search would
// match either one.
const releasePleaseJob = (() => {
  const start = lines.findIndex(line => /^ {2}release-please:/.test(line))
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
})()

const releaseConfig = JSON.parse(
  readFileSync(new URL('../../release-please-config.json', import.meta.url), 'utf8'),
) as { packages: Record<string, {
  draft?: boolean
  'force-tag-creation'?: boolean
  'skip-github-release'?: boolean
  component?: string
  'include-component-in-tag'?: boolean
  'exclude-paths'?: string[]
}> }

describe('the release workflow', () => {
  it('parses out the publish job it is asserting against', () => {
    // Without this every assertion below passes vacuously on -1 === -1 if the file's shape moves
    // and the parse quietly returns nothing.
    expect(publishSteps.length).toBeGreaterThan(5)
    expect(verifySteps.length, 'the verify job parsed to nothing').toBeGreaterThan(5)
    expect(imageSteps.length, 'the image job parsed to nothing').toBeGreaterThan(5)
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

    // The suite and the per-architecture builds moved into jobs of their own when arm64 stopped
    // being emulated, so their ordering is now carried by `needs:` rather than by position in one
    // step list. Both halves are asserted: the graph puts them before this job, and the steps
    // inside this job that could still fail come before the publish.
    expect(jobBody('publish').join('\n')).toMatch(/needs: \[release-please, image\]/)
    expect(jobBody('image').join('\n')).toMatch(/needs: \[release-please, verify\]/)

    for (const earlier of ['Tag both architectures as one image', 'The version tags exist']) {
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

  it('boots each architecture before pushing it, and tags neither until both are built', () => {
    // The old shape built and booted both in one job and pushed them together, so "both boot
    // before either is pushed" could be read off one step list. Per-architecture jobs cannot
    // promise that: each pushes as soon as it is done, without waiting for the other.
    //
    // What is promised instead is the thing a person pulling actually depends on. Each job pushes
    // BY DIGEST, which puts layers in the registry under no tag at all, and the tags are created
    // in a single later step that needs both jobs. So no tag resolves until both architectures
    // built and booted - and if arm64 dies the way it did in 1.32.0, what is left behind is
    // untagged blobs rather than a half-released version.
    const boot = indexIn(imageSteps, 'check-image-boots.sh')
    const push = indexIn(imageSteps, 'Push ')
    expect(boot, 'the image job no longer boots what it built').toBeGreaterThanOrEqual(0)
    expect(push, 'the image job no longer pushes').toBeGreaterThanOrEqual(0)
    expect(boot, 'the image is pushed before it is booted').toBeLessThan(push)

    const imageYaml = jobBody('image').join('\n')
    expect(imageYaml, 'the push must carry no tag').toContain('push-by-digest=true')
    expect(imageYaml, 'a tagged push here would publish one architecture on its own')
      .not.toMatch(/^\s+tags:.*ghcr\.io/m)

    // Both architectures, on machines of their own architecture.
    expect(imageYaml).toMatch(/arch: amd64/)
    expect(imageYaml).toMatch(/arch: arm64/)
    expect(imageYaml, 'arm64 must build on an arm64 runner').toMatch(/runner: ubuntu-[\d.]+-arm/)
  })

  // The reason this whole shape exists. Emulating V8 under qemu is a known way to meet an
  // instruction it cannot execute, and when it happens buildx hangs on a dead process rather than
  // failing: 1.32.0 spent 78 minutes that way against a 7 minute pipeline and had to be cancelled
  // by hand, leaving a draft nothing could publish. Comments may discuss it; no step may use it.
  it('emulates nothing', () => {
    const uses = lines.filter(line => /^\s+- uses:/.test(line))
    expect(uses.filter(line => line.includes('setup-qemu'))).toEqual([])
  })

  // A hang is a failure that never arrives, and the default is six hours of a runner sitting on
  // one. Every job that can hang says when to give up.
  it('gives every job a deadline', () => {
    for (const job of ['verify', 'image', 'publish']) {
      expect(jobBody(job).join('\n'), `${job} has no timeout`).toMatch(/timeout-minutes: \d+/)
    }
  })

  it('runs the test suite before anything is pushed', () => {
    // Carried by the graph now: the suite is the verify job, and the image jobs need it. A push
    // cannot start until it has passed, which is the same guarantee the step ordering used to
    // give inside one job.
    const test = indexIn(verifySteps, 'pnpm test')
    expect(test, 'the verify job no longer runs the suite').toBeGreaterThanOrEqual(0)
    expect(jobBody('image').join('\n')).toMatch(/needs: \[release-please, verify\]/)
    expect(indexIn(imageSteps, 'pnpm test'), 'the suite must not be re-run per architecture')
      .toBe(-1)
  })

  // The suite step may retry, and the line between "may" and "always" is the whole guarantee of
  // this job: it exists to stop a release going out on a commit whose tests do not pass. A
  // blanket retry would undo that silently, and the shape that does it - `|| pnpm test` - looks
  // almost identical to the shape that does not.
  it('retries the suite only through the crash-only wrapper', () => {
    const suite = verifySteps[indexIn(verifySteps, 'pnpm test')]
    expect(suite, 'the verify job no longer runs the suite').toBeDefined()
    expect(suite!.label).toContain('retry-if-worker-crashed.sh')

    const wrapper = readFileSync('scripts/retry-if-worker-crashed.sh', 'utf8')
    // It decides on the output, not on the exit code: an assertion failure and a crashed worker
    // both exit non-zero, and only one of them may be retried.
    expect(wrapper).toMatch(/Worker exited unexpectedly/)
    expect(wrapper).toMatch(/not retrying/)
    // One retry, not a loop: a reproducible crash is not the flake this is for.
    expect(wrapper.match(/"\$@"/g) ?? []).toHaveLength(2)
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

  it('cuts the release with a token that can create a git ref', () => {
    // `force-tag-creation` creates the tag with an explicit createRef, and the PAT cannot: the
    // first run after drafting landed failed with `Resource not accessible by personal access
    // token` against the create-a-reference endpoint, and cut no release at all. The workflow's
    // own GITHUB_TOKEN can, under the `contents: write` this file declares -- permissions that
    // can be read here rather than in a secret nobody can read back.
    //
    // So the pass that cuts the release takes GITHUB_TOKEN, and it must not quietly go back to
    // the PAT the next time somebody tidies these two invocations into one.
    const cut = /- name: Cut the release\n(?:.*\n)*?\s+token: (.+)\n/.exec(releasePleaseJob)
    expect(cut, 'the release-cutting invocation is gone or renamed').not.toBeNull()
    expect(cut?.[1].trim()).toBe('${{ secrets.GITHUB_TOKEN }}')
  })

  it('opens the release pull request with the PAT, and only that half', () => {
    // The PAT exists for one reason: a pull request opened by `app/github-actions` gets CI runs
    // that land in `action_required` and never start, so the required checks never report and it
    // sits blocked until somebody approves the run by hand. That applies to the pull request and
    // to nothing else, which is why the release half above does not use it.
    const pr = /- name: Open or refresh the release pull request\n(?:.*\n)*?\s+token: (.+)\n/.exec(
      releasePleaseJob,
    )
    expect(pr, 'the pull-request invocation is gone or renamed').not.toBeNull()
    expect(pr?.[1].trim()).toBe('${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}')
  })

  it('splits release-please into two passes that each skip the other half', () => {
    // Without the skips the two invocations would each do both halves, which is not merely
    // wasteful: the second would cut releases with the PAT, which is the 403 again.
    expect(releasePleaseJob).toContain('skip-github-pull-request: true')
    expect(releasePleaseJob).toContain('skip-github-release: true')

    // And in this order. The pull-request pass rebuilds release-please's picture of the
    // repository from scratch, and the tag the release pass creates is what stops it finding the
    // release before last and proposing a version that re-releases work already released. That
    // is #127's failure, and running these two the other way round reproduces it.
    const cut = releasePleaseJob.indexOf('skip-github-pull-request: true')
    const pr = releasePleaseJob.indexOf('skip-github-release: true')
    expect(cut).toBeLessThan(pr)
  })

  it('grants the token the label write that release-please needs after cutting', () => {
    // The comment and the autorelease labels release-please writes on the release pull request
    // go to issue endpoints even though the subject is a pull request. This is not cosmetic: the
    // label is how release-please knows that pull request is finished with, so failing it leaves
    // the pull request `autorelease: pending` and every later run tries to release it again.
    // 1.15.0 was released and then left pending exactly that way.
    expect(yaml).toContain('issues: write')
  })

  it('lets the app version itself, and keeps it out of the server version', () => {
    // The app releases on its own cadence: a server release several times a day must not tell
    // every installed phone it has an update and then hand it a byte identical APK. Without
    // exclude-paths the root package claims every commit in the repository, so a change to the
    // app alone would cut a server release too.
    const root = releaseConfig.packages['.']
    expect(root['exclude-paths']).toContain('apps/android')

    const app = releaseConfig.packages['apps/android']
    expect(app, 'apps/android is not a release-please package').toBeDefined()
    // component plus include-component-in-tag is what produces `android-v0.2.2`, which is the
    // pattern android-release.yml triggers on and the only thing that ships an APK.
    expect(app.component).toBe('android')
    expect(app['include-component-in-tag']).toBe(true)
  })

  it('has release-please tag the app but not release it', () => {
    // These two are a pair, for a different reason than the root's draft pair above.
    //
    // android-release.yml creates the app's release itself, titled `Android <version>`, because
    // Obtainium filters on the release TITLE rather than the tag and that title is the only thing
    // keeping it from offering a server release as an app update. It also attaches the APK.
    //
    // So release-please must not create that release: two creators racing for one tag means
    // whichever loses fails the job, and a release-please named one would not match `^Android`
    // anyway. skip-github-release stops it.
    //
    // force-tag-creation is what makes the tag still appear. release-please normally creates a
    // tag as part of creating a release; this option makes it create the ref explicitly and
    // separately, which is the same mechanism the root package relies on and is what leaves a
    // tag for android-release.yml to trigger on.
    const app = releaseConfig.packages['apps/android']
    expect(app['skip-github-release']).toBe(true)
    expect(app['force-tag-creation']).toBe(true)
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
