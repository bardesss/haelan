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
// A landscape phone, and the size at which the rail was measured holding 712px of content in a
// 380px column with sign-out 437px below the fold.
const SHORT = { width: 900, height: 380 }

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

  for (const route of ROUTES) {
    await page.goto(routeUrl(route), { waitUntil: 'networkidle' })
    await page.waitForSelector('main', { timeout: 10_000 })
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    check(scrollWidth <= clientWidth, `${route} is ${scrollWidth}px wide in a ${clientWidth}px viewport`)
  }

  // The drawer, on one route rather than all nine: it is the same component every time, and what
  // is being checked is the behaviour, not the page under it.
  await page.goto(routeUrl('/'), { waitUntil: 'networkidle' })
  const hamburger = page.locator('[data-testid="rail-open"]')
  check(await hamburger.isVisible().catch(() => false), 'no hamburger on a phone viewport')
  if (await hamburger.isVisible().catch(() => false)) {
    await hamburger.click()
    const dialog = page.locator('dialog.rail-dialog')
    check(await dialog.isVisible(), 'the drawer did not open')
    const links = await page.locator('dialog.rail-dialog .rail-item').count()
    check(links >= ROUTES.length, `the drawer holds ${links} items, fewer than the ${ROUTES.length} routes`)
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
  await page.goto(routeUrl('/'), { waitUntil: 'networkidle' })
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
console.log(`layout:check passed: ${ROUTES.length} routes, the drawer, and the rail foot.`)
