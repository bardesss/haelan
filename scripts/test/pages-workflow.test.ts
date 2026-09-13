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
  it('deploys on a published release and on demand, and on nothing else', () => {
    expect(yaml).toMatch(/^on:\n(?:.*\n)*?\s{2}release:\n\s{4}types: \[published\]/m)
    expect(yaml).toContain('workflow_dispatch:')
    // Never on push. A site deploy riding every commit to master would publish a page claiming a
    // release that has not been cut, and would put this workflow in the path of the release
    // pipeline, which is the thing the spec keeps it out of.
    expect(lines.some((line) => /^\s{2}push:/.test(line))).toBe(false)
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
