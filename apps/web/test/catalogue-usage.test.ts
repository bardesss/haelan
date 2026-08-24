import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import en from '../src/i18n/en.json' with { type: 'json' }

const SRC = fileURLToPath(new URL('../src', import.meta.url))

// i18next's own plural suffixes: a catalogue entry like "summary_one"/"summary_other" is reached
// through the base key "summary" at runtime, i18next itself picks the suffix from {{count}}.
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => paths(child, prefix === '' ? key : `${prefix}.${key}`))
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

const SOURCE = tsFiles(SRC).map((f) => readFileSync(f, 'utf8')).join('\n')

function withoutPluralSuffix(key: string): string {
  const at = key.lastIndexOf('_')
  if (at === -1) return key
  return PLURAL_SUFFIXES.includes(key.slice(at + 1)) ? key.slice(0, at) : key
}

// A literal like t('foo.bar') covers most of the catalogue. The one case that is not a literal,
// ControlRow's t(`controlRow.ranges.${key}`), builds the key from a runtime variable, so the full
// string never appears in source; what does appear is the template's own fixed prefix immediately
// before the interpolation, which is enough to tell "referenced dynamically" from "not referenced
// anywhere".
function isReferenced(key: string): boolean {
  if (SOURCE.includes(`'${key}'`) || SOURCE.includes(`"${key}"`)) return true
  const segments = key.split('.')
  for (let end = segments.length - 1; end >= 1; end -= 1) {
    const prefix = segments.slice(0, end).join('.')
    if (SOURCE.includes(`\`${prefix}.\${`)) return true
  }
  return false
}

describe('the message catalogue', () => {
  it('has no key that nothing in src references', () => {
    const orphans = paths(en).filter((key) => !isReferenced(key) && !isReferenced(withoutPluralSuffix(key)))
    expect(orphans).toEqual([])
  })
})
