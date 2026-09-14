import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { buildSite, copyDemo } from '../build-site.mjs'

function fakeDemoDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-demo-dist-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>demo</title>')
  mkdirSync(join(dir, 'demo-api'), { recursive: true })
  writeFileSync(join(dir, 'demo-api', 'manifest.json'), '{"/api/auth/me":"me.json"}')
  return dir
}

describe('copyDemo', () => {
  it('publishes the demo under /demo and gives it a 404 fallback', () => {
    const from = fakeDemoDist()
    const out = mkdtempSync(join(tmpdir(), 'haelan-site-out-'))
    try {
      const written = copyDemo(from, out)

      expect(existsSync(join(out, 'demo', 'index.html'))).toBe(true)
      expect(existsSync(join(out, 'demo', 'demo-api', 'manifest.json'))).toBe(true)

      // Pages serves no SPA fallback: without this file, a refresh on /demo/activity is a 404.
      const index = readFileSync(join(out, 'demo', 'index.html'), 'utf8')
      expect(readFileSync(join(out, 'demo', '404.html'), 'utf8')).toBe(index)

      // Published paths are web paths, forward slashes on every platform.
      expect(written).toContain('demo/index.html')
      expect(written.every((path) => !path.includes('\\'))).toBe(true)
    } finally {
      rmSync(from, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('publishes the site root 404 where Pages actually looks for it', () => {
    // buildSite rather than copyDemo: the root 404 belongs to the landing site and ships whether
    // or not a demo build exists, while the redirect inside it is what the demo's deep links need.
    // Pages ignores a 404.html in a subdirectory, which is what the first real deploy proved.
    const out = mkdtempSync(join(tmpdir(), 'haelan-site-root404-'))
    try {
      const written = buildSite(fileURLToPath(new URL('../../', import.meta.url)), out)
      expect(written).toContain('404.html')

      // Distinct from the landing page: a root 404 that was a copy of index.html would answer
      // every mistyped address with the front page under a 404 status.
      const notFound = readFileSync(join(out, '404.html'), 'utf8')
      expect(notFound).not.toBe(readFileSync(join(out, 'index.html'), 'utf8'))
      expect(notFound).toContain('/demo/')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('does nothing when there is no demo build, so the landing page can ship alone', () => {
    const out = mkdtempSync(join(tmpdir(), 'haelan-site-out-'))
    try {
      expect(copyDemo(join(out, 'does-not-exist'), out)).toEqual([])
      expect(existsSync(join(out, 'demo'))).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
