// The second layout harness, for the two screens the first one cannot reach.
//
// layout:check drives the built demo, which is an already-signed-in instance against a seeded,
// recorded database. The setup wizard and the sign-in screen are unreachable from it by
// construction - the demo has no server to ask, and its session never expires - so neither had
// ever been measured at any viewport. This boots a real instance against a temporary directory
// instead, walks the wizard, and measures the same two things layout:check measures: no page
// wider than the screen it is on, and no control a finger cannot hit.
//
// A second script rather than a flag on the first: that one needs a demo build and a capture
// manifest and never starts a server; this one needs a server, a data directory that it creates
// and destroys, and no build artefacts beyond apps/web/dist. Same assertions, different subject
// and different lifecycle. What they do share - the viewports and the hit-area sweep - lives in
// layout-shared.mjs, imported by both, so the rule cannot drift into two versions of itself.
//
// Usage: pnpm layout:check:boot   (expects apps/web/dist, built with `pnpm build`)
//
// Two instances, because the screens need opposite states of the same instance:
//
//   1. An empty directory answers `setup_incomplete`, which is the wizard at its first step. The
//      account, address and Google steps are walked here, each one measured before the request
//      that advances past it.
//   2. A seeded directory (scripts/seed-demo.mjs) has setup already finished, which is the only
//      state in which the sign-in screen and the backfill screen exist at all: sign-in is what a
//      finished instance shows somebody with no session, and the backfill screen is the step
//      after setup is done.
//
// On the account this creates: it is a throwaway local account inside a temporary directory this
// script made and deletes again, which is what apps/server/test/harness.ts's completeSetup
// already does for the test suite and what scripts/seed-demo.mjs does for the demo. Both of those
// reach into the stores directly because they have no server in front of them; this one has a
// server, so it walks the wizard's own API - the same three requests the screens themselves
// issue - rather than opening the database behind its back. seed-demo.mjs's header explains why a
// fourth hand-rolled bypass must not be invented, and this is not one: the instance below is
// finished by the wizard, through the wizard's routes, or by seed-demo.mjs itself.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { PHONE, SETTLE_MS, TOUCH_MIN, describeTargets, smallTargets } from './layout-shared.mjs'

const WEB_DIST = resolve('apps/web/dist')
const SERVER_ENTRY = resolve('apps/server/src/index.ts')
const SEED_SCRIPT = resolve('scripts/seed-demo.mjs')

// Every screen this harness measures, declared in a file rather than only in the code below, so
// apps/web/test/layout-routes.test.ts can hold it against the wizard's own step table. Two entries
// share a URL: /setup/backfill renders the data-type picker first and the progress screen after,
// on SetupApp's own local state rather than on the path, so they are two screens at one address.
// The run fails if what it actually measured is not exactly this set - that is what keeps the file
// load bearing instead of decorative.
const SCREENS = JSON.parse(await readFile(resolve('scripts/layout-check-boot-screens.json'), 'utf8'))

// The wizard needs a timezone the server will accept (isKnownTimezone in routes/setup.ts) and a
// password of at least eight characters (AccountStore.create). Fixed rather than random: this
// account lives for the length of one run inside a directory this process deletes afterwards, and
// a value nobody can predict would only make a failing run harder to reproduce by hand.
const WIZARD_ACCOUNT = {
  displayName: 'Layout Check',
  username: 'layoutcheck',
  password: 'a good long password',
  timezone: 'Europe/Amsterdam',
}
// seed-demo.mjs's own published credentials, which is the whole reason this harness uses it
// rather than seeding by hand: the values are already in the repository, beside the script that
// writes them, and correct for nothing but a directory that script just created.
const SEEDED_ACCOUNT = { username: 'demo', password: 'demodemo' }
// Three days rather than the seeder's 365. Nothing here reads a single data point - the screens
// being measured are the wizard's, and what they need is an instance whose setup is finished -
// so the archive only has to be big enough for the rebuild the seeder runs to have something to
// do and report, which is what proves the seed worked at all.
const SEED_DAYS = 3

const failures = []
function check(condition, label) {
  if (!condition) failures.push(label)
}

// The complete list, per screen, of every control under 44px. `check` above records a one-line
// summary capped at five entries, which is the right length for a CI log; this is the full
// inventory, printed at the end, because the whole point of a first run against a screen nobody
// has ever measured is the list itself.
const inventory = []
const measured = new Set()

if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error('No web build found. Run: pnpm build')
  process.exit(1)
}

// A port the operating system just told us was free, rather than 4235. The server reads
// HAELAN_PORT and does not read PORT (apps/server/src/config.ts), and 4235 is where a developer's
// own instance and `pnpm dev:server` both listen - binding it here would either fail or, worse,
// leave this harness measuring somebody's real instance. There is a gap between closing the probe
// and the server binding, which is why each boot below takes its own port immediately before
// spawning rather than reserving both up front.
function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })
}

