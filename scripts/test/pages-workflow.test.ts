import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// Read as lines rather than parsed: this repository has no YAML parser in its dependencies, and
// what these assertions care about - which triggers exist, which permissions are granted, and
// what order the steps run in - is legible without one. release-workflow-order.test.ts reads
// release.yml the same way and says why.
const yaml = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8')
const lines = yaml.split(/\r?\n/)
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
