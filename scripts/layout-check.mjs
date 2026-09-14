// Drives the built demo in a real browser and asserts that no page is wider than the screen it is
// on. Nothing in the vitest suite can do this: apps/web renders to static markup, and happy-dom
// has no layout engine, so a document 700px wide inside a 375px viewport is invisible to every
// test in the repository.
//
// A script rather than a test, for the reason capture-demo.mjs gives: it needs a built artifact
// and a real browser, neither of which belongs in a suite that is meant to run in seconds.
//
// Usage: pnpm layout:check   (expects apps/web/dist-demo, built with `pnpm demo:build`)
//
// The demo build serves its assets under the `/haelan/demo/` prefix - the same base the published
// site uses - rather than at the root, so the server below maps that prefix onto `dist-demo`, and
// every route URL is built underneath it.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const DIST = resolve('apps/web/dist-demo')
const ROUTES = JSON.parse(await readFile(resolve('scripts/layout-check-routes.json'), 'utf8'))
const DEMO_PREFIX = '/haelan/demo'

const PHONE = { width: 375, height: 812 }
// One pixel above the breakpoint: the rail is back, so the content column is at its narrowest of
// any width in the app, and this is where the band that scrolled sideways for the whole of M7a
// begins. Every page measured 703px there - 186px of rail, 20px of .main padding, and a 497px
// control row that would not wrap - against a 621px viewport.
const BAND = { width: 621, height: 900 }
// The rest of that band, on the one route whose control row is the widest thing on it. The upper
// end is 702 and not 719: a page needs 703px, so 703 up was always clean and a check pinned at 719
// would have passed against the broken stylesheet. Widths, not viewports - the height never
// mattered to this.
const BAND_WIDTHS = [660, 700, 702, 719]
const BAND_ROUTE = '/activity'
// A landscape phone, and the size at which the rail was measured holding 712px of content in a
// 380px column with sign-out 437px below the fold.
const SHORT = { width: 900, height: 380 }

// A tablet rotating portrait to landscape: the one gesture that crosses the breakpoint upward
// without a reload and without a second resize behind it.
const ROTATE_FROM = { width: 600, height: 960 }
const ROTATE_TO = { width: 960, height: 600 }

// How long a page is given to settle after a viewport change before it is measured. This is not a
// fix waiting out a race - that fix is in useChart, which observes its own container instead of
// the window - it is a harness leaving room for a relayout the browser has already been asked for.
// The overflow this guards was still there after two seconds, so a wait this side of that is
// measuring a settled page rather than a lucky one.
const SETTLE_MS = 500

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

function startServer() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    // Everything the demo build emits is referenced under /haelan/demo/..., so a request outside
    // that prefix has nothing behind it either - fall through to the SPA shell the same way an
    // unmatched path under the prefix does.
    const underPrefix = path === DEMO_PREFIX || path.startsWith(`${DEMO_PREFIX}/`)
    const rest = underPrefix ? path.slice(DEMO_PREFIX.length) || '/' : path
    const file = join(DIST, rest)
    // SPA fallback: the demo routes with pushState, so /haelan/demo/sleep has no file behind it.
    // This is the same behaviour the published site gets from its 404.html.
    const target = rest !== '/' && existsSync(file) && extname(file) ? file : join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
    res.end(await readFile(target))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

const failures = []
function check(condition, label) {
  if (!condition) failures.push(label)
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('No demo build found. Run: pnpm demo:build')
  process.exit(1)
}

const server = await startServer()
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch()

function routeUrl(route) {
  // route '/' must land on '/haelan/demo/', not '/haelan/demo' (no trailing slash) - the latter
  // still resolves via the SPA fallback above, but keeping the trailing slash matches the shape
  // every other route URL takes and the shape the published site actually serves.
  return route === '/' ? `${base}${DEMO_PREFIX}/` : `${base}${DEMO_PREFIX}${route}`
}

