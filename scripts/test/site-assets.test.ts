import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildSite } from '../build-site.mjs'
import { emitCss } from '../../packages/tokens/src/emit.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
let out: string
let written: string[]

// dist/theme.css is a build artifact and the suite runs before anything builds it (ci.yml runs
// pnpm test ahead of pnpm build). Writing it here from the same emitter its own build script
// uses means this test exercises the real copy path rather than a stubbed one, on CI and on a
// fresh clone alike.
function ensurePalette(): void {
  const css = new URL('../../packages/tokens/dist/theme.css', import.meta.url)
  if (existsSync(css)) return
  mkdirSync(new URL('../../packages/tokens/dist/', import.meta.url), { recursive: true })
  writeFileSync(css, emitCss())
}

beforeAll(() => {
  ensurePalette()
  out = mkdtempSync(join(tmpdir(), 'haelan-site-out-'))
  written = buildSite(root, out)
})

afterAll(() => {
  rmSync(out, { recursive: true, force: true })
})

describe('buildSite', () => {
  it('renders the slots away', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(html).not.toContain('{{')
    expect(html).toMatch(/Version \d+\.\d+\.\d+, released \d{4}-\d{2}-\d{2}/)
  })

  it('writes every local file the page asks for', () => {
    // The point of this test: a renamed screenshot or a moved favicon becomes a red run here
    // rather than a broken image on the published page, which nothing else would catch.
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    const referenced = [...html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => !/^(?:https?:)?\/\//.test(url))
    expect(referenced.length).toBeGreaterThan(0)
    for (const path of referenced) {
      expect(existsSync(join(out, path)), `${path} is referenced but was not written`).toBe(true)
    }
  })

  it('reports what it wrote', () => {
    expect(written).toContain('index.html')
    expect(written).toContain('theme.css')
    expect(written).toContain('screenshots/dashboard.png')
  })
})
