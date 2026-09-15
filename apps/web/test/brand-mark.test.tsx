// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { PATHS, renderIcons } from '../scripts/render-icons.mjs'
import { BrandMark } from '../src/components/BrandMark.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { SignIn } from '../src/auth/SignIn.js'
import { I18nProvider } from '../src/i18n/index.js'
import { writeCollapsed } from '../src/ui/railState.js'

// Locating the package the hard way, because neither of the usual anchors works here: this file
// runs under happy-dom inside the vite transform, where import.meta.url is an http: URL and
// fileURLToPath throws before any test runs, and cwd is the workspace root under `pnpm test` but
// apps/web under `pnpm vitest` in the package. So try both and take the one holding the app.
const WEB = [process.cwd(), resolve(process.cwd(), 'apps/web')]
  .find((dir) => existsSync(join(dir, 'src/components/BrandMark.tsx')))!
const repo = (path: string) => resolve(WEB, path)

// Same reason rail-collapse.test.tsx installs one: the ambient `localStorage` this file's render
// path reads through railState resolves to Node's inert global, not happy-dom's window's.
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true, writable: true })
})

const rail = () => renderToStaticMarkup(
  <I18nProvider lng="en"><Sidebar person="Robin" active="/sleep" onSignOut={() => {}} /></I18nProvider>,
)

describe('the mark', () => {
  const markup = renderToStaticMarkup(<BrandMark />)

  // currentColor is the whole of why one definition serves the rail, the card and the page in
  // both themes. A hard-coded fill or stroke here is the regression that would quietly need a
  // second asset back.
  it('takes its colour from whatever is painting it', () => {
    expect(markup).toContain('stroke="currentColor"')
    expect(/(fill|stroke)="#[0-9a-fA-F]{3,8}"/.test(markup)).toBe(false)
  })

  it('sits on the same 24 box as the nav icons', () => {
    expect(markup).toContain('viewBox="0 0 24 24"')
  })

  // The adjacent wordmark is the accessible name on every surface that uses this, so the mark
  // itself must not announce a second one.
  it('is decorative', () => {
    expect(markup).toContain('aria-hidden="true"')
  })
})

describe('the rail wears the mark', () => {
  it('shows the mark beside the wordmark when expanded', () => {
    const markup = rail()
    expect(markup).toContain('class="brand-mark"')
    expect(markup).toContain('<span>Hælan</span>')
  })

  // The point of the mark on this surface: collapsed, `label()` sends the wordmark to sr-only and
  // the brand row used to be left holding nothing but a chevron.
  it('keeps the mark when the wordmark is clipped away', () => {
    writeCollapsed(true)
    const markup = rail()
    expect(markup).toContain('class="brand-mark"')
    expect(markup).toContain('<span class="sr-only">Hælan</span>')
  })
})

describe('the sign-in card wears the mark', () => {
  it('opens with the mark rather than straight into the heading', () => {
    const markup = renderToStaticMarkup(<I18nProvider lng="en"><SignIn onSignedIn={() => {}} /></I18nProvider>)
    expect(markup).toContain('class="brand-mark"')
  })
})

// SetupApp reads its step from the router and its state from the data hooks, so it is not worth a
// render harness here for one div. Read as source instead: this asserts the surface composes the
// same component as the other two, which is the property that matters and the one that would
// break if someone reintroduced a bare text wordmark.
describe('the setup column wears the mark', () => {
  const source = readFileSync(repo('src/setup/SetupApp.tsx'), 'utf8')

  it('renders BrandMark inside the brand line', () => {
    expect(source).toContain('<BrandMark />')
    expect(/className="setup-brand">\s*<BrandMark \/>/.test(source)).toBe(true)
  })
})

// The mark's geometry lives in scripts/render-icons.mjs, and three files write it out again
// because none of them can read that script at runtime: a React component, a tab icon and a
// README image. Nothing else pins them together, and a mark that differs between the rail and the
// tab is the kind of drift nobody reports as a bug.
describe('one geometry, written out in four places', () => {
  const read = (path: string) => readFileSync(repo(path), 'utf8')
  const sources = {
    'BrandMark.tsx': read('src/components/BrandMark.tsx'),
    'favicon.svg': read('public/favicon.svg'),
    'mark.svg': read('../../assets/brand/mark.svg'),
  }

  it.each(Object.entries(sources))('%s carries the same two paths', async (_name, source) => {
    const { PATHS } = await import('../scripts/render-icons.mjs')
    expect(source).toContain(PATHS.stems)
    expect(source).toContain(PATHS.pulse)
  })

  // The raster icons are generated, so the only thing that can rot is the checked-in output. A
  // rerun must produce the bytes that are committed.
  //
  // Two things were wrong with the first cut of this, and both were invisible while it passed.
  // It compared two files, `favicon.ico` and `apple-touch-icon.png`, and M7c taught the script to
  // write five. So a change to PWA_STROKE_WIDTH, PWA_ICON_SIZES, MARK_CENTER or scaleForSafeZone
  // moved the three PWA icons and neither of the two it compared: the test passed, and a clean CI
  // checkout - which never runs a renderer - would ship the stale committed bytes.
  //
  // It also ran the real script against the real `public/`, so the rerun it compared against was
  // a rerun that had already overwritten the evidence. Rendering into a temporary directory keeps
  // the working tree out of it entirely, and lets the file list itself be checked rather than
  // hand-maintained: a sixth output added to renderIcons() fails the first expectation below
  // instead of quietly going uncompared the way the three PWA icons did.
  const RENDERED = [
    'apple-touch-icon.png',
    'favicon.ico',
    'icon-192.png',
    'icon-512-maskable.png',
    'icon-512.png',
  ]

  it('the committed rasters are what the script renders, all of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-icons-'))
    mkdirSync(join(dir, 'public'))
    renderIcons(dir)

    expect(readdirSync(join(dir, 'public')).sort()).toEqual(RENDERED)
    for (const name of RENDERED) {
      const fresh = readFileSync(join(dir, 'public', name))
      const committed = readFileSync(repo(join('public', name)))
      expect(fresh.equals(committed), `public/${name} is not what render-icons.mjs renders`).toBe(true)
    }

    // After the assertions, never in a finally: an rmSync that throws there replaces whichever
    // expectation actually failed with its own error, and this directory is in the OS temp tree
    // either way.
    rmSync(dir, { recursive: true, force: true })
  })
})

// The wordmark is the display spelling; the typed identity stays `haelan` because that is the
// package, the image, the command and the URL. This pins the boundary: prose a reader is meant to
// act on must not acquire a character they cannot type.
describe('the display spelling stays out of the instructions', () => {
  const en = readFileSync(repo('src/i18n/en.json'), 'utf8')

  it('never puts æ in the copy catalogue', () => {
    expect(en).not.toContain('æ')
  })
})
