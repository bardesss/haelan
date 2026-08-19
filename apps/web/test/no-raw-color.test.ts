import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const ALLOWED = ['theme.generated.css', 'fixtures']
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

describe('colour discipline', () => {
  // Components must reach for semantic tokens so a theme change stays a value swap.
  it('has no literal colours outside the generated stylesheet', () => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.some((a) => f.includes(a)))
      .filter((f) => COLOR.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
