import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar, RAIL_PATHS } from '../src/components/Sidebar.js'
import { ROUTES } from '../src/routes.js'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Activity } from '../src/pages/Activity.js'
import { Sleep } from '../src/pages/Sleep.js'
import { Recovery } from '../src/pages/Recovery.js'
import { Health } from '../src/pages/Health.js'
import { Weight } from '../src/pages/Weight.js'
import { Notes } from '../src/pages/Notes.js'
import { Settings } from '../src/pages/Settings.js'

describe('the navigation rail', () => {
  it('links to a real path rather than to a fragment, so a link can be opened in a new tab', () => {
    const html = renderToStaticMarkup(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
    expect(html).toContain('href="/sleep"')
    expect(html).not.toContain('href="#sleep"')
  })

  it('marks the current page and only the current page', () => {
    const html = renderToStaticMarkup(<Sidebar person="Bartus" active="/sleep" onSignOut={() => {}} />)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('shows the signed-in person rather than a hardcoded name', () => {
    expect(renderToStaticMarkup(<Sidebar person="Wilma" active="/" onSignOut={() => {}} />)).toContain('Wilma')
  })
})

describe('the route table', () => {
  it('has an entry for every page the design names', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(
      ['/', '/activity', '/health', '/notes', '/nutrition', '/recovery', '/settings', '/sleep', '/weight'].sort(),
    )
  })

  // The rail's own list is a hand-written literal, not generated from ROUTES: nothing enforces
  // the two staying equal except this test. Without it, an edit to one could silently desync from
  // the other, leaving a route nothing links to or a rail item pointing nowhere.
  it('agrees with the rail on exactly which paths exist', () => {
    expect(new Set(RAIL_PATHS)).toEqual(new Set(ROUTES.map((r) => r.path)))
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
  // Every path, not just `/weight`: the one remaining placeholder path (`/nutrition`) is pinned to
  // Dashboard on purpose (routes.tsx's own comment), so leaving it out would have made this test
  // silently correct about eight of nine paths and asserted nothing about the ninth, which is the
  // same "wrote a map that looks complete but resolves nothing" wound the M3e review found the
  // last time a map like this stayed partial. `/notes` joined the resolved side this task, the
  // same way `/weight` and `/health` did in the tasks before it.
  it('resolves every path to the page component it names, not one that merely renders', () => {
    const byPath: Record<string, unknown> = {
      '/': Dashboard,
      '/activity': Activity,
      '/sleep': Sleep,
      '/recovery': Recovery,
      '/health': Health,
      '/weight': Weight,
      '/nutrition': Dashboard,
      '/notes': Notes,
      '/settings': Settings,
    }
    for (const route of ROUTES) {
      const element = route.element as { type: unknown }
      expect(element.type, route.path).toBe(byPath[route.path])
    }
  })
})
