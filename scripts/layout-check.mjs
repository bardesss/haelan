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
import {
  BAND, BAND_WIDTHS, PHONE, ROTATE_FROM, ROTATE_TO, SETTLE_MS, SHORT, TOUCH_MIN,
  describeTargets, smallTargets,
} from './layout-shared.mjs'

const DIST = resolve('apps/web/dist-demo')
const DEMO_PREFIX = '/haelan/demo'

// Every route ROUTES.tsx declares, the two parameterised detail routes included, spelled the same
// way ROUTES.tsx itself spells them (`:sessionId`, `:localDate`) - layout-routes.test.ts's own
// coverage check compares this file against ROUTES exactly, with no exclusion for a `:` segment.
// Resolved into real URLs below, once the built demo (and so its capture manifest) exists.
const RAW_ROUTES = JSON.parse(await readFile(resolve('scripts/layout-check-routes.json'), 'utf8'))

// The one route whose control row is the widest thing on it, which is where the rest of the
// band below the breakpoint is swept. Demo-specific, so it stays here rather than in the shared
// module: the boot harness has no rail and no control row to sweep.
const BAND_ROUTE = '/activity'

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

// What these two routes' checks actually prove, and what they do not. The workout page
// (`/activity/:sessionId`) shows exactly one intraday heart-rate point for every session this
// seed can produce, not merely for whichever one this capture happened to pick: seedArchive
// (packages/core/src/testing/seed.ts) writes a heart_rate sample once an hour, on the hour, for
// the whole archive, and every workout it schedules lasts under an hour and starts on the hour -
// so a workout's own window can never straddle two hourly grid points, only ever contain the one
// at its start. Confirmed against this worktree's own capture: all three recorded workout windows
// (26, 45 and 55 minutes) answer exactly 1 point, regardless of which session is chosen. Widening
// that would mean teaching the shared seed generator to sample heart rate more densely during a
// workout's own hour, which several tests outside this task pin exact counts against (
// apps/server/test/upgrade-rehearsal.test.ts's `heart_rate: 4 * 24 * SEED_DAYS`, `samples: 2492`,
// and friends, hand-verified by running the fixture and reading real row counts back) - a change
// with a real, measured cost this task's own brief did not ask for, not merely a longer capture.
// So: not widened. This route's checks below assert the honest, smaller claim - a page carrying
// one data point does not overflow and its controls are still tappable - the same claim
// `/nutrition`'s already-empty page settles for, and for the same reason.
//
// The night page (`/sleep/night/:localDate`) is not in the same spot: a night spans several hours,
// so the same hourly grid gives it several points for free - this worktree's own capture answers
// 7 to 9 points for every single-day night window recorded, a real (if coarse) trace rather than a
// single dot. Its checks below are the fuller claim the workout page's cannot honestly make.
//
// The two parameterised routes' real ids, read out of the built demo's own capture manifest
// (vite.demo.config.ts's demoFixtures plugin copies demo/capture/out/ to dist-demo/demo-api/)
// rather than out of the capture directory directly - this is the exact file the demo itself
// fetches from, so a route this check builds is guaranteed reachable by the same build it is
// checking. Never hardcoded: a re-capture reassigns every id (writeCapture hashes each URL), and a
// hardcoded id would rot into a 404 the SPA renders as an empty page - no over-wide element, no
// missing hit target - that this check would happily wave through.
const manifestPath = join(DIST, 'demo-api/manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`No capture manifest found at ${manifestPath}. Run: pnpm demo:capture && pnpm demo:build`)
  process.exit(1)
}
const manifestUrls = Object.keys(JSON.parse(await readFile(manifestPath, 'utf8')))

// A real session id, read off a captured `/sessions/:id` detail read (sessionPath in
// useWorkoutSession.ts) rather than off the `/sessions` list, which never appears in the manifest
// under a URL carrying an id at all.
const SESSION_ID = manifestUrls
  .map((url) => url.match(/^\/api\/v1\/p\/[^/]+\/sessions\/([0-9a-f]+)$/))
  .find((match) => match !== null)?.[1] ?? null

// A real night's own local date, read off exactly the single-day `{from: localDate, to: localDate}`
// read NightDetail.tsx's own useNights call makes (its own comment: a Night has no id, only a
// (localDate, sourceId) pair) - not off a week/month list request, which answers with several
// nights at once and names none of them in its own URL.
const NIGHT_DATE = manifestUrls
  .map((url) => url.match(/^\/api\/v1\/p\/[^/]+\/sleep\/nights\?from=([^&]+)&to=([^&]+)$/))
  .find((match) => match !== null && match[1] === match[2])?.[1] ?? null

if (SESSION_ID === null || NIGHT_DATE === null) {
  console.error(
    'layout:check could not find both a workout session and a night in the capture manifest '
    + `(session: ${SESSION_ID}, night: ${NIGHT_DATE}) - the seed this capture ran against produced `
    + 'no exercise session or no night in the window record.tsx sweeps.',
  )
  process.exit(1)
}

const ROUTE_PARAMS = { sessionId: SESSION_ID, localDate: NIGHT_DATE }

function resolveRoute(route) {
  return route.replace(/:(\w+)/g, (whole, name) => {
    const value = ROUTE_PARAMS[name]
    if (value === undefined) throw new Error(`layout-check-routes.json names an unresolvable parameter ${whole} in ${route}`)
    return value
  })
}

// Resolved, concrete URLs for every sweep below. RAW_ROUTES (the unresolved templates) is still
// used on its own further down, where the check needs to tell a parameterised route apart from one
// the rail can actually link to.
const ROUTES = RAW_ROUTES.map(resolveRoute)

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

  // Opens the phone drawer on the route already loaded, and answers whether it opened. A fresh
  // `open()` closes it again, so nothing needs to close it here.
  async function openDrawer() {
    const hamburger = page.locator('[data-testid="rail-open"]')
    if (!(await hamburger.isVisible().catch(() => false))) return false
    await hamburger.click()
    return await page.locator('dialog.rail-dialog').isVisible().catch(() => false)
  }

  await page.setViewportSize(PHONE)
  for (const route of ROUTES) {
    await open(route)
    const onPage = await smallTargets(page, null)
    check(
      onPage.length === 0,
      `${route}: ${onPage.length} control(s) below ${TOUCH_MIN}px: ${describeTargets(onPage)}`,
    )

    // Every route rather than one: the drawer is the same component each time, but which item
    // carries `aria-current` is not, and that is the one item with a different background, weight
    // and colour from the other eleven.
    const opened = await openDrawer()
    check(opened, `${route}: the drawer did not open on a phone viewport`)
    if (!opened) continue
    const inDrawer = await smallTargets(page, 'dialog.rail-dialog')
    check(
      inDrawer.length === 0,
      `${route}: ${inDrawer.length} drawer control(s) below ${TOUCH_MIN}px: ${describeTargets(inDrawer)}`,
    )
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
    // total. Unparameterised routes only: a workout or a night has no rail link of its own (routes.tsx's
    // own `rail` field points a parameterised route back at '/activity' or '/sleep' instead), so
    // the drawer was never going to carry a literal `/activity/:sessionId` href to find.
    const hrefs = await page.locator('dialog.rail-dialog a').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('href')),
    )
    for (const route of RAW_ROUTES.filter((r) => !r.includes(':'))) {
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
    + `hit areas on each of them with the drawer shut and again with it open, `
    + `${BAND_ROUTE} across the rest of the band, the same routes rotated across the breakpoint, `
    + 'the drawer, and the rail foot.',
)
