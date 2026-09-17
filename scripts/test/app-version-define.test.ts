import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appVersion } from '../app-version.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The source with its comments removed.
 *
 * Load bearing, and this file is the proof: every one of these configs explains its `define` in a
 * comment that names the constant, so a check reading the raw text passes on the documentation
 * alone. Written without this, the guard below went green against a config whose `define` had been
 * deleted - it was reading the sentence describing the rule rather than the rule. Same reason
 * grid-collapse.test.ts strips app.css before looking at it.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Every vite or vitest config in this repository, found rather than listed.
 *
 * Found, because a list is what failed. `__APP_VERSION__` is a build-time substitution, so a
 * config that forgets to define it is invisible to a grep for the constant - the config missing it
 * is precisely the one the string does not appear in. Two separate CI failures came out of that:
 * the recorder's config, then the demo build's, each discovered only when something downstream
 * threw.
 *
 * node_modules and build output are skipped; everything else that configures vite or vitest is in
 * scope, because all four of them can load apps/web source and any new one probably will too.
 */
function configs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('dist')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) configs(path, out)
    else if (extname(entry.name) === '.ts' && /^vite(st)?\..*config\.ts$|^vitest\.config\.ts$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

describe('the version constant', () => {
  const found = configs(ROOT)

  it('finds the configs at all, so the checks below cannot pass vacuously', () => {
    expect(found.length, 'no vite or vitest config found; the walk is broken').toBeGreaterThanOrEqual(4)
  })

  /*
   * Why every config and not just the two that build a bundle.
   *
   * `define` does not inherit. Each of these four calls defineConfig on its own - the demo build
   * replaces the app build's config rather than extending it, and both test configs stand apart
   * again - so each has to declare the constant itself. Miss one and the failure surfaces
   * somewhere else entirely: the suite stays green because it takes its value from the root
   * config, a production build stays correct because it takes its own from the web config, and
   * what breaks is whichever consumer the missing config feeds. That was the recorder throwing
   * "__APP_VERSION__ is not defined", and then the demo bundle rendering nothing at all while
   * layout:check reported only a timeout waiting for <main>.
   */
  it('is defined by every one of them', () => {
    for (const path of found) {
      const source = code(path)
      expect(source, `${relative(ROOT, path)} does not define __APP_VERSION__`)
        .toContain('__APP_VERSION__')
    }
  })

  // Through the shared helper in all of them, never a literal: a version written out by hand in
  // one config is a number that goes stale on the next release while the others move.
  it('takes it from the one helper, never from a literal', () => {
    for (const path of found) {
      const source = code(path)
      expect(source, `${relative(ROOT, path)} should call appVersion()`).toContain('appVersion()')
      expect(source, `${relative(ROOT, path)} hardcodes a version`).not.toMatch(/__APP_VERSION__:\s*['"]/)
    }
  })

  it('is the version the root package.json carries', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    expect(appVersion()).toBe(pkg.version)
  })
})
