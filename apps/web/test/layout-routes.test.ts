import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../src/routes.js'
import { STEPS } from '../src/setup/SetupApp.js'

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url)), 'utf8'))

const listed = read('layout-check-routes.json') as string[]
const screens = read('layout-check-boot-screens.json') as { screen: string, url: string }[]

// pathForStep in SetupApp.tsx falls through to this for any step STEPS does not name, which in
// practice is 'done' - the wizard's last two screens, both at this one address. Written out here
// rather than imported because pathForStep returns it rather than exporting it; if it ever moves,
// the harness stops finding `.data-type-row input` and `.setup-horizon` and says so loudly.
const BACKFILL_PATH = '/setup/backfill'

// The one step in STEPS that no harness in this repository measures, and it is a state rather
// than an address: `consent` shares `/setup/google` with `google-client`, and reaching it means
// completing a real OAuth redirect to Google, which nothing here can walk.
//
// Named, because the assertion below used to dissolve it. Deduplicating the wizard's paths through
// a Set made consent "covered" by the console step next door - same address, different screen -
// while scripts/layout-check-boot.mjs stops at the console step and says so in place. Two steps at
// one URL is exactly the shape `/setup/backfill` already has, where the harness measures both
// states and declares them as two screens; consent is the one that cannot be reached, and a test
// that cannot say so is a test that reports full coverage of a wizard it has not fully seen.
const UNREACHABLE_STEPS = ['consent']

// Two harnesses, two lists, and neither list is the other's business.
//
// `pnpm layout:check` drives the built demo: an already-signed-in instance against a recorded
// database, which is exactly the nine pages ROUTES declares and nothing else. Its list is held
// against ROUTES below, the way it always has been.
//
// `pnpm layout:check:boot` boots a real server against a temporary directory to reach the screens
// the demo cannot render at all - the setup wizard, which needs an instance whose setup is
// unfinished, and the sign-in screen, which needs one whose setup is finished and nobody signed
// in. None of those is in ROUTES and none of them ever will be: the shell does not route to them,
// it falls into them, out of what the session query answered. Bolting them onto the list above
// would have made that list a lie about what ROUTES contains; so the second harness declares its
// own screens, and what is checked here is that the declaration covers the wizard end to end.
describe('the layout check route list', () => {
  // Every route in ROUTES, parameterised ones included, listed as ROUTES.tsx itself spells them -
  // `/activity/:sessionId` and `/sleep/night/:localDate` as literal templates, `:` and all. A page
  // nobody checks at 375px is a page that silently goes back to being 700px wide, and that risk
  // does not go away just because a route also happens to take a parameter.
  //
  // scripts/layout-check.mjs is what turns those two templates into real URLs before it opens
  // them: it reads the built demo's own capture manifest (dist-demo/demo-api/manifest.json) for a
  // real session id (off a captured `/sessions/:id` read) and a real night date (off a captured
  // single-day `/sleep/nights?from=X&to=X` read), and substitutes them in. Never hardcoded here or
  // there - a re-capture reassigns every id (capture-demo.mjs's writeCapture hashes each URL), and
  // a hardcoded id would rot into a 404 the SPA renders as an empty page nothing here would notice.
  it('lists every route in ROUTES', () => {
    const expected = ROUTES.map((r) => r.path)
    expect([...listed].sort()).toEqual([...expected].sort())
  })
})

describe('the boot layout check screen list', () => {
  // STEPS is the wizard's own table of which path each step lives at, and it is what SetupApp
  // redirects to when the server says a different step is due. Every step but the one
  // UNREACHABLE_STEPS names, plus the two screens at BACKFILL_PATH, which STEPS does not list
  // because pathForStep falls through to it.
  it('covers every wizard step except the one that needs a real Google redirect', () => {
    const reachable = STEPS.filter((step) => !UNREACHABLE_STEPS.includes(step.step))
    const wizard = [...new Set([...reachable.map((step) => step.path), BACKFILL_PATH])]
    const covered = new Set(screens.map((entry) => entry.url))
    expect(wizard.filter((path) => !covered.has(path))).toEqual([])
  })

  // The guard on the exclusion, which is the half that keeps it from growing quietly. A name in
  // UNREACHABLE_STEPS that no longer matches a step excuses nothing and shrinks what the
  // assertion above covers without anybody noticing; a second name appearing there is a second
  // screen going unmeasured, and it has to be argued for in the comment beside it rather than
  // typed into a list.
  it('excuses exactly the steps it names, and those steps exist', () => {
    expect(UNREACHABLE_STEPS.filter((name) => !STEPS.some((step) => step.step === name))).toEqual([])
    expect(UNREACHABLE_STEPS).toEqual(['consent'])
  })

  // Not a path, which is the whole reason it needs saying. Sign-in is a state the shell is in -
  // a session query that answered 401 - so it renders over whichever URL the reader happened to
  // open, and the harness measures it at '/'. Named rather than matched on its URL for that
  // reason: '/' is also the dashboard, which the other harness covers.
  it('covers the sign-in screen, which is a state rather than a route', () => {
    expect(screens.map((entry) => entry.screen)).toContain('sign in')
  })

  // The two harnesses do not overlap, and this is what keeps them from quietly converging: a
  // wizard path that turned up in ROUTES would mean the demo could reach it after all, and a
  // second check of the same screen would be the cheaper of the two problems.
  it('claims no screen ROUTES already declares', () => {
    const routePaths = new Set(ROUTES.map((r) => r.path))
    const wizard = screens.map((entry) => entry.url).filter((url) => url.startsWith('/setup/'))
    expect(wizard.filter((url) => routePaths.has(url))).toEqual([])
    expect(wizard.length).toBeGreaterThan(0)
  })

  // The declaration is only worth anything if it is the same list the harness actually drives, so
  // scripts/layout-check-boot.mjs fails its own run when what it measured is not exactly this set.
  // What that cannot catch is a duplicate name, which would let one screen stand in for two.
  it('names each screen once', () => {
    const names = screens.map((entry) => entry.screen)
    expect([...new Set(names)]).toHaveLength(names.length)
  })
})