// Everything that can throw - a stuck page.goto, a selector that never appears, a page.evaluate
// against a page that never loaded - runs inside this block, so a crash still reaches the finally
// below rather than skipping it. Without this, an uncaught exception here would leak the Chromium
// child process and the still-listening server: the exact wedged-CI failure mode this check
// exists to catch, just relocated into the check itself.
let crashError = null
try {
  const page = await browser.newPage({ viewport: PHONE })

  const measure = () => page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))

  async function open(route) {
    await page.goto(routeUrl(route), { waitUntil: 'networkidle' })
    await page.waitForSelector('main', { timeout: 10_000 })
  }

  // Two widths rather than one. 375 is the phone the milestone is named for; 621 is the first
  // width above the breakpoint, where the rail is back and the content column is at its narrowest.
  for (const viewport of [PHONE, BAND]) {
    await page.setViewportSize(viewport)
    for (const route of ROUTES) {
      await open(route)
      const { scrollWidth, clientWidth } = await measure()
      check(scrollWidth <= clientWidth, `${route} is ${scrollWidth}px wide in a ${clientWidth}px viewport`)
    }
  }

  // The rest of the band, swept on one route rather than nine: what overflowed there is the
  // control row, which is the same component on every page carrying one.
  for (const width of BAND_WIDTHS) {
    await page.setViewportSize({ width, height: BAND.height })
    await open(BAND_ROUTE)
    const { scrollWidth, clientWidth } = await measure()
    check(scrollWidth <= clientWidth, `${BAND_ROUTE} is ${scrollWidth}px wide in a ${clientWidth}px viewport`)
  }

  // Crossing the breakpoint upward with no reload in between: a tablet rotating portrait to
  // landscape. Anything that measures the page while the resize event is still being dispatched
  // reads the phone layout - a full-bleed .main, no 186px rail - and keeps that width once the
  // rail comes back, leaving the page scrolling sideways until some later resize corrects it. A
  // rotation delivers no later resize, so the reader is stuck there until they rotate back.
  for (const route of ROUTES) {
    await page.setViewportSize(ROTATE_FROM)
    await open(route)
    await page.setViewportSize(ROTATE_TO)
    await page.waitForTimeout(SETTLE_MS)
    const { scrollWidth, clientWidth } = await measure()
    check(
      scrollWidth <= clientWidth,
      `${route} is ${scrollWidth}px wide in a ${clientWidth}px viewport after rotating `
        + `${ROTATE_FROM.width}x${ROTATE_FROM.height} to ${ROTATE_TO.width}x${ROTATE_TO.height}`,
    )
  }

  // The drawer, on one route rather than all nine: it is the same component every time, and what
  // is being checked is the behaviour, not the page under it.
  await page.setViewportSize(PHONE)
  await open('/')
  const hamburger = page.locator('[data-testid="rail-open"]')
  const hamburgerVisible = await hamburger.isVisible().catch(() => false)
  check(hamburgerVisible, 'no hamburger on a phone viewport')
  if (hamburgerVisible) {
    await hamburger.click()
    const dialog = page.locator('dialog.rail-dialog')
    check(await dialog.isVisible(), 'the drawer did not open')

    // Every destination by path, not a count of .rail-item. A count passes with three nav items
    // missing, because the three external resource links carry .rail-item too and make up the
    // total.
    const hrefs = await page.locator('dialog.rail-dialog a').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('href')),
    )
    for (const route of ROUTES) {
      check(hrefs.includes(`${DEMO_PREFIX}${route}`), `the drawer has no link to ${route}`)
    }

    // <dialog> makes the page behind inert for focus and for pointer targeting, and does nothing
    // at all about scrolling. The drawer is 280px of a 375px screen, so the strip beside it is a
    // live scroll surface under an open modal unless something stops it.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.mouse.move(340, 400)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(SETTLE_MS)
    const scrolled = await page.evaluate(() => window.scrollY)
    check(scrolled === 0, `the page behind the open drawer scrolled to ${scrolled}`)

    await page.keyboard.press('Escape')
    check(!(await dialog.isVisible()), 'Escape did not close the drawer')
    check(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'rail-open'),
      'focus did not return to the hamburger',
    )
  }

  // The rail foot, at the size that reproduced the defect. Above the breakpoint, so this is the
  // rail rather than the drawer.
  await page.setViewportSize(SHORT)
  await open('/')
  await page.waitForSelector('.rail-foot', { timeout: 10_000 })
  const footVisible = await page.evaluate(() => {
    const rail = document.querySelector('.rail')
    const foot = document.querySelector('.rail-foot')
    if (!rail || !foot) return null
    const r = rail.getBoundingClientRect()
    const f = foot.getBoundingClientRect()
    return {
      withinRail: f.bottom <= r.bottom + 1,
      onScreen: f.bottom <= window.innerHeight + 1,
    }
  })
  check(footVisible !== null, 'no rail or rail foot found at 900x380')
  check(footVisible?.withinRail === true, 'the rail foot is not pinned to the bottom of its scroller at 900x380')
  check(footVisible?.onScreen === true, 'the rail foot sits below the fold of the viewport at 900x380')
} catch (err) {
  crashError = err
} finally {
  // Each close runs independently: a failed browser.close() must not skip server.close(), and
  // vice versa - both are resources of this process and both must go regardless of the other.
  await browser.close().catch((err) => console.error('layout:check: browser.close() failed:', err))
  await new Promise((done) => server.close(done)).catch(() => {})
}

if (crashError) {
  console.error('layout:check crashed before finishing its checks:')
  console.error(crashError?.stack ?? String(crashError))
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`layout:check found ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `layout:check passed: ${ROUTES.length} routes at ${PHONE.width}px and ${BAND.width}px, `
    + `${BAND_ROUTE} across the rest of the band, the same routes rotated across the breakpoint, `
    + 'the drawer, and the rail foot.',
)
