// Builds the published landing page from site/index.html. The page is hand-written HTML with
// {{slot}} markers; nothing here knows what the page says, only how a slot is filled.
//
// Usage: pnpm site:build

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { galleryShots, SCREENSHOTS } from './screenshots.mjs'

/**
 * Fills every {{slot}} in `template` from `values`.
 *
 * Both directions are errors rather than warnings. A slot with no value ships a page reading
 * "haelan {{version}}" to a stranger, and a value with no slot is what a renamed slot leaves
 * behind - the page then quietly stops naming the release it was built from, which is the one
 * thing on it that is supposed to be unable to go stale.
 */
export function renderPage(template, values) {
  const used = new Set()
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`no value for {{${name}}}`)
    used.add(name)
    return values[name]
  })
  const unused = Object.keys(values).filter((name) => !used.has(name))
  if (unused.length > 0) throw new Error(`values nothing uses: ${unused.join(', ')}`)
  return out
}

/**
 * What the page says about the release it was built from: the version in package.json, and the
 * date release-please stamped on that version's heading in CHANGELOG.md.
 *
 * The changelog rather than the release event, so that a build on a laptop and a build in the
 * workflow produce the same bytes. A missing entry throws rather than falling back to today:
 * "today" would be the build date wearing a release date's clothes.
 */
/**
 * Ninety-one consecutive days of steps, ending on the demo's own last day (2026-09-06).
 *
 * Real values, read out of the demo capture's own `/series` fixture rather than invented here, so
 * the ribbon on the landing page is the same data the demo itself serves one directory over. They
 * are inlined rather than read at build time on purpose: `site:build` has to work with no capture
 * on disk (that is what publishes the landing page on its own), and a marketing page quietly
 * changing shape because someone reran a capture would be worse than a number that is pinned.
 *
 * Regenerate with, from a tree that has run `pnpm demo:capture`:
 *   node -e "…read demo/capture/out/manifest.json, take the steps series, slice(-91)…"
 */
const RIBBON_STEPS = [
  11548, 7047, 6898, 12068, 7067, 6927, 13460, 4224, 7160, 14340, 6891, 6775, 13987,
  6953, 4310, 11965, 7366, 6892, 14624, 7141, 7126, 9042, 7095, 7019, 10547, 6839,
  7017, 14319, 4442, 7136, 11534, 7084, 7058, 15195, 7257, 4236, 12566, 7225, 7161,
  13138, 7214, 7138, 8529, 7077, 7414, 14264, 7267, 7176, 12126, 4358, 7158, 10489,
  7099, 7110, 11569, 6966, 4233, 12974, 7223, 7122, 11791, 7242, 6833, 11172, 7236,
  7240, 14289, 7228, 7115, 13170, 4212, 6919, 15623, 7095, 7123, 11499, 6893, 4183,
  11796, 7280, 7063, 13895, 7074, 7209, 7432, 7199, 7218, 12989, 7378, 6999, 15031,
]

/**
 * One `<i>` per day, height as a percentage of the busiest day.
 *
 * Built here rather than written into site/index.html because ninety-one hand-written elements
 * would bury the rest of the page in markup, and because the only thing that varies is a number
 * the array above already holds. Inline height and nothing else: every colour, radius and gap is
 * a token in site.css, which is what keeps the no-raw-colour rule true of this page too.
 */
export function ribbonHtml() {
  const peak = Math.max(...RIBBON_STEPS)
  return RIBBON_STEPS
    .map((steps) => `<i style="height:${((steps / peak) * 100).toFixed(1)}%"></i>`)
    .join('')
}

/** The fragment a shot's full-size view lives at, derived from the file name so nothing names it twice. */
export function shotId(shot) {
  return `shot-${shot.file.replace(/\.png$/, '')}`
}

/**
 * Where the close control on a shot's full-size view points.
 *
 * Not `#` alone for the gallery shots: clearing the fragment sends the reader back to the top of
 * the page, so closing a screenshot two thirds of the way down would silently lose their place.
 * Pointing at the section they opened it from puts them back where they were. The hero has no
 * section above it to return to, and the top of the page is where it already is.
 */