function run(argv, env) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', fail)
    child.on('exit', (code) => {
      if (code === 0) ok(output)
      else fail(new Error(`${argv.join(' ')} exited ${code}:\n${output}`))
    })
  })
}

// Every instance this run started, so the finally below can close all of them whatever went wrong
// in the middle. M7a shipped a harness that leaked a Chromium process on any thrown error and it
// took a review to catch; a leaked server process here would additionally hold the SQLite file
// open, so the temporary directory would survive the run as well.
const instances = []

/**
 * A server on its own port against its own temporary directory, empty unless `seed` asks for the
 * demo seed. Resolves once the process has said it is listening.
 */
async function boot({ seed = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'haelan-layout-'))
  const port = await freePort()
  const env = { HAELAN_DATA_DIR: dir, HAELAN_PORT: String(port), HAELAN_HOST: '127.0.0.1' }
  const instance = { dir, port, base: `http://127.0.0.1:${port}`, child: null, log: '' }
  instances.push(instance)

  // Before the server opens the directory, not after: seed-demo.mjs refuses to write over an
  // existing database, and the server creates one on boot.
  if (seed) await run(['--experimental-strip-types', SEED_SCRIPT, dir, String(SEED_DAYS)], env)

  const child = spawn(process.execPath, ['--experimental-strip-types', SERVER_ENTRY], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  instance.child = child

  await new Promise((ok, fail) => {
    // Generous, because a cold boot pays for the type stripper before it pays for anything else
    // (see rebuildInWorker.ts's own account of what WebAssembly instantiation costs per process),
    // and a CI runner is slower than this machine.
    const timer = setTimeout(() => fail(new Error(`the server did not listen within 60s:\n${instance.log}`)), 60_000)
    const settle = (outcome) => { clearTimeout(timer); outcome() }
    const watch = (chunk) => {
      instance.log += chunk
      if (instance.log.includes(`listening on http://127.0.0.1:${port}`)) settle(() => ok())
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('error', (error) => settle(() => fail(error)))
    // A process that exits before it says it is listening has failed to start, and the only
    // useful thing to say about it is whatever it managed to print first.
    child.on('exit', (code) => settle(() => fail(new Error(`the server exited ${code} before listening:\n${instance.log}`))))
  })
  return instance
}

async function shutdown(instance) {
  const { child } = instance
  if (child !== null && child.exitCode === null) {
    await new Promise((done) => {
      // SIGTERM is what index.ts's own shutdown hook listens for, so on a POSIX runner this is a
      // clean close of the database. Windows has no signals and kill() terminates outright, which
      // is why the removal below retries: the file handle goes with the process either way, but
      // not always before the next statement runs.
      const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 10_000)
      child.on('exit', () => { clearTimeout(timer); done() })
      child.kill('SIGTERM')
    })
  }
  await rm(instance.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

let crashError = null
let browser = null
try {
  browser = await chromium.launch()
  // The locale is pinned rather than inherited. i18n/index.tsx picks the catalogue off
  // navigator.language, so an unpinned run measures English on a CI runner and Dutch on a Dutch
  // developer's machine - two different sets of strings, and so two different widths, from the
  // same command. English because it is the app's own fallbackLng and what the runner would have
  // chosen anyway, which keeps a local run and a CI run comparable. Confirmed by hand that the
  // Dutch catalogue produces the identical inventory at this viewport: every failure below is a
  // height, and the one width among them still clears the screen.
  const page = await browser.newPage({ viewport: PHONE, locale: 'en-US' })

  const measure = () => page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))

  /**
   * Same-origin, from inside the page, rather than from node: the session the wizard mints is an
   * httpOnly cookie, and a request issued from this process would set it on this process. Every
   * screen after the account step needs that cookie in the browser, which means the browser has
   * to be the one that asked.
   */
  const post = async (path, payload) => {
    const answer = await page.evaluate(async ({ path, payload }) => {
      const response = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.text() }
    }, { path, payload })
    if (answer.status >= 400) throw new Error(`POST ${path} answered ${answer.status}: ${answer.body}`)
    return answer
  }

  /**
   * Opens a screen and waits for something only that screen renders. The marker is the guard
   * against measuring the wrong thing: SetupApp asks the server which step is due and redirects
   * when the answer disagrees with the path, so a request that silently failed to advance the
   * wizard shows up here as a selector that never appears rather than as a second, cleaner
   * measurement of the screen before it.
   *
   * `domcontentloaded` rather than `networkidle`: the backfill screen opens an EventSource for
   * live progress and keeps it open, so the network never goes idle on it.
   */
  async function open(instance, url, marker) {
    await page.goto(`${instance.base}${url}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(marker, { timeout: 20_000 })
    await page.waitForTimeout(SETTLE_MS)
  }

  function record(screen) {
    if (!SCREENS.some((entry) => entry.screen === screen)) {
      throw new Error(`${screen} is measured here but not declared in layout-check-boot-screens.json`)
    }
    measured.add(screen)
  }

  async function measureScreen(screen) {
    record(screen)
    const { scrollWidth, clientWidth } = await measure()
    check(scrollWidth <= clientWidth, `${screen} is ${scrollWidth}px wide in a ${clientWidth}px viewport`)
    const small = await smallTargets(page, null)
    inventory.push({ screen, scrollWidth, clientWidth, small })
    check(
      small.length === 0,
      `${screen}: ${small.length} control(s) below ${TOUCH_MIN}px: ${describeTargets(small)}`,
    )
  }

  // ---- The wizard, against an empty directory -------------------------------------------------

  const fresh = await boot()

  await open(fresh, '/setup/account', 'input[autocomplete="new-password"]')
  await measureScreen('the account step')
  await post('/api/setup/account', WIZARD_ACCOUNT)

  await open(fresh, '/setup/instance-url', '.choice')
  await measureScreen('the address step')
  // The instance's own origin, which is what InstanceUrlStep itself proposes (it defaults the
  // field to window.location.origin) and what candidateFor accepts: 127.0.0.1 is loopback, so it
  // is registrable without https.
  await post('/api/setup/instance-url', { baseUrl: fresh.base, consentPath: 'localhost' })

  await open(fresh, '/setup/google', '.setup-instructions')
  await measureScreen('the Google step')

  // The wizard stops here. The step after this one is consent, which is a real redirect to Google
  // and cannot be walked by anything in this repository; the two screens past it are measured
  // against the seeded instance below, where setup is already finished.

  // ---- Sign-in and the steps after setup, against a seeded directory ---------------------------

  const seeded = await boot({ seed: true })

  // No session on this instance yet, so every path renders the sign-in screen. Measured at '/',
  // which is where somebody opening a finished instance actually lands - there is no /signin
  // route, because sign-in is the state the shell is in rather than a page it routes to.
  await open(seeded, '/', 'main.signin form')
  await measureScreen('sign in')
  await post('/api/auth/login', SEEDED_ACCOUNT)

  // SetupApp keeps "the data-type screen has been shown" in sessionStorage rather than on the
  // server, because setupStep has no value for it. Clearing and setting that key is how each of
  // the two screens at /setup/backfill is reached; it is the same key SetupApp itself writes.
  const DATA_TYPES_DONE_KEY = 'haelan.setup.dataTypesDone'
  await page.evaluate((key) => sessionStorage.removeItem(key), DATA_TYPES_DONE_KEY)
  await open(seeded, '/setup/backfill', '.data-type-picker')
  await measureScreen('the data type step')

  await page.evaluate((key) => sessionStorage.setItem(key, 'true'), DATA_TYPES_DONE_KEY)
  await open(seeded, '/setup/backfill', '.setup-horizon')
  await measureScreen('the backfill step')

  for (const entry of SCREENS) {
    check(measured.has(entry.screen), `${entry.screen} is declared in layout-check-boot-screens.json but was never measured`)
  }
} catch (error) {
  crashError = error
} finally {
  // Each teardown runs independently and none may skip another: the browser is one process, each
  // instance is another plus a directory on disk, and a failure closing any of them must not
  // leave the rest behind.
  if (browser !== null) {
    await browser.close().catch((error) => console.error('layout:check:boot: browser.close() failed:', error))
  }
  for (const instance of instances) {
    await shutdown(instance).catch((error) => console.error(`layout:check:boot: could not tear down ${instance.dir}:`, error))
  }
}

if (inventory.length > 0) {
  console.log(`layout:check:boot measured ${inventory.length} screen(s) at ${PHONE.width}x${PHONE.height}:`)
  for (const entry of inventory) {
    console.log(`  ${entry.screen}: ${entry.scrollWidth}px wide in ${entry.clientWidth}px, `
      + `${entry.small.length} control(s) below ${TOUCH_MIN}px`)
    for (const target of entry.small) {
      console.log(`    - ${target.where === '' ? '' : `.${target.where} `}${target.tag}.${target.cls} `
        + `${target.w}x${target.h}`)
    }
  }
}

if (crashError) {
  console.error('layout:check:boot crashed before finishing its checks:')
  console.error(crashError?.stack ?? String(crashError))
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`layout:check:boot found ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `layout:check:boot passed: ${SCREENS.length} screens at ${PHONE.width}px - the wizard walked `
  + 'against an empty data directory, and sign-in and the steps after setup against a seeded one.',
)
