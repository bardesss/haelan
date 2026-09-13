import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { emitCss } from '../../packages/tokens/src/emit.js'

const root = new URL('../../', import.meta.url)
const html = readFileSync(new URL('site/index.html', root), 'utf8')
const css = readFileSync(new URL('site/site.css', root), 'utf8')

describe('the landing page', () => {
  it('names the release through slots rather than in the markup', () => {
    expect(html).toContain('{{version}}')
    expect(html).toContain('{{releaseDate}}')
    // A version typed into the page by hand is the thing the slots exist to prevent.
    expect(html).not.toMatch(/\b\d+\.\d+\.\d+\b/)
  })

  it('loads nothing from a third party', () => {
    // Subresources only. An <a href> to github.com is a link the reader follows, not a request
    // the page makes on their behalf, and the no-telemetry promise is about the latter.
    const subresources = [...html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1])
    expect(subresources.length).toBeGreaterThan(0)
    for (const url of subresources) {
      expect(url).not.toMatch(/^(?:https?:)?\/\//)
    }
    expect(html).not.toMatch(/@import\s+url\(/)
    expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
  })

  it('says the things a stranger deciding about their health data needs', () => {
    expect(html).toMatch(/written by (?:an? )?(?:AI |coding )?agent/i)
    expect(html).toMatch(/no security professional has audited/i)
    expect(html).toMatch(/100 users|hundred/i)     // why it is self-hosted at all
    expect(html).toMatch(/no telemetry/i)
    expect(html).toMatch(/AGPL/)
  })

  it('tells a phone visitor the truth about the dashboard', () => {
    expect(html).toMatch(/desktop screen/i)
  })

  it('quotes the compose file rather than a second copy of it', () => {
    const compose = readFileSync(new URL('compose.yaml', root), 'utf8')
    const image = /image:\s*(\S+)/.exec(compose)![1]
    const ports = /ports:\s*\[([^\]]+)\]/.exec(compose)![1].replace(/['"]/g, '')
    expect(html).toContain(image)
    expect(html).toContain(ports.trim())
  })

  it('uses only custom properties the token stylesheet defines', () => {
    // The emitter rather than its built output: dist/theme.css is a build artifact, and CI runs
    // the suite before anything builds it. packages/tokens is the single authority for these
    // names either way - a typo here is a colour that falls back to nothing in a browser and to
    // a passing test everywhere else.
    const defined = new Set([...emitCss().matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]))
    const referenced = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))
    expect(referenced.size).toBeGreaterThan(0)
    expect([...referenced].filter((name) => !defined.has(name))).toEqual([])
  })
})
