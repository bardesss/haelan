import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const app = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
const site = readFileSync(fileURLToPath(new URL('../../../site/site.css', import.meta.url)), 'utf8')

// The display scale is deliberately page-local: a dashboard has no use for 4rem type, and the
// landing page is its only consumer. These three leadings belong to it and are the only literals
// either stylesheet is allowed to carry.
const DISPLAY_LEADINGS = new Set(['.9', '1.04', '1.25'])

function literals(css: string, property: 'font-weight' | 'line-height'): string[] {
  return [...css.matchAll(new RegExp(`${property}:\\s*([0-9.]+)`, 'g'))].map((m) => m[1]!)
}

describe('stylesheet literals', () => {
  it('has no bare font-weight in either stylesheet', () => {
    expect(literals(app, 'font-weight')).toEqual([])
    expect(literals(site, 'font-weight')).toEqual([])
  })

  it('has no bare line-height outside the landing page display scale', () => {
    expect(literals(app, 'line-height')).toEqual([])
    expect(literals(site, 'line-height').filter((v) => !DISPLAY_LEADINGS.has(v))).toEqual([])
  })
})
