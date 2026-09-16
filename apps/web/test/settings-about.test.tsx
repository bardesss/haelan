import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { About, PROJECT_LINKS } from '../src/pages/settings/About.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { I18nProvider } from '../src/i18n/index.js'

/**
 * Where the project's own links live.
 *
 * They were three rows in the rail foot, permanently, between the pages a reader navigates and the
 * account line - and in the collapsed rail, three more unlabelled glyphs. They are not
 * destinations in this app at all: every one leaves for github.com, and a reader reaches for them
 * about as often as they reach for Settings. So they sit in Settings, where the other things a
 * person configures once already are.
 *
 * The reason for having them has not changed, and Sidebar.tsx stated it: a self-hosted tool has no
 * in-app feedback channel of its own, so these point straight at the project's home. That argues
 * for keeping them somewhere findable, which Settings is. It never argued for the rail.
 */
const render = (node: React.ReactNode, lng = 'en') =>
  renderToStaticMarkup(<I18nProvider lng={lng}>{node}</I18nProvider>)

describe('the project links', () => {
  it('names the three the project actually has', () => {
    expect(PROJECT_LINKS.map((link) => link.icon)).toEqual(['docs', 'changelog', 'issues'])
  })

  it('all leave for the project home, which is the whole point of them', () => {
    for (const link of PROJECT_LINKS) {
      expect(link.href, link.icon).toMatch(/^https:\/\/github\.com\/bardesss\/haelan/)
    }
  })

  it('opens each in a new tab without handing the target a window reference', () => {
    const html = render(<About />)
    // rel="noreferrer" on every external anchor: target="_blank" without it gives the opened page
    // a handle on this one through window.opener.
    const anchors = html.match(/<a [^>]*>/g) ?? []
    expect(anchors.length).toBe(PROJECT_LINKS.length)
    for (const anchor of anchors) {
      expect(anchor).toContain('target="_blank"')
      expect(anchor).toContain('rel="noreferrer"')
    }
  })

  it('renders a link per entry, in order', () => {
    const html = render(<About />)
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(PROJECT_LINKS.map((link) => link.href))
  })
})

describe('the rail, once the project links have left it', () => {
  it('links nowhere outside this app any more', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en">
        <Sidebar person="Wilma" active="/" onSignOut={() => {}} />
      </I18nProvider>,
    )
    expect(html).not.toContain('github.com')
  })
})
