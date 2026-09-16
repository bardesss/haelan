// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar, RAIL_PATHS } from '../src/components/Sidebar.js'

/**
 * Every row in the rail draws a glyph.
 *
 * Sidebar derives an icon name from the route (`item.path.slice(1)`) and `Icon` answers null for a
 * name it does not know, so a page added to GROUPS without a matching entry in icons.tsx renders
 * an item with no icon, silently - no warning, no placeholder, nothing in the console. That is how
 * /records shipped in #253.
 *
 * It matters most collapsed, which is why the second test exists: `label()` puts the link text in
 * an sr-only span there, so an item with no icon collapses to a visually empty clickable row. The
 * accessible name and the hover title both survive, so nothing but the eye notices.
 *
 * The assertion is on rendered rows rather than on a list of icon names, because the defect is
 * "this row draws nothing", not "this key is absent from a map" - a registry test would pass on a
 * row whose icon name was derived wrongly.
 */
function railItems(collapsed: boolean): Element[] {
  const host = document.createElement('div')
  // The rail reads its collapsed state at mount from storage, so the test sets that rather than
  // reaching for a prop that does not exist.
  if (collapsed) localStorage.setItem('haelan.rail.collapsed', 'true')
  else localStorage.removeItem('haelan.rail.collapsed')
  host.innerHTML = renderToStaticMarkup(
    <Sidebar person="Wilma" active="/" onSignOut={() => {}} />,
  )
  return Array.from(host.querySelectorAll('.rail-item'))
}

describe('the rail', () => {
  it('has a row for every path it links to', () => {
    // Guards the two tests below: if the rail rendered no rows at all they would pass vacuously.
    expect(railItems(false).length).toBeGreaterThanOrEqual(RAIL_PATHS.length)
  })

  it('draws an icon in every row', () => {
    for (const item of railItems(false)) {
      expect(item.querySelector('svg'), item.getAttribute('href') ?? item.textContent ?? '').not.toBeNull()
    }
  })

  it('leaves no row visually empty when collapsed', () => {
    for (const item of railItems(true)) {
      // Collapsed, the label is sr-only, so the glyph is the only thing a sighted reader gets.
      expect(item.querySelector('svg'), item.textContent ?? '').not.toBeNull()
    }
  })
})
