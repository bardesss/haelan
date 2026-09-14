import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildSite } from '../build-site.mjs'
import { SCREENSHOTS, heroShot, galleryShots } from '../screenshots.mjs'
import { readmeScreenshots } from '../sync-readme-screenshots.mjs'
import { ensurePalette } from './palette.js'

const root = new URL('../../', import.meta.url)

// The built page rather than site/index.html, because the gallery and the lightboxes are slots
// there: asserting against the template would only ever see `{{gallery}}`, which is exactly the
// string that proves nothing about what a reader gets.
let out: string
let built: string

beforeAll(() => {
  ensurePalette()
  out = mkdtempSync(join(tmpdir(), 'haelan-shots-'))
  buildSite(fileURLToPath(root), out)
  built = readFileSync(join(out, 'index.html'), 'utf8')
})

afterAll(() => {
  rmSync(out, { recursive: true, force: true })
})

describe('the screenshot manifest', () => {
  it('lists exactly the files in assets/screenshots', () => {
    // Both directions, because both are real. A file on disk that the manifest does not list is
    // a screenshot nobody ever sees, published by build-site.mjs and linked from neither surface;
    // a manifest entry with no file is a broken image on the landing page and a broken link in
    // the README, which nothing else here would catch until somebody looked.
    const onDisk = readdirSync(fileURLToPath(new URL('assets/screenshots', root)))
      .filter((name) => name.endsWith('.png'))
      .sort()
    const listed = SCREENSHOTS.map((shot) => shot.file).sort()
    expect(listed).toEqual(onDisk)
  })
})

describe('the landing page', () => {
  it('makes every screenshot a link to its own full-size view', () => {
    // The whole point of the change: a 1440x900 capture rendered into a 600px column is a picture
    // of a dashboard, not a dashboard anybody can read. Each shot on the page - the hero included,
    // which is the one most likely to be forgotten because its markup is hand-written - opens the
    // full-size copy over the page.
    for (const shot of SCREENSHOTS) {
      const id = shot.file.replace(/\.png$/, '')
      const anchor = new RegExp(
        `<a class="shot-link" href="#shot-${id}"[^>]*>\\s*<img[^>]*src="screenshots/${shot.file}"`,
      )
      expect(built, `${shot.file} is not a link to its own lightbox`).toMatch(anchor)
    }
  })

  it('gives every full-size view a way back out', () => {
    // A CSS-only lightbox has no Escape key: `:target` is cleared by navigating, and nothing here
    // can listen for a keystroke. Every overlay therefore has to carry its own exits in markup -
    // the backdrop and a labelled control - or a reader who opens one is stuck with it until they
    // find the Back button. This is the assertion that would fail if somebody later simplified the
    // overlay down to just the image.
    for (const shot of SCREENSHOTS) {
      const id = shot.file.replace(/\.png$/, '')
      const overlay = new RegExp(`<div class="lightbox" id="shot-${id}"[^>]*>([\\s\\S]*?)</div>`)
      const found = overlay.exec(built)
      expect(found, `no full-size view for ${shot.file}`).not.toBeNull()

      const inside = found![1]
      expect(inside, `${shot.file} has no dismissable backdrop`).toMatch(/class="lightbox-backdrop" href="#/)
      expect(inside, `${shot.file} has no close control`).toMatch(/class="lightbox-close" href="#/)
      expect(inside, `${shot.file} does not show its own image`).toContain(`src="screenshots/${shot.file}"`)
    }
  })

  it('returns a reader to the gallery rather than the top of the page', () => {
    // Closing a shot opened two thirds of the way down by clearing the fragment would scroll the
    // reader back to the hero, which reads as the page having reloaded itself.
    for (const shot of galleryShots()) {
      const id = shot.file.replace(/\.png$/, '')
      const overlay = new RegExp(`<div class="lightbox" id="shot-${id}"[^>]*>([\\s\\S]*?)</div>`)
      const inside = overlay.exec(built)![1]
      expect(inside, `${shot.file} closes to the top of the page`).not.toMatch(/href="#"/)
      expect(inside).toContain('href="#gallery"')
    }
    expect(built, 'the gallery has no id to return to').toMatch(/<section class="gallery" id="gallery">/)
  })

  it('shows the hero exactly as the manifest describes it', () => {
    // The hero img is hand-written in site/index.html, because it is the only one that loads
    // eagerly. That makes it the one place a screenshot can still be named twice - and this is
    // what stops the two copies disagreeing. Without it, renaming a file or rewriting its alt text
    // in the manifest would fix the gallery and the README and quietly leave the hero behind.
    const hero = heroShot()
    const tag = /<div class="hero-shot">[\s\S]*?<img([^>]*)>/.exec(built)
    expect(tag, 'the hero shot is gone from the built page').not.toBeNull()

    expect(tag![1]).toContain(`src="screenshots/${hero.file}"`)
    expect(tag![1]).toContain(`alt="${hero.alt}"`)
  })
})

describe('the README screenshot block', () => {
  // The same shape as apps/server/test/tools-doc-drift.test.ts uses for TOOLS.md, and for the same
  // reason: `readmeScreenshots()` is the function `pnpm readme:screenshots` writes the block with,
  // so comparing it against the checked-in file asks whether the file is current without fetching
  // or spawning anything.
  const readme = readFileSync(new URL('README.md', root), 'utf8').replaceAll('\r\n', '\n')

  it('is delimited by markers, so the generator has somewhere to write', () => {
    expect(readme).toContain('<!-- screenshots:start -->')
    expect(readme).toContain('<!-- screenshots:end -->')
  })

  it('matches what the manifest renders', () => {
    // The CRLF normalisation above and nowhere else: core.autocrlf hands a Windows checkout
    // carriage returns the generator never emits, and a whole-block mismatch for that reason says
    // nothing about whether the screenshots agree.
    const block = /<!-- screenshots:start -->\n([\s\S]*?)<!-- screenshots:end -->/.exec(readme)
    expect(block, 'the markers are not in that order').not.toBeNull()
    expect(block![1]).toBe(readmeScreenshots())
  })

  it('shows or links every screenshot the landing page does', () => {
    // The drift this whole manifest exists to stop, asserted directly rather than inferred from
    // the two blocks matching: a shot that reached the site and not the README used to be one
    // forgetful commit away, and nothing failed when it happened.
    for (const shot of SCREENSHOTS) {
      expect(readme, `${shot.file} is on the landing page but not in the README`)
        .toContain(`assets/screenshots/${shot.file}`)
    }
  })
})
