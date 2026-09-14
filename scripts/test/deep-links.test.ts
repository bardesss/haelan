import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * The two halves of a demo deep link, pinned because the first real deploy proved the assumption
 * they replace was wrong.
 *
 * `/haelan/demo/sleep` is not a file. It used to rely on `site/dist/demo/404.html`, on the belief
 * that GitHub Pages serves the nearest 404.html walking up the tree. It does not — it serves the
 * one at the SITE ROOT — so that address landed on GitHub's own "Page not found" while every local
 * emulation said it worked.
 *
 * So the root 404 rewrites such a path to `/haelan/demo/?/sleep`, which is a real file, and the
 * demo's entry undoes the rewrite before the router reads the location. Neither half is any use
 * without the other, which is why they are asserted in one file.
 */
const root = new URL('../../', import.meta.url)
const notFound = readFileSync(new URL('site/404.html', root), 'utf8')
const demoEntry = readFileSync(new URL('apps/web/index.demo.html', root), 'utf8')

describe('the site root 404', () => {
  it('redirects a path inside the demo to the demo entry, carrying the rest as a query', () => {
    expect(notFound).toContain("indexOf('/demo/')")
    expect(notFound).toContain("'?/'")
    expect(notFound).toContain('location.replace')
  })

  it('leaves an address outside the demo alone, so the landing site keeps a real 404', () => {
    // The guard is the `at !== -1` check: without it every mistyped landing-page address would be
    // rewritten into the demo and boot the whole app.
    expect(notFound).toMatch(/at !== -1/)
    expect(notFound).toMatch(/Not found/)
  })

  it('does not redirect the demo entry itself, which would bounce', () => {
    expect(notFound).toMatch(/path\.length > at \+ '\/demo\/'\.length/)
  })

  it('escapes an ampersand so a query survives the round trip', () => {
    // '&' has to be smuggled: the path is being packed into a query string, where a raw '&' would
    // read as the start of the next parameter.
    expect(notFound).toContain('~and~')
    expect(demoEntry).toContain('~and~')
  })
})

describe('the demo entry', () => {
  it('restores the path from the redirect', () => {
    expect(demoEntry).toContain("search.charAt(1) !== '/'")
    expect(demoEntry).toContain('history.replaceState')
  })

  it('restores before the module script runs', () => {
    // router.tsx reads window.location on its first render, so a restore running after the bundle
    // would route to the wrong page and then visibly correct itself.
    const restoreAt = demoEntry.indexOf('history.replaceState')
    const moduleAt = demoEntry.indexOf('type="module"')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(moduleAt).toBeGreaterThan(restoreAt)
  })
})
