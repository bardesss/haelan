import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar } from '../src/components/Sidebar.js'
import { ROUTES } from '../src/routes.js'

describe('the navigation rail', () => {
  it('links to a real path rather than to a fragment, so a link can be opened in a new tab', () => {
    const html = renderToStaticMarkup(<Sidebar person="Bartus" active="/sleep" />)
    expect(html).toContain('href="/sleep"')
    expect(html).not.toContain('href="#sleep"')
  })

  it('marks the current page and only the current page', () => {
    const html = renderToStaticMarkup(<Sidebar person="Bartus" active="/sleep" />)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('shows the signed-in person rather than a hardcoded name', () => {
    expect(renderToStaticMarkup(<Sidebar person="Wilma" active="/" />)).toContain('Wilma')
  })
})

describe('the route table', () => {
  // Eight pages, and the rail is generated from the same table, so a page cannot exist without a
  // way to reach it or appear in the rail without existing.
  it('has an entry for every page the design names', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(
      ['/', '/activity', '/health', '/notes', '/nutrition', '/recovery', '/sleep', '/weight'].sort(),
    )
  })
})
