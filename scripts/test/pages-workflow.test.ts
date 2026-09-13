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
