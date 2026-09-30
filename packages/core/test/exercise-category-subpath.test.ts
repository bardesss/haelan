import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The browser-safe entry point the web reads the category map through. apps/web cannot depend on
// the barrel (it pulls better-sqlite3 and drizzle into a browser bundle), so the module must stay
// import-free; an import added there breaks the web bundle while every Node test stays green.
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('the @haelan/core/exercise-category subpath', () => {
  it('is published, and points at the category module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports['./exercise-category']).toBe('./src/api/exerciseCategory.ts')
  })

  it('imports nothing and re-exports nothing', () => {
    const code = read('../src/api/exerciseCategory.ts')
    expect(code, 'no import of any form, dynamic included').not.toMatch(/\bimport\b/)
    expect(code).not.toMatch(/\bfrom\s*['"]/)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })
})
