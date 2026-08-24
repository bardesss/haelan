import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar, RAIL_PATHS } from '../src/components/Sidebar.js'
import { ROUTES } from '../src/routes.js'

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
      ['/', '/activity', '/health', '/notes', '/nutrition', '/recovery', '/sleep', '/weight'].sort(),
    )
  })

  // The rail's own list is a hand-written literal, not generated from ROUTES: nothing enforces
  // the two staying equal except this test. Without it, an edit to one could silently desync from
  // the other, leaving a route nothing links to or a rail item pointing nowhere.
  it('agrees with the rail on exactly which paths exist', () => {
    expect(new Set(RAIL_PATHS)).toEqual(new Set(ROUTES.map((r) => r.path)))
  })
})
