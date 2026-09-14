import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// Read as lines rather than parsed: this repository has no YAML parser in its dependencies, and
// what these assertions care about - which triggers exist, which permissions are granted, and
// what order the steps run in - is legible without one. release-workflow-order.test.ts reads
// release.yml the same way and says why.
// Newlines normalised on the way in. The file is stored with LF and checks out that way on CI,
// but git converts it to CRLF on a Windows checkout with core.autocrlf set, and the trigger
// assertion below spells its line breaks as literal \n - so it could not match, and this file
// failed for anyone who cloned the repository on Windows while passing for whoever wrote it and
// on every CI leg. Normalising here rather than writing \r?\n into each pattern keeps the
// assertions readable and cannot be forgotten by the next one added.
const yaml = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
const lines = yaml.split('\n')
const at = (needle: string) => lines.findIndex((line) => line.includes(needle))

describe('the pages workflow', () => {
  it('deploys on a push to master and on demand, and on nothing else', () => {
    expect(yaml).toMatch(/^on:\n(?:.*\n)*?\s{2}push:\n\s{4}branches: \[master\]/m)
    expect(yaml).toContain('workflow_dispatch:')
    // Not on `release: published`, which this file asserted until the first real deploys proved it
    // cannot work: a release run's ref is the tag, and the github-pages environment allows only
    // the branch master, so v1.20.0's deploy was rejected outright; and v1.21.0 started no run at
    // all, because the draft is published under a token GitHub starts no workflows from. Every
    // deploy the site has ever had was a dispatch by hand. The workflow's own comment carries the
    // full account.
    expect(lines.some((line) => /^\s{2}release:/.test(line))).toBe(false)
  })

  it('still names the reason it does not trust the release event', () => {
    // The two failures above are the kind of thing that gets "tidied" out of a comment by someone
    // who reads the trigger and assumes push was the obvious choice all along. It was not: this
    // workflow tried the other shape first and it never once deployed.
    expect(yaml).toMatch(/environment protection rules/)
    expect(yaml).toMatch(/GITHUB_TOKEN/)
  })

  it('asks for exactly the permissions Pages needs', () => {
    expect(yaml).toMatch(/^\s{2}pages: write$/m)
    expect(yaml).toMatch(/^\s{2}id-token: write$/m)
    expect(yaml).toMatch(/^\s{2}contents: read$/m)
  })

  it('builds the palette before the page, and the page before it is uploaded', () => {
    expect(at('site:build')).toBeGreaterThan(-1)
    expect(at('upload-pages-artifact')).toBeGreaterThan(at('site:build'))
    expect(at('deploy-pages')).toBeGreaterThan(at('upload-pages-artifact'))
  })

  it('uploads what the build actually writes', () => {
    expect(yaml).toContain('path: site/dist')
  })

  it('deploys only after the build job succeeded', () => {
    expect(at('needs: build')).toBeGreaterThan(-1)
  })
})

// Normalised the same way `yaml` is above, and for the same reason: this checkout has ci.yml in
// CRLF, today's assertions on it are substring checks that happen not to span a newline, and the
// first line-anchored assertion added to this block would fail on Windows exactly as
// milestone one's did before `yaml` got this same treatment.
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

describe('the demo half of the pages workflow', () => {
  it('captures, then builds the demo, then builds the site around it', () => {
    // Order is the whole assertion: site:build copies apps/web/dist-demo, which demo:build
    // writes, from fixtures demo:capture records. Any other order publishes a stale or empty
    // demo and says nothing about it.
    expect(at('demo:capture')).toBeGreaterThan(-1)
    expect(at('demo:build')).toBeGreaterThan(at('demo:capture'))
    expect(at('site:build')).toBeGreaterThan(at('demo:build'))
    expect(at('upload-pages-artifact')).toBeGreaterThan(at('site:build'))
  })

  it('still uploads the assembled site, not the demo alone', () => {
    expect(yaml).toContain('path: site/dist')
  })
})

describe('the rehearsal job in ci.yml', () => {
  it('exists, so a change to the capture chain is proved before it reaches a deploy', () => {
    expect(ci).toContain('demo-rehearsal')
    expect(ci).toContain('demo:all')
  })

  it('watches every path that can break the chain', () => {
    // Each of these can change what a page asks for or what a route answers, which is what the
    // fixtures are. A prefix dropped from this list is a break discovered after a release.
    for (const prefix of ['demo/', 'apps/web/src/demo/', 'scripts/capture-demo', 'apps/server/src/routes/v1/']) {
      expect(ci, prefix).toContain(prefix)
    }
  })

  it('also watches the three paths the plan\'s own list left out', () => {
    // scripts/seed-demo.mjs is what capture-demo.mjs spawns to build the throwaway instance in
    // the first place - a break there fails demo:capture as surely as a broken recorder does, and
    // nothing under scripts/capture-demo* names it. apps/web/vite.demo.config.ts and
    // apps/web/index.demo.html are demo:build's own config and entry point, forced to live beside
    // vite.config.ts and index.html rather than under src/demo/ (Vite resolves both by fixed
    // name). None of the three has a fast unit test the way copyDemo and writeCapture do, so this
    // rehearsal is the only thing that would ever catch a break in one of them - which is exactly
    // why a prefix dropped from here, unlike the four above, would go unnoticed by every other
    // test in this repository too.
    for (const prefix of ['scripts/seed-demo', 'apps/web/vite.demo.config.ts', 'apps/web/index.demo.html']) {
      expect(ci, prefix).toContain(prefix)
    }
  })
})
