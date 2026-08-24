import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return extname(entry.name) === '.tsx' ? [path] : []
  })
}

// Text between tags that is not an expression. This catches the common shape, `<h1>Sleep</h1>`,
// and deliberately not every possible one: a guard that tried to be exhaustive would fire on
// punctuation and separators and get switched off. Its job is to make adding a page with inline
// copy fail once, loudly, at the point somebody would otherwise not notice.
const TEXT_BETWEEN_TAGS = />\s*([A-Za-z][A-Za-z ,.'!?-]{3,})\s*</g

// The product's own name, not copy: it is spelled "haelan" identically in every language the
// catalogues support, so there is no translation for it to live in. Narrow on purpose, unlike
// widening the regex above, which would just as happily stop seeing real copy.
const NOT_COPY = new Set(['haelan'])

describe('user-facing copy', () => {
  it('lives in the catalogues rather than inline in a component', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(TEXT_BETWEEN_TAGS)) {
        if (NOT_COPY.has(match[1]!)) continue
        offenders.push(`${file.slice(SRC.length + 1)}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
