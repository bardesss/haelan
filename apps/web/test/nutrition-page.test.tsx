import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Nutrition } from '../src/pages/Nutrition.js'
import { I18nProvider } from '../src/i18n/index.js'

/**
 * Nutrition reads nothing from a query or a route, unlike every other page's own test file: its
 * whole render is a translation lookup, so renderToStaticMarkup with only I18nProvider around it
 * is the entire harness this page needs, the same reason pages.test.tsx's own `pages` map renders
 * it this way rather than through settledPage (see that file's own comment on why).
 */
function render(lng: string): string {
  return renderToStaticMarkup(<I18nProvider lng={lng}><Nutrition /></I18nProvider>)
}

describe('the Nutrition page', () => {
  // The defect this whole task exists to fix: `/nutrition` used to render `<Dashboard />`, so a
  // reader clicking Voeding got the Dashboard's real numbers under a Dashboard heading. "Steps"
  // and "Sleep" are Dashboard tile labels that would leak through here if routes.tsx ever
  // regressed to handing Nutrition the wrong element, even though shell.test.tsx already pins the
  // route table itself; this pins what the component whose type that test checks actually draws.
  it('states that no food has been logged, not a Dashboard reading', () => {
    const html = render('en')
    expect(html).toContain('No food logged yet')
    expect(html).not.toContain('Steps')
    expect(html).not.toContain('Sleep')
  })

  // "No cards, no charts, no fabricated empty states for four metrics": the brief's own words for
  // what this page must not do. A metric page draws one role="img" chart host per metric and one
  // stat tile value per card; this page draws neither, and exactly the one Card holding the single
  // explanation, not one card per undefined macro.
  it('draws exactly one card and no chart, not one empty state per unspecified metric', () => {
    const html = render('en')
    expect(html).not.toMatch(/role="img"/)
    expect(html).not.toMatch(/class="value"/)
    expect([...html.matchAll(/<section class="card"/g)]).toHaveLength(1)
  })

  it('names the page in the heading', () => {
    const html = render('en')
    expect(html).toMatch(/<h1[^>]*>Nutrition<\/h1>/)
  })

  it('translates the explanation into Dutch too', () => {
    const html = render('nl')
    expect(html).toContain('Nog geen voeding gelogd')
    expect(html).toMatch(/<h1[^>]*>Voeding<\/h1>/)
    expect(html).not.toContain('No food logged yet')
  })
})
