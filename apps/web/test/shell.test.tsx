import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar, RAIL_PATHS } from '../src/components/Sidebar.js'
import { ROUTES, NIGHT_ROUTE } from '../src/routes.js'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Activity } from '../src/pages/Activity.js'
import { Sleep } from '../src/pages/Sleep.js'
import { Recovery } from '../src/pages/Recovery.js'
import { Health } from '../src/pages/Health.js'
import { Weight } from '../src/pages/Weight.js'
import { Nutrition } from '../src/pages/Nutrition.js'
import { Notes } from '../src/pages/Notes.js'
import { Settings } from '../src/pages/Settings.js'
import { WorkoutDetail } from '../src/pages/WorkoutDetail.js'
import { NightDetail } from '../src/pages/NightDetail.js'

describe('the navigation rail', () => {
  it('links to a real path rather than to a fragment, so a link can be opened in a new tab', () => {
    const html = renderToStaticMarkup(<Sidebar person="Robin" active="/sleep" onSignOut={() => {}} />)
    expect(html).toContain('href="/sleep"')
    expect(html).not.toContain('href="#sleep"')
  })

  it('marks the current page and only the current page', () => {
    const html = renderToStaticMarkup(<Sidebar person="Robin" active="/sleep" onSignOut={() => {}} />)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('shows the signed-in person rather than a hardcoded name', () => {
    expect(renderToStaticMarkup(<Sidebar person="Wilma" active="/" onSignOut={() => {}} />)).toContain('Wilma')
  })
})

describe('the route table', () => {
  // A parameterised route is by construction not a rail destination: the rail cannot link to
  // /activity/:sessionId without inventing a session id. So the comparison is against the routes
  // with no `:` segment, which is a rule rather than an exception list that would need editing
  // again the next time a detail page lands.
  it('agrees with the rail on exactly which unparameterised paths exist', () => {
    const railable = ROUTES.map((r) => r.path).filter((path) => !path.includes(':'))
    expect(new Set(RAIL_PATHS)).toEqual(new Set(railable))
  })

  // And the parameterised ones still mark a rail item, rather than leaving a reader on a page with
  // nothing in the rail highlighted: each names the rail path it belongs under.
  it('gives every parameterised route a rail path that the rail actually has', () => {
    for (const route of ROUTES.filter((r) => r.path.includes(':'))) {
      expect(RAIL_PATHS, route.path).toContain(route.rail)
    }
  })

  it('has an entry for every page the design names', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(
      ['/', '/activity', '/activity/:sessionId', '/health', '/notes', '/nutrition', '/recovery',
        '/settings', '/sleep', NIGHT_ROUTE, '/weight'].sort(),
    )
  })

  // The gap the two tests above cannot see: both compare path sets, and Shell.tsx renders
  // whichever `.element` a matched path carries (`active.element`) rather than looking a
  // component up by name, so a path pointing at the wrong component passes both of them and the
  // whole rest of this suite, which mounts each page directly by importing it rather than by
  // walking the route table. That is exactly how the rail linked to nowhere for as long as it
  // did: nothing here pinned path to component, only path to path.
  //
  // `.type`, not a render: every one of these pages needs a session, a query client and often a
  // route to render at all, and this test is only asking which component a path resolves to, not
  // whether that component itself works (its own page test already covers that). `<Weight />`'s
  // own `.type` is the `Weight` function reference, the exact value Shell.tsx's `active.element`
  // carries at runtime, so comparing it here is the same check Shell.tsx's own render makes.
  //
  // Every path, not just `/weight`: `/nutrition` used to be pinned to Dashboard on purpose
  // (routes.tsx's own old comment said so, since it had no page of its own yet), so leaving it
  // out would have made this test silently correct about eight of nine paths and asserted nothing
  // about the ninth, which is the same "wrote a map that looks complete but resolves nothing"
  // wound the M3e review found the last time a map like this stayed partial. `/nutrition` and
  // `/notes` both joined the resolved side across these two tasks, the same way `/weight` and
  // `/health` did in the tasks before them.
  it('resolves every path to the page component it names, not one that merely renders', () => {
    const byPath: Record<string, unknown> = {
      '/': Dashboard,
      '/activity': Activity,
      '/sleep': Sleep,
      '/recovery': Recovery,
      '/health': Health,
      '/weight': Weight,
      '/nutrition': Nutrition,
      '/notes': Notes,
      '/settings': Settings,
      '/activity/:sessionId': WorkoutDetail,
      [NIGHT_ROUTE]: NightDetail,
    }
    for (const route of ROUTES) {
      const element = route.element as { type: unknown }
      expect(element.type, route.path).toBe(byPath[route.path])
    }
  })
})
