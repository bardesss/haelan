// Builds the published landing page from site/index.html. The page is hand-written HTML with
// {{slot}} markers; nothing here knows what the page says, only how a slot is filled.
//
// Usage: pnpm site:build

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    if (!(name in values)) throw new Error(`no value for {{${name}}}`)
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
  writeFileSync(join(outDir, 'index.html'), renderPage(template, releaseStamp(rootDir)))
  written.push('index.html')

  for (const [from, to] of ASSETS) put(from, to)
  for (const shot of readdirSync(join(rootDir, 'assets/screenshots'))) {
    if (shot.endsWith('.png')) put(`assets/screenshots/${shot}`, `screenshots/${shot}`)
  }

  return written
}

// Run directly (pnpm site:build), not imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const outDir = join(rootDir, 'site/dist')
  const written = buildSite(rootDir, outDir)
  console.log(`wrote ${written.length} files into ${outDir}`)
}