function closeHref(shot) {
  return shot.role === 'hero' ? '#' : '#gallery'
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
function attr(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Escapes a string for use as HTML text. */
function text(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The gallery figures: every screenshot that is not the hero, in manifest order.
 *
 * Each image is wrapped in a link to its own full-size view rather than carrying one alongside,
 * so the thing a reader instinctively clicks - the picture - is the thing that opens it.
 */
export function galleryHtml() {
  return galleryShots()
    .map((shot) => (
      `<figure>`
      + `<a class="shot-link" href="#${shotId(shot)}">`
      + `<img src="screenshots/${shot.file}" alt="${attr(shot.alt)}" width="1440" height="900" loading="lazy" />`
      + `</a>`
      + `<figcaption>${text(shot.title)}</figcaption>`
      + `</figure>`
    ))
    .join('')
}

/**
 * One full-size view per screenshot, parked at the end of the document and revealed by `:target`.
 *
 * No JavaScript, which is what keeps this page a page: it loads nothing and runs nothing, and the
 * no-telemetry line in the footer stays literally true rather than true-with-an-asterisk. The cost
 * is two things a scripted lightbox would give and this one cannot - Escape does not close it, and
 * the page behind it still scrolls - so the ways out are made obvious instead: the whole backdrop
 * is a link, there is a labelled close control, and the browser's own Back button works because
 * opening one is a navigation.
 *
 * `role="dialog"` is deliberately absent. Without script there is no focus trap and no way to
 * return focus on close, and announcing a dialog that behaves like nothing of the sort is worse
 * for a screen reader than the plain labelled region this actually is.
 */
export function lightboxHtml() {
  return SCREENSHOTS
    .map((shot) => {
      const exit = closeHref(shot)
      return `<div class="lightbox" id="${shotId(shot)}" aria-label="${attr(shot.title)}, full size">`
        + `<a class="lightbox-backdrop" href="${exit}" aria-label="Close the full-size ${attr(shot.title)} screenshot"></a>`
        + `<figure class="lightbox-figure">`
        + `<img src="screenshots/${shot.file}" alt="${attr(shot.alt)}" width="1440" height="900" loading="lazy" />`
        + `<figcaption>${text(shot.title)}<a class="lightbox-close" href="${exit}">Close</a></figcaption>`
        + `</figure>`
        + `</div>`
    })
    .join('')
}

export function releaseStamp(rootDir) {
  const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const changelog = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8')
  // Escape every regex metacharacter: semver permits build metadata with a literal `+`
  // (e.g. 1.16.0+build.5), and `+` is a regex quantifier, so the heading regex would fail
  // to match a heading that is actually present if the version is not fully escaped.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*\\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm')
  const found = heading.exec(changelog)
  if (found === null) throw new Error(`no CHANGELOG.md entry for ${version}`)
  return { version, releaseDate: found[1] }
}

// Source path relative to the repository root, then the path it is published at. The table is
// here rather than derived from the page's own markup: a build that discovers its inputs by
// parsing HTML would silently publish nothing when a tag was mistyped, and the test in
// scripts/test/site-assets.test.ts checks the two agree from the other direction.
const ASSETS = [
  ['packages/tokens/dist/theme.css', 'theme.css'],
  ['site/site.css', 'site.css'],
  ['assets/brand/mark.svg', 'mark.svg'],
  ['apps/web/public/favicon.svg', 'favicon.svg'],
  ['apps/web/public/favicon.ico', 'favicon.ico'],
  ['apps/web/public/apple-touch-icon.png', 'apple-touch-icon.png'],
]

/**
 * Recursively copies every file under `dir` into `into`, returning the published (web) path of
 * each one written, joined with `/` regardless of platform.
 */
function copyTree(dir, into, publishedPrefix, written) {
  mkdirSync(into, { recursive: true })
  for (const entry of readdirSync(dir)) {
    const from = join(dir, entry)
    const to = join(into, entry)
    const published = `${publishedPrefix}/${entry}`
    if (statSync(from).isDirectory()) {
      copyTree(from, to, published, written)
    } else {
      copyFileSync(from, to)
      written.push(published)
    }
  }
}

/**
 * Publishes the demo bundle from `fromDir` (Task 5's `apps/web/dist-demo`) under
 * `<outDir>/demo/`, and reports the paths it wrote.
 *
 * GitHub Pages has no SPA fallback, so a deep link into the demo (or a refresh inside it) hits
 * Pages' own 404 page unless a 404.html exists to catch it. Copying the demo's index.html there
 * is the standard trick: Pages serves 404.html for any unknown path, and because it is the same
 * document the demo's own router then takes over and renders the right screen.
 *
 * Returns `[]` and writes nothing when `fromDir` does not exist, so a checkout that never ran
 * `demo:build` still gets the landing page on its own - exactly what milestone one shipped.
 */
export function copyDemo(fromDir, outDir) {
  if (!existsSync(fromDir)) return []

  const written = []
  const demoDir = join(outDir, 'demo')
  copyTree(fromDir, demoDir, 'demo', written)

  const index = readFileSync(join(demoDir, 'index.html'), 'utf8')
  writeFileSync(join(demoDir, '404.html'), index)
  written.push('demo/404.html')

  return written
}

/**
 * Writes the whole published site into `outDir` and reports the paths it wrote.
 *
 * theme.css has to exist before this runs - `pnpm --filter @haelan/tokens build:css` is its
 * producer and the `site:build` script chains the two, so a bare `node scripts/build-site.mjs`
 * against a clean checkout fails here rather than publishing a page with no palette.
 */
export function buildSite(rootDir, outDir) {
  const written = []
  const put = (from, to) => {
    const target = join(outDir, to)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(rootDir, from), target)
    written.push(to)
  }

  const template = readFileSync(join(rootDir, 'site/index.html'), 'utf8')
  mkdirSync(outDir, { recursive: true })
  const values = {
    ...releaseStamp(rootDir),
    ribbon: ribbonHtml(),
    gallery: galleryHtml(),
    lightboxes: lightboxHtml(),
  }
  writeFileSync(join(outDir, 'index.html'), renderPage(template, values))
  written.push('index.html')

  // The site root's own 404, which Pages serves for every missing path anywhere under the site -
  // including inside /demo/, because it ignores a 404.html in a subdirectory. The demo's deep
  // links depend on the redirect this file carries; site/404.html says why at length.
  put('site/404.html', '404.html')

  for (const [from, to] of ASSETS) put(from, to)
  for (const shot of readdirSync(join(rootDir, 'assets/screenshots'))) {
    if (shot.endsWith('.png')) put(`assets/screenshots/${shot}`, `screenshots/${shot}`)
  }

  written.push(...copyDemo(join(rootDir, 'apps/web/dist-demo'), outDir))

  return written
}

// Run directly (pnpm site:build), not imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const outDir = join(rootDir, 'site/dist')
  const written = buildSite(rootDir, outDir)
  console.log(`wrote ${written.length} files into ${outDir}`)
}
