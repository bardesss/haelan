import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * What this guard is for.
 *
 * A development machine accumulated 1,691 abandoned temp directories, about 630 MB, over three
 * weeks. Their mtimes clustered almost perfectly: 64 of the 69 clusters held exactly seven
 * directories, one cluster per full suite run, which is what identified the source - a file with
 * seven tests, each opening a database whose handle and directory nothing ever released. A
 * measured green run leaked eight directories and reported no error at all, which is the shape
 * that makes this worth a guard rather than a comment: nothing goes red, the suite passes, and
 * the only symptom is disk consumed on whichever machine runs it most.
 *
 * Both rules below are things a reviewer cannot reasonably be asked to notice by eye, and both
 * are written against the two real defects rather than invented: A is what people-profile-fields
 * did, B is what demo-capture-server did.
 */

/** The source with comments stripped, so a rule is never satisfied by prose describing it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Every TypeScript source under the three workspace roots, found rather than listed: a listed set
 * silently stops covering the file added after it was written, and a new test file is exactly
 * where this defect appears.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('dist')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

const FILES = ['apps', 'packages', 'scripts'].flatMap((d) => sources(join(ROOT, d)))
const name = (path: string): string => relative(ROOT, path).replace(/\\/g, '/')

describe('temp directories the suite creates are the suite\'s to remove', () => {
  // createTestDatabase hands back a `cleanup` that closes the handle and removes the directory,
  // and a caller is free to drop it on the floor. people-profile-fields.test.ts did exactly that
  // for seven tests, in a helper whose name gave no hint a database was involved; it leaked on
  // every run for as long as the file existed and never failed anything.
  it('makes every caller of createTestDatabase account for its cleanup', () => {
    const offenders = FILES.filter((path) => {
      const source = code(path)
      if (!source.includes('createTestDatabase(')) return false
      // The fixture module defines it, and the barrel re-exports it; neither is a caller.
      if (/packages\/core\/src\/(testing\/fixtures|index)\.ts$/.test(name(path))) return false
      return !/cleanup/.test(source)
    }).map(name)

    expect(offenders).toEqual([])
  })

  // `const dir = join(mkdtempSync(...), 'data')` reads like one directory and is two. Teardown
  // then removes the child it named and leaves the parent mkdtempSync actually created, which is
  // invisible in review and invisible in a green run. Requiring the result to be bound on its own
  // means the thing that has to be removed always has a name.
  it('binds what mkdtempSync creates to a name of its own', () => {
    const offenders: string[] = []
    for (const path of FILES) {
      for (const match of code(path).matchAll(/.{0,60}mkdtempSync\(/g)) {
        if (!/\b\w+\s*=\s*mkdtempSync\($/.test(match[0])) {
          offenders.push(`${name(path)}: ...${match[0].trim().slice(-60)}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
